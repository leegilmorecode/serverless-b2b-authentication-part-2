import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cr from "aws-cdk-lib/custom-resources";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as events from "aws-cdk-lib/aws-events";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodeLambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as path from "path";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as targets from "aws-cdk-lib/aws-events-targets";

import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";

import { Construct } from "constructs";
import { UserPool } from "aws-cdk-lib/aws-cognito";

interface CustomerStackProps extends cdk.StackProps {
  tiresApi: string;
  tiresApiKey: string;
  carOrdersClientId: string;
  carOrdersClientSecret: string;
  tireOrdersCognitoAuthUrl: string;
  orderTireScope: string;
}

export class CarCompanyStack extends Stack {
  constructor(scope: Construct, id: string, props?: CustomerStackProps) {
    super(scope, id, props);

    if (
      !props?.env?.account ||
      !props?.env?.region ||
      !props?.tiresApi ||
      !props?.tiresApiKey ||
      !props?.carOrdersClientId ||
      !props?.carOrdersClientSecret ||
      !props?.tireOrdersCognitoAuthUrl ||
      !props?.orderTireScope
    ) {
      throw new Error("props not fully supplied");
    }

    // create the vpc for the car company solution
    const vpc: ec2.Vpc = new ec2.Vpc(this, "CarOrdersVPC", {
      cidr: "10.0.0.0/16",
      maxAzs: 2, // for the demo only lets add 2 az's note: in production this should be at least 3
      natGateways: 1, // The nat gateway has to be provisioned in a public subnet, with a public ip address to access the internet through internet gateway
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "private-subnet",
          subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
        },
        {
          cidrMask: 24,
          name: "public-subnet",
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // ensure our flow logs go to cloudwatch
    vpc.addFlowLog("FlowLogS3", {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    // create the api for the car orders
    const ordersAPI: apigw.RestApi = new apigw.RestApi(this, "OrdersApi", {
      description: "orders api",
      restApiName: "orders-api",
      deploy: true,
      endpointTypes: [apigw.EndpointType.EDGE],
      // we use the default of edge optimised, which means we don't require a cloudfront distribution
      deployOptions: {
        stageName: "prod",
        dataTraceEnabled: true,
        loggingLevel: apigw.MethodLoggingLevel.INFO,
        tracingEnabled: true,
        metricsEnabled: true,
      },
    });

    // create the cognito user pool for auth
    const authUserPool: cognito.UserPool = new cognito.UserPool(
      this,
      "AuthUserPool",
      {
        userPoolName: "AuthUserPool", // "CarOrdersAuthUserPool",
        removalPolicy: RemovalPolicy.DESTROY,
      }
    );

    // create a user pool domain (this will allow the tires orders domain to request tokens from it)
    const carOrdersAuthUserPoolDomain: cognito.UserPoolDomain =
      new cognito.UserPoolDomain(this, "AuthUserPoolDomain", {
        userPool: authUserPool,
        cognitoDomain: {
          domainPrefix: "car-orders-auth-user-pool-domain",
        },
      });

    // create the scope which is required i.e. the tire domain can request scopes for hitting the tircare domain
    const completeCarTireOrderScope: cognito.ResourceServerScope =
      new cognito.ResourceServerScope({
        scopeName: "complete.order",
        scopeDescription: "complete the car order",
      });

    // create the resource server for the car order domain i.e. the car orders api which will be called
    // which has scopes which can be requested from a client i.e. the tires domain
    const carsDomainResourceServer: cognito.UserPoolResourceServer =
      authUserPool.addResourceServer("CarsDomainResourceServer", {
        userPoolResourceServerName: "CarsDomainResourceServer",
        identifier: "cars",
        scopes: [completeCarTireOrderScope],
      });

    // create the client for the tires orders domain i.e. the consumer of the cars domain
    const ordersDomainClient: cognito.UserPoolClient =
      new cognito.UserPoolClient(this, "TireOrdersDomainClient", {
        userPool: authUserPool,
        userPoolClientName: "TireOrdersDomainClient",
        preventUserExistenceErrors: true,
        refreshTokenValidity: Duration.minutes(60),
        accessTokenValidity: Duration.minutes(60),
        generateSecret: true,
        supportedIdentityProviders: [
          cognito.UserPoolClientIdentityProvider.COGNITO,
        ],
        oAuth: {
          flows: {
            clientCredentials: true,
          },
          scopes: [
            // it has the scopes assigned for hitting the car orders domain to complete a tire order
            cognito.OAuthScope.resourceServer(
              carsDomainResourceServer,
              completeCarTireOrderScope
            ),
          ],
        },
      });

    // access the user pool to get the arn
    const userPool: cognito.IUserPool = UserPool.fromUserPoolId(
      this,
      "UserPool",
      authUserPool.userPoolId
    );

    // add the cognito authorizer to our cars api which validates our tokens using cognito
    const cognitoAuthorizer = new apigw.CfnAuthorizer(
      this,
      "APIGatewayAuthorizer",
      {
        name: "customer-authorizer",
        identitySource: "method.request.header.Authorization",
        providerArns: [userPool.userPoolArn],
        restApiId: ordersAPI.restApiId,
        type: apigw.AuthorizationType.COGNITO,
      }
    );

    // create the ssm value for the storing of the generated access token
    const tokenParam: ssm.StringParameter = new ssm.StringParameter(
      this,
      "OrderStockToken",
      {
        parameterName: "/lambda/order-stock/token",
        stringValue: JSON.stringify({ token: "" }),
        description: "the access token for the order stock lambda",
        type: ssm.ParameterType.STRING,
        tier: ssm.ParameterTier.STANDARD,
      }
    );

    // create the orders table for storing the car orders
    const ordersTable: dynamodb.Table = new dynamodb.Table(
      this,
      "CarOrdersTable",
      {
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        encryption: dynamodb.TableEncryption.AWS_MANAGED,
        pointInTimeRecovery: true, // we add point in time recovery for our table
        tableName: "CarOrders",
        contributorInsightsEnabled: true,
        removalPolicy: RemovalPolicy.DESTROY,
        partitionKey: {
          name: "id",
          type: dynamodb.AttributeType.STRING,
        },
      }
    );

    const ordersStockEnvVars = {
      SSM_ORDER_STOCK_TOKEN_PARAM: tokenParam.parameterName,
      TABLE: ordersTable.tableName,
      TIRES_API: props.tiresApi,
      TIRES_API_KEY: props.tiresApiKey,
    };

    // create the lambda handler to order stock
    const orderStockHandler: nodeLambda.NodejsFunction =
      new nodeLambda.NodejsFunction(this, "OrderStockHandler", {
        functionName: "order-stock-handler",
        runtime: lambda.Runtime.NODEJS_14_X,
        entry: path.join(__dirname, "/../src/order-stock/order-stock.ts"),
        memorySize: 1024,
        handler: "orderStockHandler",
        vpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_NAT, // place the lambda in the private subnet
        },
        bundling: {
          minify: true,
          externalModules: ["aws-sdk"],
        },
        environment: {
          ...ordersStockEnvVars,
        },
      });

    // Lambda to generate a token on a CRON and push to ssm
    const generateTokenHandler: nodeLambda.NodejsFunction =
      new nodeLambda.NodejsFunction(this, "GenerateTokenHandler", {
        functionName: "generate-token-handler",
        runtime: lambda.Runtime.NODEJS_14_X,
        entry: path.join(
          __dirname,
          "/../src/generate-token-cron/generate-token-cron.ts"
        ),
        memorySize: 1024,
        handler: "generateTokenHandler",
        bundling: {
          minify: true,
          externalModules: ["aws-sdk"],
        },
        environment: {
          SSM_ORDER_STOCK_TOKEN_PARAM: tokenParam.parameterName,
          ORDER_STOCK_SCOPE: props.orderTireScope,
          AUTH_URL: props.tireOrdersCognitoAuthUrl,
          CAR_ORDERS_CLIENT_ID: props.carOrdersClientId,
          CAR_ORDERS_CLIENT_SECRET: props.carOrdersClientSecret,
        },
      });

    // ensure there is a rule to run the lambda every hour for generating the new access token
    const generateTokenRule = new events.Rule(this, "GenerateTokenRule", {
      schedule: events.Schedule.rate(Duration.minutes(10)),
    });

    generateTokenRule.addTarget(
      new targets.LambdaFunction(generateTokenHandler)
    );

    // allow the lambda to read the parameter from ssm
    tokenParam.grantRead(orderStockHandler);

    // allow the token generation lambda to write the token to ssm
    tokenParam.grantWrite(generateTokenHandler);

    // create the lambda handler for the webhook i.e. order complete (patch)
    const orderConfirmedWebhookHandler: nodeLambda.NodejsFunction =
      new nodeLambda.NodejsFunction(this, "OrderConfirmedWebhookHandler", {
        functionName: "order-confirmed-webhook-handler",
        runtime: lambda.Runtime.NODEJS_14_X,
        entry: path.join(
          __dirname,
          "/../src/order-confirmed-webhook/order-confirmed-webhook.ts"
        ),
        memorySize: 1024,
        handler: "orderConfirmedWebhookHandler",
        vpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_NAT, // place the lambda in the private subnet
        },
        bundling: {
          minify: true,
          externalModules: ["aws-sdk"],
        },
        environment: {
          SSM_ORDER_STOCK_TOKEN_PARAM: tokenParam.parameterName,
          TABLE: ordersTable.tableName,
          TIRES_API: props.tiresApi,
        },
      });

    // allow the lambdas to write to the table
    ordersTable.grantWriteData(orderConfirmedWebhookHandler);
    ordersTable.grantWriteData(orderStockHandler);

    const orders: apigw.Resource = ordersAPI.root.addResource("orders");

    // add the endpoint for creating an order (post) on /orders/
    orders.addMethod(
      "POST",
      new apigw.LambdaIntegration(orderStockHandler, {
        proxy: true,
        allowTestInvoke: true,
      })
    );

    // add the endpoint for updating the order to state it is complete i.e. (patch) on /orders/item
    const item: apigw.Resource = orders.addResource("{item}");
    item.addMethod(
      "PATCH",
      new apigw.LambdaIntegration(orderConfirmedWebhookHandler, {
        proxy: true,
        allowTestInvoke: true,
      }),
      {
        authorizationType: apigw.AuthorizationType.COGNITO,
        apiKeyRequired: false, // we are not using an api key for this integration
        authorizer: { authorizerId: cognitoAuthorizer.ref }, // the cognito authoriser will ensure we have a token
        authorizationScopes: [`cars/${completeCarTireOrderScope.scopeName}`], // ensure the token has the correct scope
      }
    );

    // Note: circular dependency fix for api url passed into the lambda integration as env var
    new cr.AwsCustomResource(this, "UpdateEnvVars", {
      onCreate: {
        service: "Lambda",
        action: "updateFunctionConfiguration",
        parameters: {
          FunctionName: orderStockHandler.functionArn,
          Environment: {
            Variables: {
              CAR_API: ordersAPI.url,
              ...ordersStockEnvVars, // ensure we pass through all required
            },
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of("OrdersApi"),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [orderStockHandler.functionArn],
      }),
    });

    // get the elastic ips (nat gateways) associated with the vpc
    const eips = vpc.publicSubnets.map(
      (subnet) =>
        (subnet as ec2.PublicSubnet).node.children.find(
          (x) => x instanceof ec2.CfnEIP
        ) as ec2.CfnEIP
    );

    new CfnOutput(this, "ordersAPI", {
      value: `${ordersAPI.url}orders`,
      description: "The orders API",
      exportName: "ordersAPI",
    });

    new CfnOutput(this, "NatGatewayEIP", {
      value: eips[0].ref,
      description: "The Nat Gateway EIP",
      exportName: "NatGatewayEIP",
    });

    new CfnOutput(this, "tiresOrderClientId", {
      value: ordersDomainClient.userPoolClientId,
      description: "The tires orders client ID",
      exportName: "tireOrdersClientId",
    });

    new CfnOutput(this, "carOrdersCognitoAuthUrl", {
      value: `https://${carOrdersAuthUserPoolDomain.domainName}.auth.${process.env.CDK_DEFAULT_REGION}.amazoncognito.com`,
      description: "The Cognito user pool auth url for the cars domain",
      exportName: "carOrdersCognitoAuthUrl",
    });
  }
}

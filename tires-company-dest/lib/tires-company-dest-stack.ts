import * as events from "aws-cdk-lib/aws-events";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as targets from "aws-cdk-lib/aws-events-targets";

import {
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  StackProps,
} from "aws-cdk-lib";

import { Construct } from "constructs";

interface TiresCompanyDestStackProps extends StackProps {
  carOrdersApi: string;
  carOrdersCognitoAuthUrl: string;
  tiresOrderClientId: string;
  tiresOrderClientSecret: string;
}

export class TiresCompanyDestStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props?: TiresCompanyDestStackProps
  ) {
    super(scope, id, props);

    if (
      !props?.carOrdersApi ||
      !props?.carOrdersCognitoAuthUrl ||
      !props?.tiresOrderClientId
    ) {
      throw new Error("missing props");
    }

    // get the tires orders event bus from the other tires stack
    const ordersEventBus = events.EventBus.fromEventBusName(
      this,
      "orders-event-bus",
      "orders-event-bus"
    );

    // oath properties for our connection
    const oAuthAuthorizationProps: events.OAuthAuthorizationProps = {
      authorizationEndpoint: `${props.carOrdersCognitoAuthUrl}/oauth2/token`,
      clientId: props.tiresOrderClientId,
      // Note: this is for the demo only, and we chould never hard code these secret values
      clientSecret: SecretValue.unsafePlainText(props.tiresOrderClientSecret),
      httpMethod: events.HttpMethod.POST,
      bodyParameters: {
        grant_type: events.HttpParameter.fromString("client_credentials"),
      },
      headerParameters: {},
      queryStringParameters: {},
    };

    // create the car orders connection for the api destination
    const carOrdersConnection: events.Connection = new events.Connection(
      this,
      "CarOrdersDestinationsConnection",
      {
        authorization: events.Authorization.oauth(oAuthAuthorizationProps),
        description: "Car Orders API Destination Connection",
        connectionName: "CarOrdersDestinationsConnection",
      }
    );

    // create the api destination for the car orders connection
    const carOrdersDestination: events.ApiDestination =
      new events.ApiDestination(this, "CarOrdersAPIDestination", {
        connection: carOrdersConnection,
        endpoint: `${props.carOrdersApi}/*`, // the '*' placeholder is replaced with the id using the target
        description: "The api destination for our car orders api",
        rateLimitPerSecond: 50, // this allows us to limit the requests we sent to the orders api
        httpMethod: events.HttpMethod.PATCH,
        apiDestinationName: "CarOrdersDestination",
      });

    carOrdersDestination.node.addDependency(carOrdersConnection);

    // create the target rule for the api destination
    const rule = new events.Rule(this, "CarOrdersApiDestinationsRule", {
      eventBus: ordersEventBus,
      ruleName: "CarOrdersApiDestinationsRule",
      description: "Rule for Orders API Destination",
      eventPattern: {
        source: ["complete-order"],
        detailType: ["OrderCompleted"], // we ensure only these events are matched
      },
      targets: [
        new targets.ApiDestination(carOrdersDestination, {
          retryAttempts: 10,
          pathParameterValues: ["$.detail.carOrderId"], // we want to pass the carOrderId as the /orders/* param
          event: events.RuleTargetInput.fromEventPath("$.detail"), // we only want to pass the http body as the detail
          headerParameters: {},
          queryStringParameters: {},
          maxEventAge: Duration.minutes(60),
          deadLetterQueue: new sqs.Queue(this, "car-orders-api-dlq", {
            removalPolicy: RemovalPolicy.DESTROY,
            queueName: "car-orders-api-dlq", // we ensure any failures go to a dead letter queue
          }),
        }),
      ],
    });

    rule.node.addDependency(carOrdersDestination);
  }
}

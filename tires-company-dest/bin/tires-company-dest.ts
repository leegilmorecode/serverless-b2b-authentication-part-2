#!/usr/bin/env node

import "source-map-support/register";

import * as cdk from "aws-cdk-lib";

import { TiresCompanyDestStack } from "../lib/tires-company-dest-stack";

interface TiresCompanyDestStackProps extends cdk.StackProps {
  carOrdersApi: string;
  carOrdersCognitoAuthUrl: string;
  tiresOrderClientId: string;
  tiresOrderClientSecret: string;
}

const stackProps: TiresCompanyDestStackProps = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  // this is the car orders api url which api destinations will call to complete the car order
  // i.e. the ordersAPI property in ./car-company/cdk-outputs.json
  carOrdersApi: "https://xxx.execute-api.eu-west-1.amazonaws.com/prod/orders",
  // this is the car orders cognito auth url from ./car-company/cdk-outputs.json
  // which allows our Tires domain to request an access token to complete the order
  carOrdersCognitoAuthUrl:
    "https://car-orders-auth-user-pool-domain.auth.eu-west-1.amazoncognito.com",
  // this is the tire orders client id from ./car-company/cdk-outputs.json
  tiresOrderClientId: "xxx",
  // this is the tire orders secret id from ./car-company/cdk-outputs.json
  tiresOrderClientSecret: "xxx",
};

const app = new cdk.App();
new TiresCompanyDestStack(app, "TiresCompanyDestStack", stackProps);

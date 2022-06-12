#!/usr/bin/env node

import "source-map-support/register";

import * as cdk from "aws-cdk-lib";

import { TiresCompanyStack } from "../lib/tires-company-stack";

interface TiresCompanyStackProps extends cdk.StackProps {
  ordersApiIp: string;
}

// pass these through from the tires stack - these are example placeholders only
const stackProps: TiresCompanyStackProps = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  // this is the natgateway elastic ip address from the car orders domain
  // i.e. the NatGatewayEIP property in ./car-company/cdk-outputs.json
  ordersApiIp: "xx.xx.xx.xxx",
};

const app = new cdk.App();
new TiresCompanyStack(app, "TiresCompanyStack", stackProps);

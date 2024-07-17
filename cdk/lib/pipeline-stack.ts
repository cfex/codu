import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import { AppStage } from "./app-stage";
import {
  BuildEnvironmentVariableType,
  LocalCacheMode,
} from "aws-cdk-lib/aws-codebuild";
import {
  Effect,
  PolicyStatement,
  Role,
  ServicePrincipal,
  AccountPrincipal,
} from "aws-cdk-lib/aws-iam";
import { Cache } from "aws-cdk-lib/aws-codebuild";

import {
  CodePipeline,
  CodePipelineSource,
  ShellStep,
} from "aws-cdk-lib/pipelines";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as codebuild from "aws-cdk-lib/aws-codebuild";

export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const codeBuildRole = new Role(this, "CodeBuildRole", {
      assumedBy: new ServicePrincipal("codebuild.amazonaws.com"),
      description: "Role for CodeBuild to access SSM parameters",
    });

    codeBuildRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: ["*"],
      }),
    );

    const synthAction = new ShellStep("Synth", {
      input: CodePipelineSource.gitHub("codu-code/codu", "develop"),
      commands: ["cd cdk", "npm ci", "npm run build", "npx cdk synth"],
      primaryOutputDirectory: "cdk/cdk.out",
    });

    const pipeline = new CodePipeline(this, "Pipeline", {
      pipelineName: "codu-pipline",
      crossAccountKeys: true,
      synth: synthAction,
      codeBuildDefaults: {
        cache: Cache.local(LocalCacheMode.DOCKER_LAYER),
        buildEnvironment: {
          computeType: codebuild.ComputeType.MEDIUM,
          privileged: true,
          environmentVariables: {
            DOCKER_BUILDKIT: {
              value: "1",
            },
            SENTRY_AUTH_TOKEN: {
              type: BuildEnvironmentVariableType.PARAMETER_STORE,
              value: "sentry",
            },
            DATABASE_URL: {
              type: BuildEnvironmentVariableType.PARAMETER_STORE,
              value: "/prod/db/url",
            },
          },
        },
      },
    });

    const devAccountId = ssm.StringParameter.valueFromLookup(
      this,
      `/env/dev/accountId`,
    );

    const prodAccountId = ssm.StringParameter.valueFromLookup(
      this,
      `/env/prod/accountId`,
    );

    const hostedZoneId = ssm.StringParameter.valueFromLookup(
      this,
      `/env/hostedZoneId`,
    );

    const domainName = ssm.StringParameter.valueFromLookup(
      this,
      `/env/domainName`,
    );

    const crossAccountRole = new Role(this, "CrossAccountDNSRole", {
      assumedBy: new cdk.aws_iam.AccountPrincipal(this.account), // This account
      roleName: "CrossAccountDNSRole",
      description: "Role for cross-account DNS management",
    });

    const assumeRolePolicy =
      crossAccountRole.assumeRolePolicy as cdk.aws_iam.PolicyDocument;
    assumeRolePolicy.addStatements(
      new cdk.aws_iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        effect: cdk.aws_iam.Effect.ALLOW,
        principals: [
          new cdk.aws_iam.AccountPrincipal(devAccountId),
          new cdk.aws_iam.AccountPrincipal(prodAccountId),
        ],
      }),
    );

    crossAccountRole.addToPolicy(
      new PolicyStatement({
        actions: [
          "route53:ChangeResourceRecordSets",
          "route53:ListHostedZones",
          "route53:ListResourceRecordSets",
        ],
        resources: [`arn:aws:route53:::hostedzone/${hostedZoneId}`],
      }),
    );

    new cdk.CfnOutput(this, "CrossAccountRoleArn", {
      value: crossAccountRole.roleArn,
      exportName: "CrossAccountDNSRoleArn",
    });

    new cdk.CfnOutput(this, "HostedZoneId", {
      value: hostedZoneId,
      exportName: "HostedZoneId",
    });

    new cdk.CfnOutput(this, "DomainName", {
      value: domainName,
      exportName: "DomainName",
    });

    const defaultRegion = "eu-west-1";

    const dev = new AppStage(this, "Dev", {
      env: {
        account: devAccountId,
        region: defaultRegion,
      },
    });

    const prod = new AppStage(this, "Prod", {
      env: {
        account: prodAccountId,
        region: defaultRegion,
      },
      production: true,
    });

    pipeline.addStage(dev, {
      pre: [new cdk.pipelines.ManualApprovalStep("Deploy to develop")],
    });
    pipeline.addStage(prod, {
      pre: [new cdk.pipelines.ManualApprovalStep("Deploy to production")],
    });
  }
}

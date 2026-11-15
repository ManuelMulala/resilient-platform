#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CoreStack } from '../lib/core-stack';
import { AppStack } from '../lib/app-stack';

const app = new cdk.App();
const env = { account: '586481704498', region: 'eu-west-1' };

// Deployed in two steps: Core first, then the first images are pushed, then App
const core = new CoreStack(app, 'ResilientCore', {
  env,
  description: 'Resilient platform: VPC (2 AZs), ECR, RDS Multi-AZ, ElastiCache Redis, SQS, AWS Backup',
});
new AppStack(app, 'ResilientApp', {
  env,
  core,
  description: 'Resilient platform: ECS Fargate web + worker, ALB, auto scaling, Route 53 failover, CodePipeline',
});

cdk.Tags.of(app).add('Project', 'resilient-platform');

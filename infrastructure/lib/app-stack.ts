import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import { CoreStack } from './core-stack';

export interface AppStackProps extends cdk.StackProps {
  core: CoreStack;
}

// S3 website endpoint hosted zone ID for eu-west-1 (fixed AWS value, used for the Route 53 alias)
const S3_WEBSITE_ZONE_IDS: Record<string, string> = { 'eu-west-1': 'Z1BKCTXD74EZPE' };

const ERROR_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>We'll be right back</title></head>
<body style="font-family:sans-serif;background:#f4f4f4;color:#333;text-align:center;padding:60px">
<h1>We'll be right back</h1>
<p>Our shop is temporarily unavailable while we restore service.</p>
<p>Your orders are safe. Please try again in a few minutes.</p>
<p style="color:#999;font-size:12px">Served from the S3 failover site (Route 53 SECONDARY record)</p>
</body></html>`;

/**
 * ResilientApp: ECS cluster, ALB, web + worker Fargate services with auto scaling,
 * Route 53 DNS failover to an S3 error page, and the CodePipeline that updates the services.
 */
export class AppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { core } = props;

    const zoneName: string = this.node.tryGetContext('zoneName') ?? 'capstone-emmanuel.com';
    const recordName: string = this.node.tryGetContext('recordName') ?? `shop.${zoneName}`;
    const repo: string = this.node.tryGetContext('repo') ?? 'ManuelMulala/resilient-platform';
    const connectionArn: string | undefined = this.node.tryGetContext('connectionArn');
    if (!connectionArn) throw new Error('Set "connectionArn" in the context section of cdk.json');
    const [owner, repoName] = repo.split('/');

    // ---------- Cluster and load balancer ----------
    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: 'resilient-platform',
      vpc: core.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED, // task-count metrics for the scaling proof
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: core.vpc,
      internetFacing: true,
      securityGroup: core.albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }, // one public subnet per AZ
    });
    const listener = alb.addListener('Http', { port: 80, open: false }); // ingress already defined on albSg

    // ---------- Shared container configuration ----------
    const dbSecret = core.db.secret!;
    const commonEnv = {
      DB_HOST: core.db.dbInstanceEndpointAddress,
      DB_NAME: 'shop',
      QUEUE_URL: core.queue.queueUrl,
      AWS_REGION: this.region,
    };
    const dbSecrets = {
      DB_USER: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
    };
    const logGroup = (name: string) => new logs.LogGroup(this, `${name}Logs`, {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const taskNetworking = {
      cluster,
      assignPublicIp: true, // no NAT gateway: public IP to reach ECR, SQS and Secrets Manager
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [core.tasksSg],
      minHealthyPercent: 100, // rolling update never drops below desired capacity
      maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true }, // failed deployments roll back automatically
    };

    // ---------- Web service (behind the ALB) ----------
    const webTask = new ecs.FargateTaskDefinition(this, 'WebTask', { cpu: 256, memoryLimitMiB: 512 });
    webTask.addContainer('web', {
      containerName: 'web', // must match imagedefinitions-web.json
      image: ecs.ContainerImage.fromEcrRepository(core.webRepo, 'latest'),
      portMappings: [{ containerPort: 3000 }],
      environment: { ...commonEnv, REDIS_HOST: core.redisHost },
      secrets: dbSecrets,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'web', logGroup: logGroup('Web') }),
    });
    core.queue.grantSendMessages(webTask.taskRole);

    const webService = new ecs.FargateService(this, 'WebService', {
      ...taskNetworking,
      serviceName: 'shop-web',
      taskDefinition: webTask,
      desiredCount: 2, // one task per AZ
      healthCheckGracePeriod: cdk.Duration.seconds(60),
    });

    const webTargets = listener.addTargets('Web', {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [webService],
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(15),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    const webScaling = webService.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 6 });
    webScaling.scaleOnCpuUtilization('WebCpu', {
      targetUtilizationPercent: 60,
      scaleOutCooldown: cdk.Duration.seconds(60),
      scaleInCooldown: cdk.Duration.seconds(120),
    });
    webScaling.scaleOnRequestCount('WebRequests', {
      requestsPerTarget: 300,
      targetGroup: webTargets,
      scaleOutCooldown: cdk.Duration.seconds(60),
      scaleInCooldown: cdk.Duration.seconds(120),
    });

    // ---------- Worker service (polls SQS) ----------
    const workerTask = new ecs.FargateTaskDefinition(this, 'WorkerTask', { cpu: 256, memoryLimitMiB: 512 });
    workerTask.addContainer('worker', {
      containerName: 'worker', // must match imagedefinitions-worker.json
      image: ecs.ContainerImage.fromEcrRepository(core.workerRepo, 'latest'),
      environment: { ...commonEnv, WORK_MS: '500' },
      secrets: dbSecrets,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'worker', logGroup: logGroup('Worker') }),
    });
    core.queue.grantConsumeMessages(workerTask.taskRole);

    const workerService = new ecs.FargateService(this, 'WorkerService', {
      ...taskNetworking,
      serviceName: 'shop-worker',
      taskDefinition: workerTask,
      desiredCount: 1,
    });

    // Target tracking on queue depth: desired tasks ~= visible messages / 100 (min 1, max 5)
    const workerScaling = workerService.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 5 });
    workerScaling.scaleToTrackCustomMetric('QueueDepth', {
      metric: core.queue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Average',
      }),
      targetValue: 100,
      scaleOutCooldown: cdk.Duration.seconds(60),
      scaleInCooldown: cdk.Duration.seconds(120),
    });

    // ---------- DR: S3 static error page + Route 53 failover ----------
    // Bucket name must equal the record name for a Route 53 alias to an S3 website
    const errorBucket = new s3.Bucket(this, 'ErrorPageBucket', {
      bucketName: recordName,
      websiteIndexDocument: 'index.html',
      publicReadAccess: true,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: false, restrictPublicBuckets: false,
      }),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    new s3deploy.BucketDeployment(this, 'ErrorPage', {
      destinationBucket: errorBucket,
      sources: [s3deploy.Source.data('index.html', ERROR_PAGE)],
    });

    const zone = new route53.PublicHostedZone(this, 'Zone', { zoneName });

    const healthCheck = new route53.CfnHealthCheck(this, 'AlbHealthCheck', {
      healthCheckConfig: {
        type: 'HTTP',
        fullyQualifiedDomainName: alb.loadBalancerDnsName,
        port: 80,
        resourcePath: '/health',
        requestInterval: 10,
        failureThreshold: 2,
      },
      healthCheckTags: [{ key: 'Name', value: 'shop-alb-health' }],
    });

    new route53.CfnRecordSet(this, 'PrimaryRecord', {
      hostedZoneId: zone.hostedZoneId,
      name: recordName,
      type: 'A',
      setIdentifier: 'primary-alb',
      failover: 'PRIMARY',
      healthCheckId: healthCheck.attrHealthCheckId,
      aliasTarget: {
        dnsName: alb.loadBalancerDnsName,
        hostedZoneId: alb.loadBalancerCanonicalHostedZoneId,
        evaluateTargetHealth: true,
      },
    });

    new route53.CfnRecordSet(this, 'SecondaryRecord', {
      hostedZoneId: zone.hostedZoneId,
      name: recordName,
      type: 'A',
      setIdentifier: 'secondary-s3',
      failover: 'SECONDARY',
      aliasTarget: {
        dnsName: `s3-website-${this.region}.amazonaws.com`,
        hostedZoneId: S3_WEBSITE_ZONE_IDS[this.region],
        evaluateTargetHealth: false,
      },
    });

    // ---------- CI/CD: GitHub -> CodeBuild (2 images) -> ECS rolling updates ----------
    const artifactBucket = new s3.Bucket(this, 'PipelineArtifacts', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const imageBuild = new codebuild.PipelineProject(this, 'ImageBuild', {
      projectName: 'resilient-platform-images',
      buildSpec: codebuild.BuildSpec.fromSourceFilename('pipeline/buildspec.yml'),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true, // required for docker build
      },
      environmentVariables: {
        WEB_REPO_URI: { value: core.webRepo.repositoryUri },
        WORKER_REPO_URI: { value: core.workerRepo.repositoryUri },
      },
      logging: { cloudWatch: { logGroup: logGroup('Build') } },
    });
    core.webRepo.grantPullPush(imageBuild);
    core.workerRepo.grantPullPush(imageBuild);

    const sourceOutput = new codepipeline.Artifact('Source');
    const buildOutput = new codepipeline.Artifact('ImageDefinitions');

    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'resilient-platform',
      pipelineType: codepipeline.PipelineType.V2,
      artifactBucket,
      stages: [
        {
          stageName: 'Source',
          actions: [new actions.CodeStarConnectionsSourceAction({
            actionName: 'GitHub', owner, repo: repoName, branch: 'main', connectionArn, output: sourceOutput,
          })],
        },
        {
          stageName: 'Build',
          actions: [new actions.CodeBuildAction({
            actionName: 'BuildAndPushImages', project: imageBuild, input: sourceOutput, outputs: [buildOutput],
          })],
        },
        {
          stageName: 'Deploy',
          actions: [
            new actions.EcsDeployAction({
              actionName: 'RollingUpdateWeb', service: webService,
              imageFile: buildOutput.atPath('imagedefinitions-web.json'),
              deploymentTimeout: cdk.Duration.minutes(20),
            }),
            new actions.EcsDeployAction({
              actionName: 'RollingUpdateWorker', service: workerService,
              imageFile: buildOutput.atPath('imagedefinitions-worker.json'),
              deploymentTimeout: cdk.Duration.minutes(20),
            }),
          ],
        },
      ],
    });

    // ---------- Outputs ----------
    new cdk.CfnOutput(this, 'AlbUrl', { value: `http://${alb.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, 'ShopRecord', { value: recordName });
    new cdk.CfnOutput(this, 'NameServers', { value: cdk.Fn.join(' ', zone.hostedZoneNameServers!) });
    new cdk.CfnOutput(this, 'HostedZoneId', { value: zone.hostedZoneId });
    new cdk.CfnOutput(this, 'HealthCheckId', { value: healthCheck.attrHealthCheckId });
    new cdk.CfnOutput(this, 'ErrorPageUrl', { value: errorBucket.bucketWebsiteUrl });
    new cdk.CfnOutput(this, 'PipelineName', { value: pipeline.pipelineName });
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
  }
}

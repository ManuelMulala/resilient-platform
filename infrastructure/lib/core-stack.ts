import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as events from 'aws-cdk-lib/aws-events';

/**
 * ResilientCore: networking, security groups, image registries and the data layer.
 * Everything here exists before any container runs.
 */
export class CoreStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly albSg: ec2.SecurityGroup;
  public readonly tasksSg: ec2.SecurityGroup;
  public readonly webRepo: ecr.Repository;
  public readonly workerRepo: ecr.Repository;
  public readonly db: rds.DatabaseInstance;
  public readonly redisHost: string;
  public readonly queue: sqs.Queue;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC across 2 AZs. No NAT gateway (cost): tasks run in public subnets with public IPs,
    // data stores live in isolated subnets with no internet route.
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      // Explicit AZs: no AWS lookup during synth, deterministic template
      availabilityZones: [`${this.region}a`, `${this.region}b`],
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // Security groups: internet -> ALB:80 -> tasks:3000 -> RDS:3306 / Redis:6379
    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', { vpc: this.vpc, description: 'ALB - HTTP from the internet' });
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from internet');

    this.tasksSg = new ec2.SecurityGroup(this, 'TasksSg', { vpc: this.vpc, description: 'Fargate tasks - app port from ALB only' });
    this.tasksSg.addIngressRule(this.albSg, ec2.Port.tcp(3000), 'App port from ALB');

    const dbSg = new ec2.SecurityGroup(this, 'DbSg', { vpc: this.vpc, description: 'RDS - MySQL from tasks only', allowAllOutbound: false });
    dbSg.addIngressRule(this.tasksSg, ec2.Port.tcp(3306), 'MySQL from tasks');

    const cacheSg = new ec2.SecurityGroup(this, 'CacheSg', { vpc: this.vpc, description: 'Redis - from tasks only', allowAllOutbound: false });
    cacheSg.addIngressRule(this.tasksSg, ec2.Port.tcp(6379), 'Redis from tasks');

    // ECR repositories for the two images built by CodeBuild
    const repoProps = {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [{ maxImageCount: 10, description: 'Keep the last 10 images' }],
    };
    this.webRepo = new ecr.Repository(this, 'WebRepo', { repositoryName: 'shop-web', ...repoProps });
    this.workerRepo = new ecr.Repository(this, 'WorkerRepo', { repositoryName: 'shop-worker', ...repoProps });

    // RDS MySQL Multi-AZ: synchronous standby in the second AZ, automatic failover
    this.db = new rds.DatabaseInstance(this, 'Database', {
      // MySQL 8.4 LTS (8.0 left standard support in July 2026 and would incur Extended Support charges)
      engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.of('8.4.7', '8.4') }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MICRO),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      multiAz: true,
      credentials: rds.Credentials.fromGeneratedSecret('shopadmin'), // password in Secrets Manager
      databaseName: 'shop',
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(1),
      deleteAutomatedBackups: true,
      deletionProtection: false, // lab only: allows clean teardown
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ElastiCache Redis: primary + replica in different AZs with automatic failover
    const cacheSubnets = new elasticache.CfnSubnetGroup(this, 'CacheSubnets', {
      description: 'Isolated subnets for Redis',
      subnetIds: this.vpc.isolatedSubnets.map((s) => s.subnetId),
    });
    const redis = new elasticache.CfnReplicationGroup(this, 'Redis', {
      replicationGroupDescription: 'Product cache (Multi-AZ, automatic failover)',
      engine: 'redis',
      engineVersion: '7.1',
      cacheNodeType: 'cache.t4g.micro',
      numCacheClusters: 2,
      automaticFailoverEnabled: true,
      multiAzEnabled: true,
      cacheSubnetGroupName: cacheSubnets.ref,
      securityGroupIds: [cacheSg.securityGroupId],
    });
    redis.node.addDependency(cacheSubnets);
    this.redisHost = redis.attrPrimaryEndPointAddress;

    // SQS: orders queue with a dead-letter queue for messages that fail 3 times
    const dlq = new sqs.Queue(this, 'OrdersDlq', { queueName: 'orders-dlq', retentionPeriod: cdk.Duration.days(14) });
    this.queue = new sqs.Queue(this, 'OrdersQueue', {
      queueName: 'orders',
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    // AWS Backup: daily RDS snapshot at 02:00 UTC (05:00 EAT), kept 7 days
    const vault = new backup.BackupVault(this, 'Vault', {
      backupVaultName: 'resilient-platform-vault',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const plan = new backup.BackupPlan(this, 'DailyPlan', { backupPlanName: 'resilient-platform-daily', backupVault: vault });
    plan.addRule(new backup.BackupPlanRule({
      ruleName: 'DailyRdsSnapshot',
      scheduleExpression: events.Schedule.cron({ hour: '2', minute: '0' }),
      startWindow: cdk.Duration.hours(1),
      completionWindow: cdk.Duration.hours(3),
      deleteAfter: cdk.Duration.days(7),
    }));
    plan.addSelection('RdsSelection', {
      resources: [backup.BackupResource.fromRdsDatabaseInstance(this.db)],
      allowRestores: true,
    });

    new cdk.CfnOutput(this, 'DbEndpoint', { value: this.db.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'DbIdentifier', { value: this.db.instanceIdentifier });
    new cdk.CfnOutput(this, 'RedisEndpoint', { value: this.redisHost });
    new cdk.CfnOutput(this, 'QueueUrl', { value: this.queue.queueUrl });
    new cdk.CfnOutput(this, 'WebRepoUri', { value: this.webRepo.repositoryUri });
    new cdk.CfnOutput(this, 'WorkerRepoUri', { value: this.workerRepo.repositoryUri });
    new cdk.CfnOutput(this, 'BackupPlanId', { value: plan.backupPlanId });
  }
}

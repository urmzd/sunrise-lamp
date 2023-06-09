import * as cdk from "aws-cdk-lib";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Construct } from "constructs";
import * as path from "node:path";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";

const MQTT_PORT = 1883;
const WS_PORT = 9001;
const HC_PORT = 8081;

export class SunriseLampStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "VPC", {
      maxAzs: 2,
      ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/24"),
      subnetConfiguration: [
        {
          cidrMask: 26,
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          name: "Private",
        },
      ],
    });

    vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [
        {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    vpc.addInterfaceEndpoint("SecretsManagerEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      privateDnsEnabled: true,
      subnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        onePerAz: true,
      }),
    });

    vpc.addInterfaceEndpoint("KmsEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.KMS,
      privateDnsEnabled: true,
      subnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        onePerAz: true,
      }),
    });

    vpc.addInterfaceEndpoint("ECREndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      privateDnsEnabled: true,
      subnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        onePerAz: true,
      }),
    });

    vpc.addInterfaceEndpoint("ECRDockerEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      privateDnsEnabled: true,
      subnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        onePerAz: true,
      }),
    });

    vpc.addInterfaceEndpoint("ECSEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECS,
      privateDnsEnabled: true,
      subnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        onePerAz: true,
      }),
    });

    vpc.addInterfaceEndpoint("SsmEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
      privateDnsEnabled: true,
      subnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        onePerAz: true,
      }),
    });

    vpc.addInterfaceEndpoint("SsmMessageEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      privateDnsEnabled: true,
      subnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        onePerAz: true,
      }),
    });

    vpc.addInterfaceEndpoint("EcsLogsEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECS_TELEMETRY,
      privateDnsEnabled: true,
      subnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        onePerAz: true,
      }),
    });

    vpc.addInterfaceEndpoint("CloudWatchLogsEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      privateDnsEnabled: true,
      subnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        onePerAz: true,
      }),
    });

    vpc.addInterfaceEndpoint("EC2MessagesEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      privateDnsEnabled: true,
      subnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        onePerAz: true,
      }),
    });

    // Define ECS cluster and service in the private subnet
    const cluster = new ecs.Cluster(this, "MQTTBrokerCluster", {
      vpc: vpc,
    });

    const mqttCreds = new secretsmanager.Secret(this, "MqttCreds", {
      generateSecretString: {
        excludePunctuation: true,
        secretStringTemplate: JSON.stringify({
          user: "root",
        }),
        generateStringKey: "password",
      },
    });

    const taskRole = new iam.Role(this, "TaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AmazonECSTaskExecutionRolePolicy"
      )
    );

    taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")
    );

    const taskExecutionRole = new iam.Role(this, "TaskExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      "MQTTBrokerTask",
      {
        taskRole: taskRole,
        executionRole: taskExecutionRole,
        memoryLimitMiB: 1024,
        cpu: 512,
      }
    );

    const imagePath = path.resolve(process.cwd(), "../configs/mosquitto");

    taskDefinition
      .addContainer("MQTTBrokerContainer", {
        cpu: 512,
        memoryLimitMiB: 1024,
        secrets: {
          MQTT_USER: ecs.Secret.fromSecretsManager(mqttCreds, "user"),
          MQTT_PASSWORD: ecs.Secret.fromSecretsManager(mqttCreds, "password"),
        },
        image: ecs.ContainerImage.fromAsset(imagePath),
        containerName: "mqtt",
        logging: new ecs.AwsLogDriver({
          streamPrefix: "mqtt-broker",
        }),
      })
      .addPortMappings(
        // MQTT
        {
          containerPort: MQTT_PORT,
          protocol: ecs.Protocol.TCP,
        },
        // Health check
        {
          containerPort: HC_PORT,
          protocol: ecs.Protocol.TCP,
        },
        // Websocket
        {
          containerPort: WS_PORT,
          protocol: ecs.Protocol.TCP,
        }
      );

    const mqttBrokerSg = new ec2.SecurityGroup(
      this,
      "MQTTBrokerSecurityGroup",
      {
        vpc,
        allowAllOutbound: true,
      }
    );

    const mqttBroker = new ecs.FargateService(this, "MQTTBrokerService", {
      cluster,
      taskDefinition,
      enableExecuteCommand: true,
      assignPublicIp: false,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [mqttBrokerSg],
    });

    // required so that health check can pass.
    const mqttLoadBalancerSg = new ec2.SecurityGroup(
      this,
      "MQTTLoadBalancerSecurityGroup",
      {
        vpc,
      }
    );

    // Create an Application Load Balancer
    const mqttLoadBalancer = new elbv2.ApplicationLoadBalancer(
      this,
      "MQTTLoadBalancer",
      {
        vpc,
        internetFacing: false,
        securityGroup: mqttLoadBalancerSg,
      }
    );

    // Add a listener to the Application Load Balancer
    const mqttListener = mqttLoadBalancer.addListener("MQTTListener", {
      port: WS_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: true
    });

    // Add the MQTT broker as a target for the listener
    mqttListener.addTargets("MQTTBrokerTarget", {
      port: WS_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [mqttBroker],
      healthCheck: {
        port: `${HC_PORT}`,
        path: "/",
        protocol: elbv2.Protocol.HTTP,
      },
      stickinessCookieDuration: cdk.Duration.seconds(60),
    });

    const configBucket = new s3.Bucket(this, "ConfigBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const coreEnv = {
      CONFIG_BUCKET: configBucket.bucketName,
      SERVER: `ws://${mqttLoadBalancer.loadBalancerDnsName}:${WS_PORT}`,
      CREDS: mqttCreds.secretArn,
    };

    const lambdasPath = lambda.Code.fromAsset(
      path.resolve(process.cwd(), "../bin")
    );

    const controlSg = new ec2.SecurityGroup(this, "ControlSecurityGroup", {
      vpc,
      allowAllOutbound: true,
    });

    const controlLambdaExecutionRole = new iam.Role(
      this,
      "ControlLambdaExecutionRole",
      {
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName(
            "service-role/AWSLambdaVPCAccessExecutionRole"
          ),
        ],
      }
    );

    const mqttCredentials = secretsmanager.Secret.fromSecretNameV2(
      this,
      "MQTTCredentials",
      "mqtt-credentials"
    );

    // We call this function several times as scheduled by the schedule lambda.
    const controlLambda = new lambda.Function(this, "Control", {
      runtime: lambda.Runtime.GO_1_X,
      handler: "control",
      code: lambdasPath,
      environment: coreEnv,
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      role: controlLambdaExecutionRole,
      timeout: cdk.Duration.seconds(15),
      securityGroups: [controlSg],
    });

    controlLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue", "kms:Decrypt"],
        resources: ["*"],
      })
    );

    const createMappingLambda = new lambda.Function(this, "CreateMapping", {
      runtime: lambda.Runtime.GO_1_X,
      handler: "create_mapping",
      code: lambda.Code.fromAsset("../bin"),
      environment: {
        CONFIG_BUCKET: coreEnv.CONFIG_BUCKET,
      },
      timeout: cdk.Duration.seconds(15),
    });

    mqttCredentials.grantRead(controlLambda);

    configBucket.grantReadWrite(createMappingLambda);
    configBucket.grantRead(controlLambda);

    mqttLoadBalancerSg.connections.allowFromAnyIpv4(ec2.Port.tcp(WS_PORT));
    mqttLoadBalancerSg.connections.allowFromAnyIpv4(ec2.Port.tcp(HC_PORT));

    controlSg.connections.allowFrom(mqttLoadBalancerSg, ec2.Port.tcp(WS_PORT));

    mqttBrokerSg.connections.allowFromAnyIpv4(ec2.Port.tcp(WS_PORT));
    mqttBrokerSg.connections.allowFromAnyIpv4(ec2.Port.tcp(HC_PORT));
  }
}

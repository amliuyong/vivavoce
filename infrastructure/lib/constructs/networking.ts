import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { BACKEND_PORT } from '../common/constants';

/**
 * VPC + public/private subnet + NAT + security groups + VPC endpoints.
 * - ALB 公网(设计决策 去 CloudFront):443/80 由 listener open:true 放行;
 *   本 SG 的 VPC CIDR 规则保留给内部东西向(如调试),不再有 VPC Origin 概念。
 */
export interface NetworkingProps {
  stackName: string;
}

export class Networking extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly backendSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, _props: NetworkingProps) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 3,
      natGateways: 1,
      flowLogs: {
        VpcFlowLogs: {
          trafficType: ec2.FlowLogTrafficType.ALL,
          destination: ec2.FlowLogDestination.toCloudWatchLogs(),
        },
      },
      subnetConfiguration: [
        { cidrMask: 24, name: 'public-subnet', subnetType: ec2.SubnetType.PUBLIC },
        { cidrMask: 24, name: 'private-subnet', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });

    // Gateway Endpoints(免费,减少 NAT 流量)—— S3 录音 / DynamoDB 状态
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
    });
    this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
    });

    // ALB 安全组(公网 ALB):443/80 入站由 listener open:true 注入;这里只放行 VPC 内
    // 东西向(backend 等内部组件仍可经 ALB 私有 IP 走 443——同 SG 规则覆盖)。
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: this.vpc,
      description: 'Public ALB (443 only; 80 redirects)',
      allowAllOutbound: false,
    });
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      // ★ EC2 SG 规则描述有字符集限制(a-zA-Z0-9._-:/()#,@[]+=&;{}!$* 及空格)——**不含箭头/破折号**,
      //   否则 CreateSecurityGroup 报 "Invalid rule description"(北京部署实测,分区无关)。
      'internal east-west via ALB 443 (backend to rt ready/hangup)',
    );
    this.albSecurityGroup.addEgressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.allTcp(),
      'Allow TCP egress to VPC',
    );

    // 控制面 ECS 安全组:仅放通来自 ALB 的流量
    this.backendSecurityGroup = new ec2.SecurityGroup(this, 'BackendSecurityGroup', {
      vpc: this.vpc,
      description: 'Backend ECS (Orchestrator API) service',
      allowAllOutbound: true,
    });
    this.backendSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(BACKEND_PORT),
      `Allow traffic from ALB on port ${BACKEND_PORT}`,
    );
  }
}

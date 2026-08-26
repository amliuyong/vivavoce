import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

/**
 * KMS keys for recordings and PII-bearing data tables.
 * S3 录音桶 SSE-KMS 用此 key;预签名 URL 限时下载。
 */
export interface KmsKeysProps {
  stackName: string;
}

export class KmsKeys extends Construct {
  public readonly recordingEncryptionKey: kms.Key;
  /** PII 数据表(Targets/SessionEvents/Results)的 DynamoDB CMK —— 可审计/可轮转/可收权。 */
  public readonly dataEncryptionKey: kms.Key;

  constructor(scope: Construct, id: string, props: KmsKeysProps) {
    super(scope, id);

    this.recordingEncryptionKey = new kms.Key(this, 'RecordingKey', {
      description: `${props.stackName} recording encryption key`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // 录音 key 保留,防误删导致历史录音不可解
    });

    // PII 数据表用项目 CMK(合规:Targets 存 email/手机、SessionEvents 存逐句转写、Results 存摘要),
    // 与录音桶 CMK 一致姿态;AWS-owned key 无法审计/轮转/收权,故含 PII 的表用 CMK。
    this.dataEncryptionKey = new kms.Key(this, 'DataKey', {
      description: `${props.stackName} DynamoDB PII data encryption key`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // 数据 key 保留,防误删导致历史数据不可解
    });
  }
}

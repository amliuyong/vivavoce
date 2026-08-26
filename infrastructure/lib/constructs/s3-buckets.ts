import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

/**
 * S3 buckets for encrypted recordings and access logs.
 */
export interface S3BucketsProps {
  stackName: string;
  recordingEncryptionKey: kms.Key;
}

export class S3Buckets extends Construct {
  /** 双声道录音 WAV,SSE-KMS 加密,预签名 URL 限时下载 */
  public readonly recordingBucket: s3.Bucket;
  /** 访问日志 */
  public readonly logBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: S3BucketsProps) {
    super(scope, id);

    this.logBucket = new s3.Bucket(this, 'LogBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
    });

    this.recordingBucket = new s3.Bucket(this, 'RecordingBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.recordingEncryptionKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // 录音是评估依据,保留
      serverAccessLogsBucket: this.logBucket,
      serverAccessLogsPrefix: 'recording-access/',
      lifecycleRules: [
        // 录音留存策略(合规:数据最小化 + 留存期限):30 天转 IA 省成本,到期(默认 365 天)自动删除。
        // 录音含候选人语音(个人敏感信息),不应无限期留存;留存期经 env AIM_RECORDING_RETENTION_DAYS
        // 可配(按业务审计期/合规要求调)。
        {
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(30) },
          ],
          expiration: cdk.Duration.days(
            parseInt(process.env.AIM_RECORDING_RETENTION_DAYS || '365', 10),
          ),
        },
      ],
    });
  }
}

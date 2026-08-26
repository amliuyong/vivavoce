import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

/**
 * Control-plane entity tables and the session event stream table.
 * All tables use PAY_PER_REQUEST and point-in-time recovery.
 *
 * 事件表 SessionEvents:PK=session_id, SK=meta | attempt#<n> | event#<ts>(单表承三类行,HLD §6.2),
 * 开 Streams 驱动 Evaluator(会话结束按 rubric 打分写 Results)。
 */
export interface DynamoDbTablesProps {
  stackName: string;
  /** PII 表(Targets/SessionEvents/Results)的 DynamoDB CMK(合规) */
  dataEncryptionKey: kms.IKey;
}

export class DynamoDbTables extends Construct {
  public readonly agentsTable: dynamodb.Table; // Agents(design contract,原 KnowledgeProfiles)
  public readonly questionBanksTable: dynamodb.Table; // QuestionBanks(design contract,可复用题库)
  public readonly targetsTable: dynamodb.Table; // Targets
  public readonly campaignsTable: dynamodb.Table; // Campaigns(v1 用,MVP 建表预留)
  public readonly sessionsTable: dynamodb.Table; // Sessions
  public readonly resultsTable: dynamodb.Table; // Results
  public readonly sessionEventsTable: dynamodb.Table; // SessionEvents(+Streams)
  public readonly slotPoolsTable: dynamodb.Table; // SlotPools(候选人自助时段池,design contract)
  public readonly integrationTable: dynamodb.Table; // Integration(API client/Webhook/幂等,design contract)
  public readonly systemConfigTable: dynamodb.Table; // SystemConfig(GPU 容量 config/live,design contract)

  constructor(scope: Construct, id: string, props: DynamoDbTablesProps) {
    super(scope, id);

    const base = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    } satisfies Partial<dynamodb.TableProps>;

    // 含 PII 的表(Targets/SessionEvents/Results)叠加项目 CMK 加密(合规,review 高危项)。
    const piiBase = {
      ...base,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.dataEncryptionKey,
    } satisfies Partial<dynamodb.TableProps>;

    // Agents(design contract,原 KnowledgeProfiles):PK=agent_id(人设/rubric/引擎/出题策略;版本快照随 Session 记录)
    this.agentsTable = new dynamodb.Table(this, 'Agents', {
      ...base,
      tableName: `${props.stackName}-Agents`,
      partitionKey: { name: 'agent_id', type: dynamodb.AttributeType.STRING },
    });

    // QuestionBanks(design contract):PK=question_bank_id(可复用题库,独立版本;非 PII,题目是配置)
    this.questionBanksTable = new dynamodb.Table(this, 'QuestionBanks', {
      ...base,
      tableName: `${props.stackName}-QuestionBanks`,
      partitionKey: { name: 'question_bank_id', type: dynamodb.AttributeType.STRING },
    });

    // Targets(含 PII:email/手机/工号):PK=target_id;GSI 按 external_id 去重/关联
    this.targetsTable = new dynamodb.Table(this, 'Targets', {
      ...piiBase,
      tableName: `${props.stackName}-Targets`,
      partitionKey: { name: 'target_id', type: dynamodb.AttributeType.STRING },
    });
    this.targetsTable.addGlobalSecondaryIndex({
      indexName: 'ExternalIdIndex',
      partitionKey: { name: 'external_id', type: dynamodb.AttributeType.STRING },
      // 注:理想用 KEYS_ONLY(查询只需 target_id,省写放大),但 DynamoDB 不允许原地改已有 GSI 的
      // projection(需换名重建)。已部署表保持 ALL;全新部署可改 KEYS_ONLY。记 v1 待办。
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Campaigns:PK=campaign_id;GSI 按 status 列运行中批次(看板)
    this.campaignsTable = new dynamodb.Table(this, 'Campaigns', {
      ...base,
      tableName: `${props.stackName}-Campaigns`,
      partitionKey: { name: 'campaign_id', type: dynamodb.AttributeType.STRING },
    });
    this.campaignsTable.addGlobalSecondaryIndex({
      indexName: 'StatusIndex',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.STRING },
    });

    // Sessions:PK=session_id
    //  GSI TriggerIndex:列「临时会议」(trigger=manual,REQUIREMENTS 会议归属分线)
    //  GSI CampaignIndex:列某 Campaign 旗下会议(campaign_id)
    this.sessionsTable = new dynamodb.Table(this, 'Sessions', {
      ...base,
      tableName: `${props.stackName}-Sessions`,
      partitionKey: { name: 'session_id', type: dynamodb.AttributeType.STRING },
    });
    this.sessionsTable.addGlobalSecondaryIndex({
      indexName: 'TriggerIndex',
      partitionKey: { name: 'trigger', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.STRING },
    });
    this.sessionsTable.addGlobalSecondaryIndex({
      indexName: 'CampaignIndex',
      partitionKey: { name: 'campaign_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.STRING },
    });
    // BookedByIndex:staff「我的会议」精确查询(booked_by=<self>,按时间倒序),避免全表 scan(review)。
    this.sessionsTable.addGlobalSecondaryIndex({
      indexName: 'BookedByIndex',
      partitionKey: { name: 'booked_by', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.STRING },
    });
    // StatusIndex(design contract):capacity-reconciler 按 status query 算预扩 P / 积压 Q,
    // 避免每分钟全表 scan(大 Campaign 上千 session 会拖垮 reconciler / 踩闸门过期分支)。
    // ⚠ **不设 sortKey**(review_asap 即时发起会话无 meeting_start;DDB GSI sort key 非可选 →
    // 缺该属性的项不会进索引 → Q 漏掉 dispatch_asap → auto 不为即时发起扩容)。reconciler 本就在内存
    // 按 meeting_start 窗口过滤,不需索引排序,故 partition-only 即可,且保证所有 status 项都入索引。
    this.sessionsTable.addGlobalSecondaryIndex({
      indexName: 'StatusIndex',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
    });

    // Results(含 PII:AI 摘要/摘录):PK=session_id(与 Session 1:1)
    this.resultsTable = new dynamodb.Table(this, 'Results', {
      ...piiBase,
      tableName: `${props.stackName}-Results`,
      partitionKey: { name: 'session_id', type: dynamodb.AttributeType.STRING },
    });

    // SessionEvents(含 PII:逐句转写正文):PK=session_id, SK=(meta|attempt#<n>|event#<ts>);
    // 开 Streams 给 Evaluator。timeToLiveAttribute=expires_at:转写明细按审计期过期回收(review)。
    this.sessionEventsTable = new dynamodb.Table(this, 'SessionEvents', {
      ...piiBase,
      tableName: `${props.stackName}-SessionEvents`,
      partitionKey: { name: 'session_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: 'expires_at',
    });

    // SlotPools(候选人自助时段池,design contract;含 PII:候选人/会议信息):PK=slot_id;
    // GSI EngagementIndex 按招聘环节列时段(候选人选时段、HR 管理本环节时段)。
    this.slotPoolsTable = new dynamodb.Table(this, 'SlotPools', {
      ...piiBase,
      tableName: `${props.stackName}-SlotPools`,
      partitionKey: { name: 'slot_id', type: dynamodb.AttributeType.STRING },
    });
    this.slotPoolsTable.addGlobalSecondaryIndex({
      indexName: 'EngagementIndex',
      partitionKey: { name: 'engagement_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'meeting_start', type: dynamodb.AttributeType.STRING },
    });

    // Integration(API client / Webhook / 幂等键,design contract;含 PII:webhook secret/api key hash):
    // PK=pk, SK=sk(client#<id>/webhook#<wid>/idemp#<client>#<key>);幂等行 TTL expires_at 自动回收。
    this.integrationTable = new dynamodb.Table(this, 'Integration', {
      ...piiBase,
      tableName: `${props.stackName}-Integration`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expires_at',
    });

    // SystemConfig(系统级运行时配置,design contract):PK=config_key
    //  gpu_capacity_config(admin 写期望,乐观锁 config_version)/ gpu_capacity_live(reconciler 写实况)。
    //  非 PII(无候选人/会议信息),用 base(项目默认加密即可)。
    this.systemConfigTable = new dynamodb.Table(this, 'SystemConfig', {
      ...base,
      tableName: `${props.stackName}-SystemConfig`,
      partitionKey: { name: 'config_key', type: dynamodb.AttributeType.STRING },
    });
  }

  /** 控制面 ECS task role 读写全部表(Stack 末尾统一 grant,HLD §2.4 模式 3)。 */
  public grantReadWriteAll(grantee: iam.IGrantable): void {
    for (const t of [
      this.agentsTable,
      this.questionBanksTable,
      this.targetsTable,
      this.campaignsTable,
      this.sessionsTable,
      this.resultsTable,
      this.sessionEventsTable,
      this.slotPoolsTable,
      this.integrationTable,
      this.systemConfigTable,
    ]) {
      t.grantReadWriteData(grantee);
    }
  }
}

import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import {
  MCP_OAUTH_CALLBACK_URL,
  MCP_REFRESH_ROTATION_GRACE_SEC,
  MCP_REFRESH_TOKEN_VALIDITY_DAYS,
} from '../common/constants';

/**
 * Cognito User Pool + Client + two role groups.
 * 角色对应 mock 的 CURRENT_ROLE(两层):
 *   admin — 运营/管理侧,看所有干所有(Campaign / 对象 / Profile / 发起 / 改判)
 *   staff — 自助受测者,只「我的会议」+「预约新会议」(选 self_bookable Profile 自助约)
 *
 * design contract(MCP OAuth 登录)补:Hosted UI domain + ResourceServer `aim/invoke` + public MCP code-flow client。
 */
export interface CognitoAuthProps {
  stackName: string;
  adminEmail: string;
  /** CloudFront 域(回调 URL);骨架阶段可后注入,故可选 */
  appDomain?: string;
}

export class CognitoAuth extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  /** design contract:Hosted UI 域前缀(下发 backend 拼 AS metadata 的 authorize/token/revoke host)。 */
  public readonly hostedUiDomainPrefix: string;
  /** design contract:MCP OAuth code-flow public client(下发 backend 作 `/api/mcp` Bearer 分支的 allowed client_id)。 */
  public readonly mcpClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: CognitoAuthProps) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${props.stackName}-users`,
      selfSignUpEnabled: false, // 由 Admin 建账号,不开放自助注册
      signInAliases: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      // MFA 可选(用户决定:不强制 MFA 以简化登录)。仍保留 TOTP 能力供用户自愿开启。
      // 注:鉴权红线由 JWT 强校验 + WAF + 私网 ALB 守护;MFA 非强制(AwsSolutions-COG2 已豁免登记)。
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      // 高级安全(AwsSolutions-COG8):检测异常登录、防弱密码
      featurePlan: cognito.FeaturePlan.PLUS,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const callbackUrls = props.appDomain
      ? [`https://${props.appDomain}`, `https://${props.appDomain}/`]
      : ['http://localhost:3000']; // 骨架/本地开发占位
    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: `${props.stackName}-web`,
      // userSrp:前端 SRP 登录;adminUserPassword:服务端 admin-initiate-auth(集成/e2e 用,
      // 需 IAM 凭证 + 用户密码,不降前端安全面)。两者都不暴露明文密码给浏览器。
      authFlows: { userSrp: true, adminUserPassword: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
        callbackUrls,
      },
    });

    // ════════ design contract:MCP OAuth 登录前提 ════════
    // ── Hosted UI domain(授权码 + PKCE 登录的落点)──
    // 前缀 = <stackName 小写>-<accountId 后 8 位> 两维:跨账号在该 region 全局唯一,
    // 且避免同一账号中的多个栈发生前缀冲突。
    // ★ 前缀一旦定下并写入 AS metadata / 客户端 issuer,**视为不可变**(改前缀 = 换 authorize/token host,
    //   老 MCP 客户端全失效)。domain 前缀有字符/长度约束(小写字母数字与连字符,≤63),故清洗 stackName。
    // 离线 synth(--synth-only 无凭证)时 account 是未解析 Token,slice 会产出非法字符炸 domainPrefix
    // 校验;用固定占位保住离线校验路径。真实部署由 scripts/viva 经 STS 注入 account。
    const acctRaw = cdk.Stack.of(this).account;
    const acctSuffix = cdk.Token.isUnresolved(acctRaw) ? '00000000' : acctRaw.slice(-8);
    const stackSlug = props.stackName.toLowerCase().replace(/[^a-z0-9]/g, '');
    this.hostedUiDomainPrefix = `aim-${stackSlug}-${acctSuffix}`;
    this.userPool.addDomain('HostedUiDomain', {
      cognitoDomain: { domainPrefix: this.hostedUiDomainPrefix },
    });

    // ── ResourceServer `aim` + scope `invoke` → 授权锚点 `aim/invoke` ──
    // custom scope 即资源绑定锚点(token 含它 = 为本资源签发);MCP client 授予,WebClient 不需要
    //   (SRP token 本就不带自定义 scope)。
    const invokeScope = new cognito.ResourceServerScope({
      scopeName: 'invoke',
      scopeDescription: 'Invoke AIM MCP tools on behalf of the signed-in staff',
    });
    const resourceServer = this.userPool.addResourceServer('AimResourceServer', {
      identifier: 'aim',
      scopes: [invokeScope],
    });

    // ── 专用 MCP code-flow public client(PKCE、无 secret、固定 loopback 回调)──
    this.mcpClient = this.userPool.addClient('McpClient', {
      userPoolClientName: `${props.stackName}-mcp`,
      // public client:本地授权码流不得依赖 client secret(mcp-remote 无处安放 secret)。
      generateSecret: false,
      // ★ 显式钉死 explicit flows、**不含 SRP** —— 注意「不传 authFlows」≠ 关 SRP:authFlows 缺省/空对象时
      //   L2 不下发 ExplicitAuthFlows → Cognito 默认含 ALLOW_USER_SRP_AUTH。显式设 userSrp:false 才真关
      //   (实测 synth → ExplicitAuthFlows:[])。**别手动补 ALLOW_REFRESH_TOKEN_AUTH**:设了 rotation 后
      //   L2 用 rotation 取代它(见下),补了反而与 rotation 语义冲突。
      authFlows: { userSrp: false },
      oAuth: {
        flows: { authorizationCodeGrant: true }, // 仅授权码 + PKCE
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
          cognito.OAuthScope.resourceServer(resourceServer, invokeScope), // aim/invoke
        ],
        // ★ full facade(design contract):回调 = **facade 固定回调** `https://<appDomain>/oauth/callback`(单一、非
        //   loopback)—— facade 用它对 Cognito,client 随机 loopback 端口藏 HMAC state,不进 Cognito 登记。
        //   无自定义域名(appDomain 缺)时退回 loopback 常量(A-lite 行为,full facade 需公网域名才成立)。
        callbackUrls: props.appDomain
          ? [`https://${props.appDomain}/oauth/callback`]
          : [MCP_OAUTH_CALLBACK_URL],
      },
      enableTokenRevocation: true, // 供 client 主动吊销单个 refresh token(配合 AS metadata revocation_endpoint)
      // refresh token rotation:aws-cdk-lib 2.260.0 的 L2 prop(设置即 RefreshTokenRotation.feature=ENABLED,
      //   grace 0–60s);**直接用 L2 prop、不用 escape hatch**。若 P6 实测 rotation 破坏 mcp-remote 静默刷新,
      //   去掉此 prop 降级普通 refresh(此时 L2 会自动补回 ALLOW_REFRESH_TOKEN_AUTH)。
      refreshTokenRotationGracePeriod: cdk.Duration.seconds(MCP_REFRESH_ROTATION_GRACE_SEC),
      accessTokenValidity: cdk.Duration.hours(1), // 保持默认 1h
      refreshTokenValidity: cdk.Duration.days(MCP_REFRESH_TOKEN_VALIDITY_DAYS),
    });

    // 两角色 Group(API 侧按 group 做 RBAC,对齐 mock 角色显隐)
    const groups: Record<string, cognito.CfnUserPoolGroup> = {};
    for (const role of ['admin', 'staff']) {
      groups[role] = new cognito.CfnUserPoolGroup(this, `Group_${role}`, {
        userPoolId: this.userPool.userPoolId,
        groupName: role,
        description: `AIM role: ${role}`,
      });
    }

    // 初始 Admin 账号 + **加入 admin Group**(骨架阶段 adminEmail 可空则跳过)。
    // ★ 必须入组:否则 access token 的 cognito:groups 为空,Principal.is_admin=false,所有
    //   require_admin/require_staff 端点 403,首部署后系统完全不可用(review 双 BLOCKER)。
    // 用 AwsCustomResource 而非 CfnUserPoolUser + CfnUserPoolUserToGroupAttachment,原因:
    //   ① pool 配 signInAliases.email,username 内部是 sub(UUID),CfnUserPoolUserToGroupAttachment
    //      的 username 字段无法用 email 匹配;② CFN 资源对「池内用户被带外删除」会漂移
    //      (CFN 以为还在 → attachment 报 User does not exist)。AwsCustomResource 每次部署幂等执行:
    //      adminCreateUser(已存在则忽略 UsernameExistsException)→ adminAddUserToGroup(幂等)。
    if (props.adminEmail) {
      // 单个 Lambda 自定义资源:每次部署(Create/Update)都**原子地** create-user(忽略已存在)→
      // add-to-group。比两个 AwsCustomResource 可靠 —— 后者在 UPDATE 时可能只跑其一(physicalResourceId
      // 不变 → CFN 视作 no-op 不调用),导致入组先于建用户、报 User does not exist(实测踩坑)。
      const seedFn = new lambda.Function(this, 'AdminSeedFn', {
        runtime: lambda.Runtime.PYTHON_3_13,
        handler: 'index.handler',
        timeout: cdk.Duration.seconds(60),
        code: lambda.Code.fromInline(`
import boto3, json, urllib.request
def _send(event, ctx, status, reason=""):
    body = json.dumps({"Status": status, "Reason": reason or "ok", "PhysicalResourceId": "admin-seed",
        "StackId": event["StackId"], "RequestId": event["RequestId"], "LogicalResourceId": event["LogicalResourceId"], "Data": {}}).encode()
    req = urllib.request.Request(event["ResponseURL"], data=body, method="PUT", headers={"content-type": ""})
    urllib.request.urlopen(req)
def handler(event, ctx):
    try:
        if event["RequestType"] != "Delete":
            p = event["ResourceProperties"]; c = boto3.client("cognito-idp")
            try:
                c.admin_create_user(UserPoolId=p["UserPoolId"], Username=p["Email"],
                    DesiredDeliveryMediums=["EMAIL"], MessageAction="SUPPRESS",
                    UserAttributes=[{"Name": "email", "Value": p["Email"]}, {"Name": "email_verified", "Value": "true"}])
            except c.exceptions.UsernameExistsException:
                pass
            c.admin_add_user_to_group(UserPoolId=p["UserPoolId"], Username=p["Email"], GroupName="admin")
        _send(event, ctx, "SUCCESS")
    except Exception as e:
        _send(event, ctx, "FAILED", str(e))
`),
      });
      seedFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminAddUserToGroup'],
        resources: [this.userPool.userPoolArn],
      }));
      const provider = new Provider(this, 'AdminSeedProvider', { onEventHandler: seedFn });
      const seed = new cdk.CustomResource(this, 'AdminUserSeed', {
        serviceToken: provider.serviceToken,
        properties: {
          UserPoolId: this.userPool.userPoolId,
          Email: props.adminEmail,
          // 每次部署变更 → CFN 必触发 onEvent(确保入组幂等重跑,纠正带外漂移)
          Nonce: cdk.Names.uniqueId(this) + ':' + props.adminEmail,
        },
      });
      seed.node.addDependency(groups.admin);  // admin group 必须先存在
    }
  }
}

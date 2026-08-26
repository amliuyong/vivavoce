"""运行时配置 —— 全部经环境变量注入(CDK ecs-backend 的 environment 块)。

设计原则:配置集中一处、有显式默认、可被测试覆盖。认证相关项(USER_POOL_ID /
USER_POOL_CLIENT_ID / AWS_REGION)缺失时**不静默放行**,而是让鉴权层 fail-closed。
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass

# design contract:MCP OAuth 的资源绑定锚点 —— custom scope。MCP client 的 access token 必含此 scope
# 才准调 `/api/mcp`(Cognito access token 的 aud 恒为 client_id、无资源标识,故以 scope 作等效资源绑定,
# 见 design contract Req「/api/mcp 接受 Cognito access token」;不做 RFC 8707 audience 校验)。
MCP_INVOKE_SCOPE = "aim/invoke"


@dataclass(frozen=True)
class Settings:
    region: str
    user_pool_id: str
    user_pool_client_id: str
    # DDB 表名(CDK 注入);本地/测试可用 moto 或留空
    agents_table: str  # Agents(design contract,原 KnowledgeProfiles)
    question_banks_table: str  # QuestionBanks(design contract,可复用题库)
    targets_table: str
    sessions_table: str
    results_table: str
    session_events_table: str
    slot_pools_table: str  # 候选人自助时段池(design contract)
    integration_table: str  # API client / Webhook / 幂等键(design contract,单表三类行)
    system_config_table: str  # 系统级运行时配置(design contract:GPU 容量 config/live 两条记录)
    recording_bucket: str
    default_engine_type: str
    # 本地/测试:指向 moto / dynamodb-local;留空 = 用真实 AWS endpoint
    dynamodb_endpoint_url: str | None
    # 鉴权开关:仅测试用本地 JWKS;生产恒为 cognito(见 auth.py)
    auth_mode: str
    # 全局并发闸门**安全阀/硬顶**(design contract;= CDK 注入的 GPU_HARD_MAX×每实例,给 autoscaling 留弹性空间)。
    # 真实可服务并发由 reconciler 写 DDB live、闸门运行时动态读取主导;此值仅作不可逾越的顶。
    max_concurrency: int
    # 闸门 live 实况**缺失**(首次部署/reconciler 首轮前)时的保守兜底容量(= env AIM_GPU_CAPACITY,
    # CDK 注入 1 实例并发)。避免首启窗口按硬顶超派。reconciler 写 live 后即被取代。
    gpu_capacity_static_fallback: int
    # staff 改/取消自助预约的锁定窗口:距开始 < 此分钟数即锁定(design contract,默认 30)。
    # 注:session 单场改约锁随「即时开始」转向删除;此项仅候选人 slot 预约层仍用(design contract)。
    staff_edit_lock_min: int
    # 即时开始模型:scheduled 会话创建后超过此分钟数仍未连入 → 调度器判 failed(过期未连入)。
    # 默认 30,与 bridge session-context 预创建 TTL 对齐(env AIM_SESSION_JOIN_EXPIRE_MIN)。
    session_join_expire_min: int
    # 实时会话服务的入口 URL(如 http://<实时服务>:3001);配了则控制面真 HTTP 下发
    # /sessions/{id}/ready(会话就绪指令,带 X-Bridge-Secret),否则只落库(RecordingDispatcher)。
    bridge_dial_url: str | None
    # 对外候选人自助(design contract)一次性链接的 HMAC 签名密钥;缺失则候选人端点 fail-closed(503)。
    # 生产经 CDK 从 Secrets Manager / 强随机注入,绝不硬编码默认值。
    candidate_token_secret: str | None
    # 委托 token(staff 授权第三方 agent,design contract)的独立 HMAC 签名密钥。与候选人链接密钥分离:
    # 二者信任域不同(委托 token 能代 staff 预约/改/取消,爆炸半径远大于候选人只读链接),共用一钥则
    # 泄一密钥即可同时伪造两域。缺省(未单独配)回退 candidate_token_secret 保持向后兼容;生产 MUST 单配。
    delegation_token_secret: str | None
    # 公网 API base(CloudFront 域名,如 https://xxx.cloudfront.net);用于委托 MCP 配置回填 endpoint。
    # 缺省则委托响应的 mcp_config.endpoint 留空,由前端用当前 origin 填充。
    public_api_base: str | None
    # 实时服务↔控制面共享密钥:①实时服务调 POST /api/sessions/{id}/events(状态回报)带
    # X-Bridge-Secret 头,后端比对;②控制面调实时服务 /sessions/{id}/ready(预创建)同样带此头。
    # 缺失则回调端点 fail-closed(503),不接受匿名状态回报。
    bridge_callback_secret: str | None
    # MiniMax TTS provider(design contract)。配置全装在单一 Secret(key + 非密参数 JSON);backend admin
    # 端点读写该 Secret(脱敏回显 key)。缺失则 admin 端点 fail-closed(503)。
    minimax_secret_arn: str | None
    # GPU 内网热加载端点 base(如 http://gpu.<stack>-gpu.local:8080);PUT 写完 Secret 后 best-effort
    # 调 {base}/reload-tts-config 令 GPU 重读 + 重跑 self-probe。缺失则只落 Secret(GPU 下次启动/重载拿到)。
    gpu_control_url: str | None
    # GPU 内网控制端点共享密钥(= GPU 的 AIM_DRAIN_SECRET):backend 调 /reload-tts-config 带 X-Drain-Secret。
    # 缺失则热加载调用跳过(配置仍落 Secret,GPU 下次启动重读兜底)。
    gpu_control_secret: str | None
    # 三段式 LLM 配置(design contract)。单一 Secret 承载 mantle host + 模型清单 + Bearer token。**仅控制面读**:
    # 发起时读 Secret 逐通注入就绪指令(实时服务不持系统级 token)。缺失则 admin 端点 fail-closed(503),
    # 且发起三段式会话时无凭据 → 明确拒绝(不拨静默呼叫)。
    llm_secret_arn: str | None
    # design contract:MCP OAuth code-flow client 的 client_id(Cognito 专用 public client,PKCE、无 secret)。
    # `/api/mcp` 的 Bearer 分支据此放行(allowed_client_ids={mcp_client_id});缺失则 OAuth 路径不可用
    # (仍可走委托 token 回退)。Web 路径(require_user/admin/staff)**不**接受此 client_id。CDK 注入。
    mcp_client_id: str | None
    # design contract:Cognito Hosted UI 域前缀(<stackName 小写>-<accountId 后8位>,不可变)。AS metadata 端点
    # (RFC 8414)据此手填 authorize/token/revoke 端点(Hosted UI 域,region 拼 effective_auth_region)。CDK 注入。
    cognito_hosted_ui_domain: str | None
    # design contract(full facade):HMAC 签名 state 的独立密钥。facade `/oauth/authorize` 把 client 真实 loopback
    # redirect_uri 打进签名 state,`/oauth/callback` 验签取回。独立密钥(信任域与 bridge/委托/候选人分离,
    # 泄一钥不牵连他域)。缺失则 facade authorize/callback fail-closed(503)——退回直连 Cognito Hosted UI
    # (无零配置,但不畸形)。CDK 从 Secrets Manager 注入。**是防篡改+限时,不防重放**(见 design contract §硬边界)。
    mcp_facade_state_secret: str | None = None
    # 设计决策(VISION §2,去 CloudFront + S3):前端静态产物由 backend 容器托管,
    # /config.json 改为动态渲染。此项 = design contract mcp-remote 本地回调 URL(与 Cognito 预注册一字不差),
    # 原经 CDK 写进 S3 config.json,现经 env AIM_MCP_OAUTH_CALLBACK_URL 注入;缺省空=前端用内置默认。
    # (带默认值:仅新增于既有字段之后,老的 Settings(...) 全量构造不受影响。)
    mcp_oauth_callback_url: str | None = None
    # 前端静态产物目录(Dockerfile 多阶段把 frontend/out 烘进镜像的 ./static;默认 <backend>/static)。
    # 目录不存在 → 静态托管优雅缺席(只打 warning,API 照常)——本地 uvicorn 直跑即此形态;
    # 测试可注入 tmp 目录验证挂载行为。None = 用默认路径。
    static_dir: str | None = None
    # VISION §2 拍板:认证所在 region 与部署 region 解耦 —— 中国区无 Cognito,复用美东池作外置标准
    # OIDC:登录/JWKS/Hosted UI 全指向 auth_region(env AIM_AUTH_REGION),其余资源仍看 region。
    # None = 回退 region(Global 部署零变化);经 effective_auth_region 消费,勿直接拼 URL。
    auth_region: str | None = None
    # design contract(认证外置 M2 地基):角色来源 claim 名可配 —— 从 JWT 哪个顶级 claim 取角色。默认 "cognito:groups"
    # (现有 Cognito 部署逐字节等价)。换非 Cognito OIDC IdP 时配 AIM_ROLE_CLAIM(如 "roles"/"groups")。仅顶级键,
    # 不支持嵌套路径(realm_access.roles)。经 CognitoVerifier._extract_roles 消费(单一来源:只读这一个 claim)。
    role_claim: str = "cognito:groups"
    # design contract:claim 值 → 内部角色(admin/staff)映射。None = 恒等(claim 值原样用作角色名 = 现状)。配了则
    # 有键取值、无键丢弃(宁少授勿多授)、去重、丢空值。坏 AIM_ROLE_MAP(非法 JSON/非 dict/值非 str)→ load_settings
    # fail-fast 拒绝启动(鉴权配置配错须响亮暴露,不静默降级)。已解析的 dict[str,str] 或 None(不在鉴权热路径 loads)。
    role_map: dict[str, str] | None = None
    # design contract:OpenAI Realtime SDK-compatible WS 入口使用的独立 HMAC key。不得复用 bridge callback /
    # join token 或其它信任域密钥；缺失时 client-secret 签发端点 fail-closed。
    realtime_client_secret: str | None = None

    @property
    def effective_auth_region(self) -> str:
        """认证(Cognito)所在 region:auth_region 缺省回退部署 region(Global 零变化)。"""
        return self.auth_region or self.region

    @property
    def issuer(self) -> str:
        # 域名后缀恒为 amazonaws.com(不做分区后缀分叉):Cognito 在 aws-cn 分区不存在(中国无
        # Cognito),auth_region 必然是 aws 分区 region(美东池)——issuer 永远落在 amazonaws.com。
        return f"https://cognito-idp.{self.effective_auth_region}.amazonaws.com/{self.user_pool_id}"

    @property
    def jwks_url(self) -> str:
        return f"{self.issuer}/.well-known/jwks.json"

    # ── design contract:MCP OAuth 发现文档所需的派生 URL ──
    @property
    def hosted_ui_base(self) -> str | None:
        """Cognito Hosted UI 域 base(authorize/token/revoke 落点)。前缀不可变(见 design contract)。

        region 用 effective_auth_region(池所在 region,非部署 region);后缀恒 amazoncognito.com
        (同 issuer 注释:Cognito 无 aws-cn 存在,不需分区分叉)。
        """
        if not self.cognito_hosted_ui_domain:
            return None
        return f"https://{self.cognito_hosted_ui_domain}.auth.{self.effective_auth_region}.amazoncognito.com"


def _max_concurrency_ceiling() -> int:
    """全局并发**安全阀/硬顶**(design contract)。

    ⚠ 演进:design contract 曾在此把 MAX_CONCURRENCY **启动时钳制到静态 AIM_GPU_CAPACITY**;design contract 起,
    真实可服务并发由 capacity-reconciler 写 DDB live.serviceable、闸门 `_effective_max_concurrency`
    运行时动态读取并主导(随 GPU autoscaling 浮动)。**故此处不再静态钳制** —— 否则 GPU 自动扩到多实例时,
    被这里钳死的静态值会让 `min(静态, live)` 永远卡在小值,弹性失效(review)。
    本函数只负责:解析 MAX_CONCURRENCY(= 硬顶,CDK 注入 GPU_HARD_MAX×每实例),坏 env 容错回退默认。
    AIM_GPU_CAPACITY 不再在此读(它现在只是 session_service 闸门 live 缺失时的保守兜底)。
    """
    import logging

    # MAX_CONCURRENCY 容错(review):空串/非整数(误配 env)不应让进程启动即崩 → 回退默认 3 并告警。
    raw = os.getenv("MAX_CONCURRENCY", str(3))
    try:
        return int(raw)
    except ValueError:
        logging.getLogger("aim.config").warning("MAX_CONCURRENCY=%r 非整数,回退默认 3", raw)
        return 3


# 向后兼容别名(旧名;现语义=安全阀硬顶,不再静态钳制)
_clamped_max_concurrency = _max_concurrency_ceiling


def _gpu_capacity_static_fallback() -> int:
    """闸门 live 缺失时的保守兜底容量(env AIM_GPU_CAPACITY,= CDK 注入 1 实例并发,design contract)。

    仅在 DDB live 实况缺失(首次部署/reconciler 首轮前)用;reconciler 写 live 后即被动态值取代。
    坏 env / ≤0(误配)→ 回退默认 3(= 单实例并发,保守可用);不崩。
    """
    import logging

    raw = os.getenv("AIM_GPU_CAPACITY")
    if not raw:
        return 3  # 未注入(本地/测试):给单实例并发的保守默认
    try:
        v = int(raw)
    except ValueError:
        logging.getLogger("aim.config").warning("AIM_GPU_CAPACITY=%r 非整数,回退兜底 3", raw)
        return 3
    if v <= 0:
        logging.getLogger("aim.config").warning("AIM_GPU_CAPACITY=%d(≤0)疑似误配,回退兜底 3", v)
        return 3
    return v


def _parse_role_map(raw: str | None) -> dict[str, str] | None:
    """解析 AIM_ROLE_MAP(design contract):JSON 对象 {外部角色值: 内部角色名}。

    - None / 空串 → None(默认恒等映射;未配 = 现状,不解析、不崩)。
    - 合法 JSON 对象且全 {str: str}(**含空 `{}`**)→ 返回该 dict(`{}` = 合法但翻译不出任何角色,归一后 groups=[])。
    - **非法 JSON / 非对象(dict)/ 键或值非 str → 抛 ValueError(fail-fast 拒绝启动)**:鉴权配置是安全关键,
      配错必须响亮暴露(容器拒绝启动 → 部署失败),绝不静默回退恒等(可能误授)或静默回退空(静默锁死),见 design contract §坏 env。
    """
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError) as exc:
        raise ValueError(f"AIM_ROLE_MAP 非合法 JSON(鉴权配置,拒绝以错误配置启动): {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError(f"AIM_ROLE_MAP 必须是 JSON 对象 {{外部角色: 内部角色}},实得 {type(parsed).__name__}")
    for k, v in parsed.items():
        if not isinstance(k, str) or not isinstance(v, str):
            raise ValueError("AIM_ROLE_MAP 的键和值都必须是字符串")
    return parsed


def load_settings() -> Settings:
    return Settings(
        region=os.getenv("AWS_REGION", "us-east-1"),
        user_pool_id=os.getenv("USER_POOL_ID", ""),
        user_pool_client_id=os.getenv("USER_POOL_CLIENT_ID", ""),
        agents_table=os.getenv("AGENTS_TABLE_NAME", ""),
        question_banks_table=os.getenv("QUESTION_BANKS_TABLE_NAME", ""),
        targets_table=os.getenv("TARGETS_TABLE_NAME", ""),
        sessions_table=os.getenv("SESSIONS_TABLE_NAME", ""),
        results_table=os.getenv("RESULTS_TABLE_NAME", ""),
        session_events_table=os.getenv("SESSION_EVENTS_TABLE_NAME", ""),
        slot_pools_table=os.getenv("SLOT_POOLS_TABLE_NAME", ""),
        integration_table=os.getenv("INTEGRATION_TABLE_NAME", ""),
        system_config_table=os.getenv("SYSTEM_CONFIG_TABLE_NAME", ""),
        recording_bucket=os.getenv("RECORDING_BUCKET_NAME", ""),
        default_engine_type=os.getenv("DEFAULT_ENGINE_TYPE", "three_stage"),
        dynamodb_endpoint_url=os.getenv("DYNAMODB_ENDPOINT_URL") or None,
        # auth_mode=local 仅供测试注入本地 JWKS;未显式设置时一律 cognito(fail-closed)
        auth_mode=os.getenv("AIM_AUTH_MODE", "cognito"),
        max_concurrency=_max_concurrency_ceiling(),
        gpu_capacity_static_fallback=_gpu_capacity_static_fallback(),
        staff_edit_lock_min=int(os.getenv("STAFF_EDIT_LOCK_MIN", "30")),
        session_join_expire_min=int(os.getenv("AIM_SESSION_JOIN_EXPIRE_MIN", "30")),
        bridge_dial_url=os.getenv("AIM_BRIDGE_DIAL_URL") or None,
        candidate_token_secret=os.getenv("AIM_CANDIDATE_TOKEN_SECRET") or None,
        # 独立委托密钥;未配则回退候选人密钥(向后兼容,但生产应单配以隔离信任域)。
        delegation_token_secret=(
            os.getenv("AIM_DELEGATION_TOKEN_SECRET")
            or os.getenv("AIM_CANDIDATE_TOKEN_SECRET")
            or None
        ),
        public_api_base=os.getenv("AIM_PUBLIC_API_BASE") or None,
        bridge_callback_secret=os.getenv("AIM_BRIDGE_CALLBACK_SECRET") or None,
        minimax_secret_arn=os.getenv("AIM_MINIMAX_SECRET_ID") or None,
        gpu_control_url=os.getenv("AIM_GPU_CONTROL_URL") or None,
        gpu_control_secret=os.getenv("AIM_DRAIN_SECRET") or None,
        llm_secret_arn=os.getenv("AIM_LLM_CONFIG_SECRET_ID") or None,
        mcp_client_id=os.getenv("AIM_MCP_CLIENT_ID") or None,  # design contract:MCP OAuth code-flow client
        cognito_hosted_ui_domain=os.getenv("AIM_COGNITO_HOSTED_UI_DOMAIN") or None,  # design contract
        mcp_facade_state_secret=os.getenv("AIM_MCP_FACADE_STATE_SECRET") or None,  # design contract full facade HMAC state
        mcp_oauth_callback_url=os.getenv("AIM_MCP_OAUTH_CALLBACK_URL") or None,  # 去 CDN:config.json 动态渲染
        static_dir=os.getenv("AIM_STATIC_DIR") or None,  # 前端静态产物目录覆盖(默认 <backend>/static)
        # 认证 region 解耦(VISION §2):缺省 None → effective_auth_region 回退 region(Global 零变化);
        # 中国区注入 AIM_AUTH_REGION=us-east-1(美东池)。
        auth_region=os.getenv("AIM_AUTH_REGION") or None,
        # design contract(认证外置):角色来源 claim 名(默认 cognito:groups)+ 值映射(默认恒等)。
        # role_map 坏配置 fail-fast(_parse_role_map 抛),不静默降级。
        role_claim=os.getenv("AIM_ROLE_CLAIM") or "cognito:groups",
        role_map=_parse_role_map(os.getenv("AIM_ROLE_MAP")),
        realtime_client_secret=os.getenv("AIM_REALTIME_CLIENT_SECRET") or None,
    )

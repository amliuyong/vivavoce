// 运行时配置:启动时 fetch /config.json(由 CDK BucketDeployment 写入真实 Cognito 池/client/region)。
// 前端代码里不硬编码任何环境值 —— 同一份构建产物可部署到任意栈。
// apiBase 固定走同源相对路径 /api(CloudFront 行为回源私有 ALB,安全红线 D9:唯一公网入口)。

export interface RuntimeConfig {
  /** 部署 region(其余 AWS 资源所在区);拼**认证**端点勿用它,用 authRegion。 */
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  /** API 基地址,默认同源 /api(相对)。本地开发可在 config.json 指向 CloudFront。 */
  apiBase: string;
  /** design contract:MCP OAuth code-flow client_id(专用 public client);staff MCP 助手弹窗据此拼 mcp-remote
   *  命令(标准 OAuth 自动登录路径)。CDK 经 config.json 注入;空=未部署 OAuth 前提,弹窗只显示委托 token 回退。 */
  mcpClientId: string;
  /** design contract:mcp-remote 本地回调 URL(与 Cognito 预注册一字不差);拼进 mcp-remote 命令。空=用内置默认。 */
  mcpOauthCallbackUrl: string;
  /** VISION §2:认证(Cognito)所在 region —— 中国区复用美东池时 = us-east-1,与部署 region 解耦。
   *  凡拼 Cognito/AWS 认证端点(Hosted UI、cognito-idp)一律用它;缺省回退 region(Global 零变化)。 */
  authRegion: string;
}

let _config: RuntimeConfig | null = null;

export async function loadConfig(): Promise<RuntimeConfig> {
  if (_config) return _config;
  let raw: Partial<RuntimeConfig> = {};
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    if (res.ok) raw = await res.json();
  } catch {
    // 取不到 config.json(本地静态预览)→ 用占位,登录会失败但页面可渲染。
  }
  const region = raw.region || 'us-east-1';
  _config = {
    region,
    userPoolId: raw.userPoolId || '',
    userPoolClientId: raw.userPoolClientId || '',
    apiBase: raw.apiBase || '/api',
    mcpClientId: raw.mcpClientId || '',
    mcpOauthCallbackUrl: raw.mcpOauthCallbackUrl || '',
    // 老 config.json(无 authRegion)→ 回退 region(Global 语义不变)
    authRegion: raw.authRegion || region,
  };
  return _config;
}

export function getConfig(): RuntimeConfig {
  if (!_config) throw new Error('config 未加载,先 await loadConfig()');
  return _config;
}

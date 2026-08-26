// Cognito 浏览器端 SRP 登录(amazon-cognito-identity-js)。
// 后端校验 access token(token_use=access + client_id),故取 AccessToken 的 JWT 放 Authorization。
// 角色来自 access token 的 cognito:groups(admin/staff),不可前端篡改(后端按 group 做 RBAC)。
import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserSession,
} from 'amazon-cognito-identity-js';
import { getConfig } from './config';

export interface Session {
  accessToken: string;
  username: string;
  email: string;
  groups: string[];
  isAdmin: boolean;
  isStaff: boolean;
}

let _pool: CognitoUserPool | null = null;

function pool(): CognitoUserPool {
  if (_pool) return _pool;
  const cfg = getConfig();
  if (!cfg.userPoolId || !cfg.userPoolClientId) {
    throw new Error('Cognito 未配置(config.json 缺 userPoolId/userPoolClientId)');
  }
  // 认证 region 解耦(VISION §2):CognitoUserPool 不需要显式 region —— 库内部从 UserPoolId 前缀推
  // (`us-east-1_XXX`.split('_')[0] → cognito-idp.us-east-1.amazonaws.com)。中国区复用美东池时,
  // 池 ID 本身就带 us-east-1,SRP 自动指向美东;config.authRegion 供其它需显式拼认证端点处使用。
  _pool = new CognitoUserPool({
    UserPoolId: cfg.userPoolId,
    ClientId: cfg.userPoolClientId,
  });
  return _pool;
}

function sessionFromCognito(cognitoSession: CognitoUserSession, username: string): Session {
  const accessToken = cognitoSession.getAccessToken();
  const jwt = accessToken.getJwtToken();
  const payload = accessToken.decodePayload() as Record<string, unknown>;
  const groups = (payload['cognito:groups'] as string[] | undefined) || [];
  let email = username;
  try {
    const idPayload = cognitoSession.getIdToken().decodePayload() as Record<string, unknown>;
    if (typeof idPayload.email === 'string') email = idPayload.email;
  } catch {
    /* id token 可能不带 email,忽略 */
  }
  return {
    accessToken: jwt,
    username: (payload.username as string) || username,
    email,
    groups,
    isAdmin: groups.includes('admin'),
    isStaff: groups.includes('staff'),
  };
}

/**
 * SRP 登录。可能要求改初始密码(FORCE_CHANGE_PASSWORD)→ 返回 newPasswordRequired,
 * 由调用方提示用户设新密码后用 completeNewPassword 完成。
 */
export function login(
  email: string,
  password: string,
): Promise<{ session?: Session; newPasswordRequired?: { user: CognitoUser; userAttributes: Record<string, string> } }> {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: email, Pool: pool() });
    const details = new AuthenticationDetails({ Username: email, Password: password });
    user.authenticateUser(details, {
      onSuccess: (cognitoSession) => resolve({ session: sessionFromCognito(cognitoSession, email) }),
      onFailure: (err) => reject(err),
      newPasswordRequired: (userAttributes) => {
        // 删掉不可改写的属性,否则 completeNewPassword 报错
        delete userAttributes.email_verified;
        delete userAttributes.email;
        resolve({ newPasswordRequired: { user, userAttributes } });
      },
    });
  });
}

/** 完成首次强制改密(FORCE_CHANGE_PASSWORD 流程)。 */
export function completeNewPassword(
  user: CognitoUser,
  newPassword: string,
  userAttributes: Record<string, string>,
): Promise<Session> {
  return new Promise((resolve, reject) => {
    user.completeNewPasswordChallenge(newPassword, userAttributes, {
      onSuccess: (cognitoSession) => resolve(sessionFromCognito(cognitoSession, user.getUsername())),
      onFailure: (err) => reject(err),
    });
  });
}

/** 取当前有效会话(刷新 token)。无有效会话 → null。供刷新页面时恢复登录态。 */
export function currentSession(): Promise<Session | null> {
  return new Promise((resolve) => {
    const user = pool().getCurrentUser();
    if (!user) {
      resolve(null);
      return;
    }
    user.getSession((err: Error | null, cognitoSession: CognitoUserSession | null) => {
      if (err || !cognitoSession || !cognitoSession.isValid()) {
        resolve(null);
        return;
      }
      resolve(sessionFromCognito(cognitoSession, user.getUsername()));
    });
  });
}

export function logout(): void {
  const user = pool().getCurrentUser();
  if (user) user.signOut();
}

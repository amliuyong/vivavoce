// API Key 可调端点(tag=integration-api)→ 所需 scope 映射(design contract)。
//
// 为什么要手维护:这些端点用 Header(X-Api-Key) 手动取头,FastAPI **不生成** security
// requirement —— openapi.json 里它们 `security: null`,无法从契约自动推 scope。故这张表是
// 「端点 → scope」的单一事实源,供下载手册标注「调用此端点需要哪个 scope」。
//
// 维护约束:integration.py 新增 API Key 端点时**必须**在此同步一行,否则手册标不出 scope。
// `ApiDocs.tsx` 的手册生成器有完整性自检(每个 integration-api 端点都须在此表命中)。

/** key = `${METHOD} ${path}`(path 用 OpenAPI 模板形式,如 {agent_id})。value = 所需 scope。 */
export const ENDPOINT_SCOPES: Record<string, string> = {
  // 会话(design contract)
  'POST /api/integration/sessions': 'sessions:write',
  'GET /api/integration/sessions/{session_id}': 'sessions:read',
  // 实时会话 join token 签发(design contract:复用 sessions:write,为自己创建的会话签票)
  'GET /api/integration/sessions/{session_id}/join': 'sessions:write',
  // OpenAI Realtime SDK-compatible client secret(design contract)
  'POST /api/integration/sessions/{session_id}/realtime-client-secret': 'sessions:write',
  // Webhook(design contract)
  'POST /api/integration/webhooks': 'webhooks:manage',
  'GET /api/integration/webhooks': 'webhooks:manage',
  'DELETE /api/integration/webhooks/{webhook_id}': 'webhooks:manage',
  // Agent 管理(design contract)
  'GET /api/integration/agents': 'agents:read',
  'POST /api/integration/agents': 'agents:write',
  'GET /api/integration/agents/{agent_id}': 'agents:read',
  'PUT /api/integration/agents/{agent_id}': 'agents:write',
  'DELETE /api/integration/agents/{agent_id}': 'agents:write',
  // 题库管理(design contract)
  'GET /api/integration/question-banks': 'question-banks:read',
  'POST /api/integration/question-banks': 'question-banks:write',
  'GET /api/integration/question-banks/{question_bank_id}': 'question-banks:read',
  'PUT /api/integration/question-banks/{question_bank_id}': 'question-banks:write',
  'DELETE /api/integration/question-banks/{question_bank_id}': 'question-banks:write',
  'POST /api/integration/question-banks/{question_bank_id}/upload-csv': 'question-banks:write',
  // 结果读取(design contract,全局读)
  'GET /api/integration/results/{session_id}': 'results:read',
};

/** 查某端点所需 scope;未登记返回 null(手册生成器据此报缺失)。 */
export function scopeFor(method: string, path: string): string | null {
  return ENDPOINT_SCOPES[`${method.toUpperCase()} ${path}`] ?? null;
}

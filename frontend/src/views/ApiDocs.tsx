'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { t, getLang } from '@/lib/i18n';
import { useLang, useSession } from '@/lib/appState';
import { getConfig } from '@/lib/config';
import { Loading, useToast } from '@/lib/ui';
import { scopeFor } from '@/lib/integrationScopes';

/**
 * API 文档(admin only):基于 backend/openapi.json(构建期同步到 public/openapi.json)。
 *  - tab「快速上手」:API Key / 委托 Token / MCP 三条程序化接入的可复制 curl 走查(对齐 docs/INTEGRATION.md)。
 *  - tab「API 参考」:自写轻量 OpenAPI 渲染器(零第三方库,纯 static export 友好)——按 tag 分组列端点,
 *    展开看参数 / 请求体 schema / 鉴权 / 响应码。
 * admin 二次门控(对齐 VoiceTest);后端各端点仍各自 fail-closed 鉴权,前端门控只是不暴露入口。
 */

type Tab = 'start' | 'reference';

// ── 最小 OpenAPI 类型(只取渲染要用的字段)──
interface OpenAPISchema {
  type?: string;
  $ref?: string;
  title?: string;
  format?: string;
  enum?: unknown[];
  anyOf?: OpenAPISchema[];
  allOf?: OpenAPISchema[];
  items?: OpenAPISchema;
  properties?: Record<string, OpenAPISchema>;
  required?: string[];
  description?: string;
}
interface OpenAPIParam {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: OpenAPISchema;
}
interface OpenAPIOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: OpenAPIParam[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: OpenAPISchema }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: OpenAPISchema }> }>;
  security?: Array<Record<string, string[]>>;
}
interface OpenAPISpec {
  info?: { title?: string; version?: string };
  paths: Record<string, Record<string, OpenAPIOperation>>;
  components?: { schemas?: Record<string, OpenAPISchema> };
}

const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete'];

export function ApiDocs() {
  useLang();
  const session = useSession();
  const [tab, setTab] = useState<Tab>('start');

  if (!session?.isAdmin) {
    return (
      <div className="page">
        <div className="empty-state">{t('admin_only')}</div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('nav_api_docs')}</h1>
          <div className="page-sub">{t('apidoc_sub')}</div>
        </div>
      </div>

      <div className="card card-pad">
        <div className="tabs">
          <div className={'tab' + (tab === 'start' ? ' active' : '')} onClick={() => setTab('start')}>
            {t('apidoc_tab_start')}
          </div>
          <div className={'tab' + (tab === 'reference' ? ' active' : '')} onClick={() => setTab('reference')}>
            {t('apidoc_tab_reference')}
          </div>
        </div>

        {tab === 'start' ? <QuickStart /> : <ApiReference />}
      </div>
    </div>
  );
}

// ───────────────────────── 快速上手 ─────────────────────────
function CodeBlock({ code }: { code: string }) {
  const { toast } = useToast();
  return (
    <div className="apidoc-code">
      <button
        className="apidoc-copy"
        onClick={() => {
          navigator.clipboard?.writeText(code);
          toast(t('ik_copied'));
        }}
      >
        {t('copy')}
      </button>
      <pre>{code}</pre>
    </div>
  );
}

/** 运行时 apiBase 推导(同源相对 /api 用占位;显式绝对 apiBase 直接用真实域名)。 */
function resolveApiBase(): string {
  try {
    const ab = getConfig().apiBase || '/api';
    if (ab.startsWith('http')) return ab.replace(/\/$/, '');
    if (typeof location !== 'undefined') return `${location.origin}/api`;
  } catch {
    /* config 未载 */
  }
  return 'https://<你的-站点-域名>/api';
}

/** 下载 Agent 集成手册(.md):拉 openapi.json → 生成自包含 Markdown → 触发下载。
 *  导出供 Integration(API Key 管理页)复用——同一份手册,与具体 key 无关(全量端点 + scope 标注)。
 *  base 可选:不传则自行推导运行时 apiBase(Integration 页直接 <DownloadHandbookButton /> 即可)。 */
export function DownloadHandbookButton({ base }: { base?: string }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const effectiveBase = base ?? resolveApiBase();

  async function download() {
    setBusy(true);
    try {
      const r = await fetch('/openapi.json', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const spec: OpenAPISpec = await r.json();
      const { md, missingScopes } = buildAgentHandbook(spec, effectiveBase, scopeFor);
      if (missingScopes.length) {
        // 不阻断下载,但提示开发者补映射表(手册里对应端点会标「未登记」)。
        // eslint-disable-next-line no-console
        console.warn('[ApiDocs] 手册缺 scope 映射的端点:', missingScopes);
      }
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'vivavoce-agent-handbook.md';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="apidoc-handbook" style={{ margin: '14px 0' }}>
      <button className="btn btn-primary" onClick={download} disabled={busy}>
        {busy ? t('loading') : t('apidoc_download_handbook')}
      </button>
      <p className="apidoc-note" style={{ marginTop: 8 }}>{t('apidoc_handbook_hint')}</p>
    </div>
  );
}

function QuickStart() {
  // 运行时 apiBase 推导可粘贴的 base(与手册生成器同一份逻辑,见 resolveApiBase)。
  const base = useMemo(() => resolveApiBase(), []);

  return (
    <div className="apidoc-start">
      <p className="apidoc-lead">{t('apidoc_start_lead')}</p>

      <DownloadHandbookButton base={base} />

      {/* 三类凭据速选 */}
      <table className="tbl apidoc-cred-tbl">
        <thead>
          <tr>
            <th>{t('apidoc_cred')}</th>
            <th>{t('apidoc_cred_header')}</th>
            <th>{t('apidoc_cred_who')}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><b>API Key</b></td>
            <td><span className="sip-code">X-Api-Key</span></td>
            <td>{t('apidoc_cred_apikey_who')}</td>
          </tr>
          <tr>
            <td><b>{t('apidoc_cred_deleg')}</b></td>
            <td><span className="sip-code">X-Delegation-Token</span></td>
            <td>{t('apidoc_cred_deleg_who')}</td>
          </tr>
        </tbody>
      </table>

      <h3 className="apidoc-h3">{t('apidoc_s1')}</h3>
      <p>{t('apidoc_s1_desc')}</p>
      <CodeBlock
        code={`curl -X POST ${base}/integration/clients \\
  -H "Authorization: Bearer <admin-cognito-jwt>" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "招聘系统-ATS", "scopes": ["sessions:write", "sessions:read", "webhooks:manage"]}'`}
      />
      <p className="apidoc-note">{t('apidoc_s1_note')}</p>

      <h3 className="apidoc-h3">{t('apidoc_s2')}</h3>
      <p>{t('apidoc_s2_desc')}</p>
      <CodeBlock
        code={`curl -X POST ${base}/integration/sessions \\
  -H "X-Api-Key: aimk_<client_id>_<secret>" \\
  -H "Idempotency-Key: ats-req-20260620-0001" \\
  -H "Content-Type: application/json" \\
  -d '{
    "agent_id": "agent_xxx"
  }'`}
      />
      <p className="apidoc-note">{t('apidoc_s2_note')}</p>

      <h3 className="apidoc-h3">{t('apidoc_s3')}</h3>
      <p>{t('apidoc_s3_desc')}</p>
      <CodeBlock
        code={`# 查自己创建的会话
curl ${base}/integration/sessions/<session_id> \\
  -H "X-Api-Key: aimk_<client_id>_<secret>"`}
      />

      <h3 className="apidoc-h3">{t('apidoc_s4')}</h3>
      <p>{t('apidoc_s4_desc')}</p>
      <CodeBlock
        code={`curl -X POST ${base}/integration/webhooks \\
  -H "X-Api-Key: aimk_<client_id>_<secret>" \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://your-ats.com/aim-callback", "events": ["session.completed", "result.ready"]}'`}
      />
      <p className="apidoc-note">{t('apidoc_s4_note')}</p>

      <h3 className="apidoc-h3">{t('apidoc_s5')}</h3>
      <p>{t('apidoc_s5_desc')}</p>
      <CodeBlock
        code={`# staff 用自己的 Cognito JWT 签发(默认 7 天,最长 30 天)
curl -X POST ${base}/me/delegations \\
  -H "Authorization: Bearer <staff-cognito-jwt>" \\
  -H "Content-Type: application/json" \\
  -d '{"label": "我的日程助理", "ttl_hours": 168}'

# agent 持委托 token 代该员工操作(同 /api/sessions 端点,自动按身份过滤)
curl -X POST ${base}/sessions \\
  -H "X-Delegation-Token: <委托-token>" \\
  -H "Content-Type: application/json" \\
  -d '{"agent_id":"agent_check"}'`}
      />

      <h3 className="apidoc-h3">{t('apidoc_s6')}</h3>
      <p>{t('apidoc_s6_desc')}</p>
      <CodeBlock
        code={`curl -X POST ${base}/mcp \\
  -H "X-Delegation-Token: <委托-token>" \\
  -H "MCP-Protocol-Version: 2025-06-18" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2025-06-18","capabilities":{}}}'`}
      />

      <div className="warn-box" style={{ marginTop: 18 }}>
        <span>ⓘ</span>
        <div>{t('apidoc_start_footer')}</div>
      </div>
    </div>
  );
}

// ───────────────────────── API 参考(自写 OpenAPI 渲染器)─────────────────────────
function ApiReference() {
  const [spec, setSpec] = useState<OpenAPISpec | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    let alive = true;
    fetch('/openapi.json', { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => alive && setSpec(d))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);

  // 按 tag 分组的端点列表(每条 = path + method + operation)
  const groups = useMemo(() => {
    if (!spec) return [];
    const byTag = new Map<string, Array<{ path: string; method: string; op: OpenAPIOperation }>>();
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const method of METHOD_ORDER) {
        const op = ops[method];
        if (!op) continue;
        const needle = q.trim().toLowerCase();
        if (needle && !`${method} ${path} ${op.summary || ''} ${op.description || ''}`.toLowerCase().includes(needle)) {
          continue;
        }
        const tag = op.tags?.[0] || '(other)';
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag)!.push({ path, method, op });
      }
    }
    return [...byTag.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [spec, q]);

  if (err) {
    return <div className="login-err">{t('apidoc_load_err')}: {err}</div>;
  }
  if (!spec) return <Loading label={t('loading')} />;

  return (
    <div className="apidoc-ref">
      <div className="apidoc-ref-head">
        <span className="apidoc-spec-meta">
          {spec.info?.title} <span className="sip-code">{spec.info?.version}</span>
        </span>
        <input
          className="input apidoc-search"
          placeholder={t('apidoc_search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {groups.length === 0 ? (
        <div className="empty-state">{t('empty_list')}</div>
      ) : (
        groups.map(([tag, eps]) => (
          <div key={tag} className="apidoc-tag-group">
            <h3 className="apidoc-tag">{tag} <span className="apidoc-tag-count">{eps.length}</span></h3>
            {eps.map((e) => (
              <Endpoint key={`${e.method}:${e.path}`} path={e.path} method={e.method} op={e.op} schemas={spec.components?.schemas || {}} />
            ))}
          </div>
        ))
      )}
    </div>
  );
}

function Endpoint({
  path,
  method,
  op,
  schemas,
}: {
  path: string;
  method: string;
  op: OpenAPIOperation;
  schemas: Record<string, OpenAPISchema>;
}) {
  const [open, setOpen] = useState(false);
  const reqSchema = op.requestBody?.content?.['application/json']?.schema;
  const okCode = Object.keys(op.responses || {}).find((c) => c.startsWith('2'));
  const okSchema = okCode ? op.responses?.[okCode]?.content?.['application/json']?.schema : undefined;

  return (
    <div className={'apidoc-ep' + (open ? ' open' : '')}>
      <div className="apidoc-ep-row" onClick={() => setOpen((v) => !v)}>
        <span className={`apidoc-method m-${method}`}>{method.toUpperCase()}</span>
        <span className="apidoc-path">{path}</span>
        <span className="apidoc-summary">{op.summary || ''}</span>
        <span className="apidoc-caret">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div className="apidoc-ep-body">
          {op.description && <p className="apidoc-ep-desc">{op.description}</p>}

          {(op.parameters || []).length > 0 && (
            <>
              <div className="apidoc-label">{t('apidoc_params')}</div>
              <table className="tbl apidoc-param-tbl">
                <thead>
                  <tr>
                    <th>{t('apidoc_p_name')}</th>
                    <th>in</th>
                    <th>{t('apidoc_p_type')}</th>
                    <th>{t('apidoc_p_required')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(op.parameters || []).map((p) => (
                    <tr key={`${p.in}:${p.name}`}>
                      <td><span className="sip-code">{p.name}</span></td>
                      <td>{p.in}</td>
                      <td>{schemaTypeStr(p.schema)}</td>
                      <td>{p.required ? t('yes') : t('no')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {reqSchema && (
            <>
              <div className="apidoc-label">{t('apidoc_reqbody')}{op.requestBody?.required ? ' *' : ''}</div>
              <SchemaView schema={reqSchema} schemas={schemas} />
            </>
          )}

          <div className="apidoc-label">{t('apidoc_resp')}</div>
          <div className="apidoc-resp-codes">
            {Object.entries(op.responses || {}).map(([code, r]) => (
              <span key={code} className={'apidoc-resp-code' + (code.startsWith('2') ? ' ok' : '')}>
                {code} {r.description ? `· ${r.description}` : ''}
              </span>
            ))}
          </div>
          {okSchema && <SchemaView schema={okSchema} schemas={schemas} />}
        </div>
      )}
    </div>
  );
}

// 解析 $ref → schema 名;展开对象 properties(只展一层,嵌套 $ref 显示名+可点)
function refName(ref?: string): string | null {
  if (!ref) return null;
  const m = ref.match(/#\/components\/schemas\/(.+)$/);
  return m ? m[1] : null;
}

function schemaTypeStr(s?: OpenAPISchema): string {
  if (!s) return 'any';
  const rn = refName(s.$ref);
  if (rn) return rn;
  if (s.anyOf) {
    // FastAPI 的 Optional → anyOf:[T, null];简化显示
    const parts = s.anyOf.map(schemaTypeStr).filter((x) => x !== 'null');
    return parts.length === 1 ? `${parts[0]}?` : parts.join(' | ');
  }
  if (s.allOf && s.allOf.length) return schemaTypeStr(s.allOf[0]);
  if (s.type === 'array') return `${schemaTypeStr(s.items)}[]`;
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  return s.type || 'object';
}

// ───────────────────────── Agent 集成手册 (.md) 生成器 ─────────────────────────
// 纯函数:输入 openapi spec + 运行时 base,输出一份自包含 Markdown(只含 tag=integration-api 端点)。
// 目标读者是任意 AI agent:读完 + 一把 API Key 即可自主发 HTTP 操作(无需 MCP)。

/** schema → Markdown 字段表(复用 refName/schemaTypeStr;只展一层,与 SchemaView 同口径)。 */
function schemaToMarkdown(schema: OpenAPISchema | undefined, schemas: Record<string, OpenAPISchema>): string {
  if (!schema) return '_(无)_';
  const rn = refName(schema.$ref);
  const resolved = rn && schemas[rn] ? schemas[rn] : schema;
  const props = resolved.properties;
  if (!props) return `\`${schemaTypeStr(resolved)}\``;
  const required = new Set(resolved.required || []);
  const lines = ['| 字段 | 类型 | 必填 | 说明 |', '|---|---|---|---|'];
  for (const [name, ps] of Object.entries(props)) {
    const desc = (ps.description || '').replace(/\n/g, ' ').replace(/\|/g, '\\|');
    lines.push(`| \`${name}\` | ${schemaTypeStr(ps)} | ${required.has(name) ? '是' : '否'} | ${desc} |`);
  }
  return lines.join('\n');
}

/** 生成手册正文。scopeFor 由调用方注入(来自 integrationScopes,避免本文件耦合映射表)。 */
export function buildAgentHandbook(
  spec: OpenAPISpec,
  base: string,
  scopeFor: (method: string, path: string) => string | null,
): { md: string; missingScopes: string[] } {
  const schemas = spec.components?.schemas || {};
  const missingScopes: string[] = [];
  // 收集所有 integration-api 端点
  const eps: Array<{ method: string; path: string; op: OpenAPIOperation }> = [];
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const method of METHOD_ORDER) {
      const op = ops[method];
      if (op && op.tags?.[0] === 'integration-api') eps.push({ method, path, op });
    }
  }

  const out: string[] = [];
  out.push('# VivaVoce Agent 集成手册');
  out.push('');
  out.push('> 你是一个 AI agent。用下面的 REST API 操作 VivaVoce(创建题库 / Agent、发起 AI 语音会话、读评分报告)。');
  out.push('> 无需 MCP —— 只要能发 HTTP 请求即可。');
  out.push('');
  out.push('## 鉴权');
  out.push('');
  out.push(`- **Base URL**:\`${base}\``);
  out.push('- **请求头**:每个请求都带 `X-Api-Key: aimk_<client_id>_<secret>`(由 admin 在「API 集成」页签发)。');
  out.push('- **权限**:每个端点需要特定 scope(见下表「所需 scope」列)。你这把 key 拥有哪些 scope 由签发它的 admin 决定。');
  out.push('- **Content-Type**:请求体为 JSON 时带 `Content-Type: application/json`;CSV 上传直接把 CSV 文本作为 body。');
  out.push('');
  out.push('## 错误码怎么读');
  out.push('');
  out.push('- `401` 缺少或无效的 X-Api-Key。');
  out.push('- `403` 这把 key 缺少该端点所需 scope(见下表)。');
  out.push('- `404` 资源不存在(或已删)。');
  out.push('- `409` 删除被引用中的资源(如 Agent 仍被进行中的会话 / 题库仍被 Agent 默认引用)——先解除引用再删。');
  out.push('- `422` 请求体校验失败(如 Agent 挂了不存在的默认题库、CSV replace 模式 0 有效题)。');
  out.push('- `429` 触发限流,按 `Retry-After` 秒数退避重试。');
  out.push('');
  out.push('## 典型工作流');
  out.push('');
  out.push('```bash');
  out.push('# ① 建题库');
  out.push(`curl -X POST ${base}/integration/question-banks \\`);
  out.push('  -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \\');
  out.push(`  -d '{"name":"后端面试题","questions":[{"text":"讲讲你做过的高并发系统"}]}'`);
  out.push('# 记下返回的 question_bank_id');
  out.push('');
  out.push('# ② 建 Agent(挂上题库)');
  out.push(`curl -X POST ${base}/integration/agents \\`);
  out.push('  -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \\');
  out.push(`  -d '{"name":"后端面试官","system_prompt":"你是资深后端面试官","default_question_bank_id":"<上一步的 id>","rubric":{"mode":"dimension_score","dimensions":[{"name":"技术深度","max_score":5,"weight":1}]}}'`);
  out.push('# 记下返回的 agent_id');
  out.push('');
  out.push('# ③ 发起一场会话(即时开始,创建即可连入)');
  out.push(`curl -X POST ${base}/integration/sessions \\`);
  out.push('  -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \\');
  out.push(`  -d '{"agent_id":"<上一步的 id>"}'`);
  out.push('');
  out.push('# ④ 会话完成后读评分报告');
  out.push(`curl ${base}/integration/results/<session_id> -H "X-Api-Key: $KEY"`);
  out.push('```');
  out.push('');
  out.push('## 端点参考');
  out.push('');

  // 按 path 分组稳定排序
  eps.sort((a, b) => (a.path === b.path ? METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method) : a.path.localeCompare(b.path)));
  for (const { method, path, op } of eps) {
    const scope = scopeFor(method, path);
    if (scope === null) missingScopes.push(`${method.toUpperCase()} ${path}`);
    out.push(`### \`${method.toUpperCase()} ${path}\``);
    out.push('');
    if (op.summary) out.push(op.summary);
    if (op.description) out.push('', op.description.replace(/\n/g, ' '));
    out.push('');
    out.push(`- **所需 scope**:\`${scope || '(未登记 — 请补 integrationScopes.ts)'}\``);
    // path/query 参数
    const params = (op.parameters || []).filter((p) => p.in === 'path' || p.in === 'query');
    if (params.length) {
      out.push(`- **参数**:${params.map((p) => `\`${p.name}\`(${p.in}${p.required ? ', 必填' : ''})`).join('、')}`);
    }
    const reqSchema = op.requestBody?.content?.['application/json']?.schema;
    if (reqSchema) {
      out.push('', '**请求体(JSON)**:', '', schemaToMarkdown(reqSchema, schemas));
    }
    const codes = Object.keys(op.responses || {});
    if (codes.length) out.push('', `- **响应码**:${codes.join(' / ')}`);
    out.push('');
  }

  out.push('---');
  out.push('_本手册由 VivaVoce API 文档页依据当前 OpenAPI 契约自动生成。_');
  return { md: out.join('\n'), missingScopes };
}

function SchemaView({ schema, schemas, depth = 0 }: { schema: OpenAPISchema; schemas: Record<string, OpenAPISchema>; depth?: number }) {
  // 解析:$ref → 取目标 schema;否则就地用
  const resolved = useMemo(() => {
    const rn = refName(schema.$ref);
    return rn && schemas[rn] ? schemas[rn] : schema;
  }, [schema, schemas]);

  const props = resolved.properties;
  if (!props) {
    // 非对象(标量/数组/枚举)→ 一行类型
    return <div className="apidoc-schema-scalar">{schemaTypeStr(resolved)}</div>;
  }
  const required = new Set(resolved.required || []);
  return (
    <table className="tbl apidoc-schema-tbl">
      <thead>
        <tr>
          <th>{t('apidoc_p_name')}</th>
          <th>{t('apidoc_p_type')}</th>
          <th>{t('apidoc_p_required')}</th>
          <th>{t('apidoc_p_desc')}</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(props).map(([name, ps]) => (
          <tr key={name}>
            <td><span className="sip-code">{name}</span></td>
            <td>{schemaTypeStr(ps)}</td>
            <td>{required.has(name) ? t('yes') : t('no')}</td>
            <td style={{ color: 'var(--text-mute)' }}>{ps.description || ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

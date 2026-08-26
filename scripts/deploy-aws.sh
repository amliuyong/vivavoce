#!/usr/bin/env bash
#
# VivaVoce AWS 部署实现。
#
# 公共入口是 `./scripts/viva deploy`;该入口负责加载本地 `.env` 与 `.env.region`,
# 再把非敏感部署参数传给本脚本。
#
# 编排:前置检查 → AWS 凭证/region 校验 → npm ci → CDK bootstrap → cdk deploy(带 context)。
# Global us-east-1 / 中国区 cn-north-1·cn-northwest-1(见下 SUPPORTED_REGIONS),用本地 CDK(不依赖全局安装)。
#
# 用法:
#   ./scripts/deploy-aws.sh -e admin@example.com [-r us-east-1] [-p my-aws-profile]
#                [-s Voce] [--test|--synth-only|--plan-only] [--yes]
#
set -euo pipefail

# ── 默认值 ──
# Global 默认 us-east-1;中国区 cn-north-1 / cn-northwest-1 合法(分区无关红线见 VISION §2)。
AWS_REGION="${CDK_DEFAULT_REGION:-us-east-1}"
AWS_PROFILE=""
ADMIN_EMAIL=""
# 默认栈名。可由 public 配置 `VIVA_STACK_NAME` 经 `scripts/viva` 覆盖。
STACK_NAME="Voce"
ENGINE_TYPE="three_stage" # 只剩 three_stage(Nova s2s 已删,VISION §1;开关留作将来引擎扩展)
ALLOW_NO_APPROVAL="false" # --yes:非交互环境显式批准安全/IAM 放宽部署

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infrastructure"
FRONTEND_DIR="$ROOT_DIR/frontend"
# 入口 = 公网 ALB(REGIONAL WAF,无 CloudFront us-east-1 约束);Global 先只放 us-east-1
# (Bedrock/G6E 就绪的已验 region),中国区 cn-north-1/cn-northwest-1 合法(M2)。
SUPPORTED_REGIONS=("us-east-1" "cn-north-1" "cn-northwest-1")

# ── 颜色输出 ──
c_red()  { printf '\033[31m%s\033[0m\n' "$*"; }
c_grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
step()   { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
die()    { c_red "ERROR: $*"; exit 1; }

usage() {
  cat <<'EOF'
VivaVoce AWS 部署

用法:
  ./scripts/viva deploy
  ./scripts/viva plan
  ./scripts/viva synth

底层调试:
  ./scripts/deploy-aws.sh -e <admin_email> [options]

选项:
  -e <email>           初始 Admin 账号邮箱(必填)
  -r <region>          AWS region(默认 us-east-1;Global 仅 us-east-1,中国区 cn-north-1/cn-northwest-1)
  -p <profile>         AWS CLI profile(可选)
  -s <stack_name>      CloudFormation 栈名(默认 Voce)
  --engine <type>      默认语音引擎(仅 three_stage;s2s 已删除)
  --synth-only         只 synth 校验,不部署(离线可用;未设域名三件套时自动用占位值)
  --plan-only          对线上栈生成账号绑定的 change-set diff,执行安全检查后退出
  --test               跑全部测试(backend/gpu UT+e2e、bridge UT、CDK UT)后退出
  --skip-tests         部署前不跑测试(默认部署前会先跑 CDK UT)
  --yes                显式批准:非交互环境(CI/后台)下放行安全/IAM 放宽变更部署
  -h, --help           显示本帮助
EOF
}

# ── 解析参数 ──
SYNTH_ONLY="false"
PLAN_ONLY="false"
TEST_ONLY="false"
SKIP_TESTS="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -e) ADMIN_EMAIL="$2"; shift 2 ;;
    -r) AWS_REGION="$2"; shift 2 ;;
    -p) AWS_PROFILE="$2"; shift 2 ;;
    -s) STACK_NAME="$2"; shift 2 ;;
    --engine) ENGINE_TYPE="$2"; shift 2 ;;
    --synth-only) SYNTH_ONLY="true"; shift ;;
    --plan-only) PLAN_ONLY="true"; shift ;;
    --test) TEST_ONLY="true"; shift ;;
    --skip-tests) SKIP_TESTS="true"; shift ;;
    --yes) ALLOW_NO_APPROVAL="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1(--help 查看用法)" ;;
  esac
done

[[ -n "$AWS_PROFILE" ]] && export AWS_PROFILE

# ── 测试 runner(backend/gpu Python + bridge/CDK Node)──
run_all_tests() {
  local failed=0

  step "部署脚本静态检查"
  bash -n "$ROOT_DIR/scripts/viva" "$ROOT_DIR"/scripts/*.sh "$ROOT_DIR"/scripts/lib/*.sh \
    || failed=1
  if command -v shellcheck >/dev/null 2>&1; then
    # New deployment entry points are a required gate. Keep legacy scripts out
    # of this gate until their pre-existing warnings are remediated separately.
    shellcheck -e SC1091,SC2006 \
      "$ROOT_DIR/scripts/viva" \
      "$ROOT_DIR/scripts/deploy-aws.sh" \
      "$ROOT_DIR/scripts/deploy-remote.sh" \
      "$ROOT_DIR/scripts/remote-deploy-runner.sh" \
      "$ROOT_DIR/scripts/lib/env.sh" \
      || failed=1
  fi
  python3 "$ROOT_DIR/scripts/test-deployment-plan.py" || failed=1

  # ── Lint gate ────────────────────────────────────────────────────────────────
  #
  # ⚠ 为什么必须放在这里(deployment validation 实证):此前 `--test` **只跑测试不跑 lint**,而 CI 有
  #   backend:ruff / gpu:ruff / bridge:eslint / infrastructure:eslint 四个门禁 job。
  #   于是「本地全绿 → 推上去 CI 红」成了常态(推 upstream 后一次撞到 3 个 lint job 失败)。
  #   本地与 CI 的门禁集合不一致,等于把发现问题的时机推迟到最贵的那一刻。
  #   lint 极快(秒级),没有理由不本地先跑。
  step "lint(ruff / eslint,与 CI 门禁对齐)"
  if command -v python3 >/dev/null 2>&1; then
    for sub in backend gpu; do
      if [[ -d "$ROOT_DIR/$sub/.venv" ]]; then
        ( cd "$ROOT_DIR/$sub" && . .venv/bin/activate \
          && (ruff check -q || { c_red "  $sub:ruff 失败"; exit 1; }) ) || failed=1
      fi
    done
  fi
  # Keep the scope aligned with each package's public lint script:
  # bridge checks `src test`; infrastructure checks `lib bin`.
  #   实测 infra 的 `test/` 里有 4 处 `require()`(配合 jest.resetModules 重载读 env 的模块,
  #   语义上必需)会触发 no-require-imports —— CI 刻意不查 test 才让它通过。
  # Running `eslint .` would include test fixtures that intentionally reload
  # environment-sensitive modules with require().
  for sub in "bridge:src test" "infrastructure:lib bin"; do
    local name="${sub%%:*}" scope="${sub#*:}"
    if [[ -d "$ROOT_DIR/$name/node_modules" ]]; then
      # shellcheck disable=SC2086
      ( cd "$ROOT_DIR/$name" && npx eslint $scope ) \
        || { c_red "  $name:eslint 失败(范围:$scope)"; failed=1; }
    fi
  done
  [[ "$failed" == "0" ]] && c_grn "  lint 通过(或子系统依赖未装,已跳过)"

  step "测试 backend(FastAPI UT + API e2e,带 Cognito JWT 认证)"
  if command -v python3 >/dev/null 2>&1; then
    ( cd "$ROOT_DIR/backend" \
      && python3 -m venv --clear .venv \
      && . .venv/bin/activate \
      && python -m pip install -q -e ".[test]" \
      && python -m pytest -q ) || failed=1
  else
    c_ylw "  跳过:未找到 python3"; failed=1
  fi

  step "测试 gpu(ASR/TTS WS 协议 + VAD + 服务 e2e)"
  if command -v python3 >/dev/null 2>&1; then
    ( cd "$ROOT_DIR/gpu" \
      && python3 -m venv --clear .venv \
      && . .venv/bin/activate \
      && python -m pip install -q -e ".[test]" \
      && python -m pytest -q ) || failed=1
  else
    c_ylw "  跳过:未找到 python3"; failed=1
  fi

  step "测试 bridge(VoiceEngine 编排 + barge-in + 媒体泵顺序)"
  ( cd "$ROOT_DIR/bridge" && npm ci --no-audit --no-fund >/dev/null 2>&1 \
    && npx jest ) || failed=1

  step "测试 frontend(SPA 构建 + i18n key 对齐)"
  if [[ -f "$FRONTEND_DIR/package.json" ]]; then
    ( cd "$FRONTEND_DIR" && npm ci --no-audit --no-fund >/dev/null 2>&1 \
      && npx tsc --noEmit \
      && npm test ) || failed=1
  else
    c_ylw "  跳过:无 frontend";
  fi

  step "测试 infrastructure(CDK UT:2 ECS/ASG/认证/安全边界)"
  # 用 noop docker 跳过真实镜像构建(只验资源属性)
  cat > /tmp/vivavoce-noop-docker.sh <<'NOOP'
#!/bin/bash
case "$1" in inspect) echo 'sha256:0000000000000000000000000000000000000000000000000000000000000000';; *) exit 0;; esac
NOOP
  chmod +x /tmp/vivavoce-noop-docker.sh
  ( cd "$INFRA_DIR" && npm ci --no-audit --no-fund >/dev/null 2>&1 \
    && CDK_DOCKER=/tmp/vivavoce-noop-docker.sh npx jest ) || failed=1

  if [[ "$failed" -ne 0 ]]; then die "测试未全部通过"; fi
  c_grn "
✓ 全部测试通过(backend / gpu / bridge / cdk)。"
}

if [[ "$TEST_ONLY" == "true" ]]; then
  run_all_tests
  exit 0
fi

# ── 1. 前置工具检查 ──
step "1/6 检查前置工具"
command -v node >/dev/null 2>&1 || die "未找到 node(需 Node 20.19+、22.13+ 或 >=24)"
command -v npm  >/dev/null 2>&1 || die "未找到 npm"
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supported = (major === 20 && minor >= 19) || (major === 22 && minor >= 13) || major >= 24;
  process.exit(supported ? 0 : 1);
' || die "Node 版本不受支持($(node -v)),需 Node 20.19+、22.13+ 或 >=24"
c_grn "  node $(node -v) / npm $(npm -v)"
if [[ "$SYNTH_ONLY" != "true" ]]; then
  command -v aws    >/dev/null 2>&1 || die "未找到 aws CLI"
  command -v docker >/dev/null 2>&1 || c_ylw "  ⚠ 未找到 docker:详细设计接真实镜像后部署需要(骨架可跳过)"
fi

# ── 2. region 校验 ──
step "2/6 校验 region"
region_ok="false"
for r in "${SUPPORTED_REGIONS[@]}"; do [[ "$r" == "$AWS_REGION" ]] && region_ok="true"; done
[[ "$region_ok" == "true" ]] || die "不支持的 region '$AWS_REGION'。支持: ${SUPPORTED_REGIONS[*]}(Global us-east-1;中国区见 VISION §2)"
export CDK_DEFAULT_REGION="$AWS_REGION"
c_grn "  region = $AWS_REGION"

# ── 3. 参数校验 ──
step "3/6 校验参数"
[[ "$ENGINE_TYPE" == "three_stage" ]] || die "engine 仅支持 three_stage(s2s 已删除,VISION §1)"
if [[ "$SYNTH_ONLY" != "true" ]]; then
  [[ -n "$ADMIN_EMAIL" ]] || die "缺少 -e <admin_email>(部署必填;或用 --synth-only 跳过)"
  [[ "$ADMIN_EMAIL" == *@*.* ]] || die "admin email 格式不对: $ADMIN_EMAIL"
fi
c_grn "  stack=$STACK_NAME engine=$ENGINE_TYPE"

# ── 4. AWS 凭证(部署时)──
AWS_ACCOUNT=""
if [[ "$SYNTH_ONLY" != "true" ]]; then
  step "4/6 校验 AWS 凭证"
  # ★ 必须带 --region:cn 分区(aws-cn)裸调 sts 会打 aws 分区的 sts.amazonaws.com → InvalidClientTokenId
  #   (分区无关红线 VISION §2;两分区通用)。下面所有 aws 调用同理带 --region。
  aws sts get-caller-identity --region "$AWS_REGION" >/dev/null 2>&1 || die "AWS 凭证无效或未配置(检查 aws configure / -p profile / region)"
  AWS_ACCOUNT="$(aws sts get-caller-identity --region "$AWS_REGION" --query Account --output text)"
  if [[ -n "${AIM_EXPECT_ACCOUNT:-}" && "$AWS_ACCOUNT" != "$AIM_EXPECT_ACCOUNT" ]]; then
    die "当前 AWS account 与 VIVA_EXPECT_ACCOUNT 不一致,拒绝部署"
  fi
  c_grn "  account = $AWS_ACCOUNT"

  # ── GPU 配额预检(design contract 限定 MUST + Task 2.5)──
  # 默认引擎 three_stage 需 G6E GPU(ASR/TTS 自建)。账号若无 g6e vCPU 配额,部署会成功但 GPU ASG 拉不起
  # 实例、默认引擎不可用——MUST fail-fast 提示申请配额,不静默部署出无 GPU 可用的环境。
  # 配额 = Service Quotas「Running On-Demand G and VT instances」(L-DB2E81BA,单位 vCPU)。
  if [[ "$ENGINE_TYPE" == "three_stage" ]]; then
    # 实例类型单一事实源 = infrastructure/lib/common/constants.ts::GPU_INSTANCE_TYPE(env 可覆盖,
    # 两处读同一 env 保持一致);通过 VIVA_GPU_INSTANCE_TYPE 覆盖。
    GPU_INSTANCE_TYPE="${AIM_GPU_INSTANCE_TYPE:-g6e.xlarge}"
    # vCPU 需求按实例类型实查(review:硬编码 4 对 g4dn.2xlarge=8 会误过预检,ASG 起不来)。
    GPU_VCPU_NEEDED="$(aws ec2 describe-instance-types --instance-types "$GPU_INSTANCE_TYPE" \
      --region "$AWS_REGION" --query 'InstanceTypes[0].VCpuInfo.DefaultVCpus' --output text 2>/dev/null || echo "")"
    if [[ -z "$GPU_VCPU_NEEDED" || "$GPU_VCPU_NEEDED" == "None" ]]; then
      GPU_VCPU_NEEDED=8  # 查询失败保守取 8(g4dn.2xlarge 档),宁可提示提额也不误放行
      c_ylw "  ⚠ 无法查询 ${GPU_INSTANCE_TYPE} vCPU 数,保守按 ${GPU_VCPU_NEEDED} 预检"
    fi
    # 非默认实例类型:并发标定提示(GPU_SESSIONS_PER_INSTANCE=3 是 g6e 标定,弱卡须显式降)
    if [[ "$GPU_INSTANCE_TYPE" != "g6e.xlarge" && -z "${AIM_GPU_SESSIONS_PER_INSTANCE:-}" ]]; then
      c_ylw "  ⚠ 非默认 GPU 实例(${GPU_INSTANCE_TYPE}):请在 VIVA_GPU_SESSIONS_PER_INSTANCE 中填写实测并发"
    fi
    gpu_quota="$(aws service-quotas get-service-quota --service-code ec2 \
      --quota-code L-DB2E81BA --region "$AWS_REGION" --query 'Quota.Value' --output text 2>/dev/null || echo "")"
    if [[ -z "$gpu_quota" || "$gpu_quota" == "None" ]]; then
      c_ylw "  ⚠ 无法查询 G/VT GPU vCPU 配额(service-quotas 权限缺失?),跳过预检 —— 部署后请确认 GPU ASG 能拉起"
    else
      # 浮点比较(配额是 float 如 8.0)
      if awk "BEGIN{exit !($gpu_quota < $GPU_VCPU_NEEDED)}"; then
        die "G6E GPU vCPU 配额不足(当前 ${gpu_quota} < 需 ${GPU_VCPU_NEEDED}):默认三段式引擎需 GPU,请先在 Service Quotas 申请「Running On-Demand G and VT instances」提额(≥${GPU_VCPU_NEEDED} vCPU)后重新部署"
      fi
      c_grn "  GPU vCPU 配额 = ${gpu_quota}(需 ${GPU_VCPU_NEEDED},OK)"
    fi

    # AZ 级可用性预检:配额够 ≠ 该 region 当前就卖 g6e。某些 region 仅部分 AZ(或暂时)
    # 不提供 g6e.xlarge —— 部署会成功但 GPU ASG 永远拉不起实例(InsufficientInstanceCapacity)。
    # describe-instance-type-offerings(按 AZ)校验至少一个 AZ 在售;无则 fail-fast。
    # 用 ec2:DescribeInstanceTypeOfferings 权限(与 service-quotas 不同),缺失则告警跳过。
    gpu_az_offerings="$(aws ec2 describe-instance-type-offerings \
      --location-type availability-zone \
      --filters "Name=instance-type,Values=${GPU_INSTANCE_TYPE}" \
      --region "$AWS_REGION" --query 'InstanceTypeOfferings[].Location' --output text 2>/dev/null || echo "__ERR__")"
    if [[ "$gpu_az_offerings" == "__ERR__" ]]; then
      c_ylw "  ⚠ 无法查询 ${GPU_INSTANCE_TYPE} 的 AZ 可用性(ec2:DescribeInstanceTypeOfferings 权限缺失?),跳过 —— 部署后请确认 GPU ASG 能拉起"
    elif [[ -z "$gpu_az_offerings" ]]; then
      die "${GPU_INSTANCE_TYPE} 在 region $AWS_REGION 的任何 AZ 均不可用:换 region 或设置 VIVA_GPU_INSTANCE_TYPE"
    else
      az_count="$(echo "$gpu_az_offerings" | wc -w | tr -d ' ')"
      c_grn "  ${GPU_INSTANCE_TYPE} 可用 AZ 数 = ${az_count}(${gpu_az_offerings})"
    fi
  fi
else
  step "4/6 跳过 AWS 凭证(--synth-only)"
fi

# ── 5. 安装依赖(本地 CDK,不依赖全局)──
step "5/6 安装 infrastructure 依赖"
cd "$INFRA_DIR"
if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
CDK_BIN="$INFRA_DIR/node_modules/.bin/cdk"
[[ -x "$CDK_BIN" ]] || die "本地 cdk 未安装($CDK_BIN);npm install 可能失败"
c_grn "  本地 cdk $("$CDK_BIN" --version)"

# 组装 context 参数(单一来源,synth 与 deploy 共用)
# ★ stackName + account 两者一起构成 Cognito Hosted UI domain 前缀两维(design contract:
#   前缀 = <stackName 小写>-<accountId 后 8 位>,跨账号 region 全局唯一 + 抗同账号双栈冲突)。
#   account 除喂 env.account 外还是 domain 前缀的必需维度,**勿删**(cognito.ts 从 context/env 取)。
CTX=(
  --context "stackName=$STACK_NAME"
  --context "adminEmail=$ADMIN_EMAIL"
  --context "engineType=$ENGINE_TYPE"
  --context "region=$AWS_REGION"
)
[[ -n "$AWS_ACCOUNT" ]] && CTX+=(--context "account=$AWS_ACCOUNT")
# 自定义域名三件套由 .env.region 提供,半配置 fail-fast。
# 域名三件套是 HTTPS 硬前提:**部署必填**(公网 ALB 仅 443,无证书无法部署;
# getUserMedia 要求 secure context)。--synth-only 用占位三件套(离线校验不需真实 zone;
# ACM fromDns + fromHostedZoneAttributes 都不做 synth 期 API 调用)。
if [[ -n "${AIM_CUSTOM_DOMAIN:-}" || -n "${AIM_CUSTOM_DOMAIN_ZONE_ID:-}" || -n "${AIM_CUSTOM_DOMAIN_ZONE_NAME:-}" ]]; then
  if [[ -z "${AIM_CUSTOM_DOMAIN:-}" || -z "${AIM_CUSTOM_DOMAIN_ZONE_ID:-}" || -z "${AIM_CUSTOM_DOMAIN_ZONE_NAME:-}" ]]; then
    die "自定义域名三件套不全:须同时设置 VIVA_CUSTOM_DOMAIN / VIVA_ROUTE53_ZONE_ID / VIVA_ROUTE53_ZONE_NAME"
  fi
elif [[ "$SYNTH_ONLY" == "true" ]]; then
  AIM_CUSTOM_DOMAIN="viva.synth-only.example.com"
  AIM_CUSTOM_DOMAIN_ZONE_ID="Z0SYNTHONLYPLACEHOLDER"
  AIM_CUSTOM_DOMAIN_ZONE_NAME="synth-only.example.com"
  c_ylw "  ⚠ --synth-only 未设域名三件套:使用离线占位值"
else
  die "缺少域名三件套:在 .env.region 设置 VIVA_CUSTOM_DOMAIN / VIVA_ROUTE53_ZONE_ID / VIVA_ROUTE53_ZONE_NAME"
fi
CTX+=(--context "customDomain=$AIM_CUSTOM_DOMAIN"
      --context "customDomainZoneId=$AIM_CUSTOM_DOMAIN_ZONE_ID"
      --context "customDomainZoneName=$AIM_CUSTOM_DOMAIN_ZONE_NAME")
c_grn "  域名:$AIM_CUSTOM_DOMAIN(zone $AIM_CUSTOM_DOMAIN_ZONE_NAME)"
# 外部认证池五件套可选。全给才生效;半配置 fail-fast;全不给则本栈自建 Cognito。
EXT_AUTH_GIVEN=0
for v in "${AIM_AUTH_REGION:-}" "${AIM_AUTH_USER_POOL_ID:-}" "${AIM_AUTH_USER_POOL_CLIENT_ID:-}" \
         "${AIM_AUTH_MCP_CLIENT_ID:-}" "${AIM_AUTH_HOSTED_UI_DOMAIN:-}"; do
  [[ -n "$v" ]] && EXT_AUTH_GIVEN=$((EXT_AUTH_GIVEN + 1))
done
if [[ "$EXT_AUTH_GIVEN" -gt 0 && "$EXT_AUTH_GIVEN" -lt 5 ]]; then
  die "外部认证池五件套不全($EXT_AUTH_GIVEN/5):在 .env.region 中同时设置全部 VIVA_AUTH_* 值,或全部留空"
elif [[ "$EXT_AUTH_GIVEN" -eq 5 ]]; then
  CTX+=(--context "authRegion=$AIM_AUTH_REGION"
        --context "authUserPoolId=$AIM_AUTH_USER_POOL_ID"
        --context "authUserPoolClientId=$AIM_AUTH_USER_POOL_CLIENT_ID"
        --context "authMcpClientId=$AIM_AUTH_MCP_CLIENT_ID"
        --context "authHostedUiDomain=$AIM_AUTH_HOSTED_UI_DOMAIN")
  c_grn "  外部认证池:$AIM_AUTH_USER_POOL_ID(auth region $AIM_AUTH_REGION,本栈不建 Cognito)"
fi
# GPU 镜像 tag:gpu-inference 用 ECR aim-gpu:<tag>(CUDA + 真 FunASR ASR + 真 OmniVoice TTS,权重内置)。
#  - 显式 AIM_GPU_IMAGE_TAG=<tag>:钉某个版本(可复现/回滚);
#  - 未设:**自动取 ECR aim-gpu 最新 tag**(按推送时间)——默认就是真语音 + 最新,绝不静默降级到旧版/stub。
#    (历史坑:默认退 stub + 靠人手抄 tag,导致照抄旧 v4 把线上降级、已修 bug 复现。根治:默认查最新真镜像。)
#  - 仅当 ECR aim-gpu 一个镜像都没有(从没构建过)才退 stub,并显著警告。
# ★ --synth-only 跳过 ECR 查询(review):synth-only 文档承诺「不需 AWS 凭证」,但 ECR 查询失败已改
#   fail-fast(不再 `|| true` 容忍)——无 AWS CLI/凭证/网络的纯本地 synth 校验会被 die 切断。synth 不消费
#   gpuImageTag(只产 CloudFormation),故 synth-only 直接留空跳过查询。fail-fast 仅对真正 deploy 路径生效。
if [[ -z "${AIM_GPU_IMAGE_TAG:-}" && "$SYNTH_ONLY" != "true" ]]; then
  c_grn "  未设 AIM_GPU_IMAGE_TAG —— 自动查 ECR aim-gpu 最新真实镜像…"
  # ★ 区分三类结果(review)——此前 `2>/dev/null || true` 把
  #   (a) repo 存在但 0 镜像(预期 stub fallback)/ (b) 无 ecr:DescribeImages 权限 / (c) CLI 缺/区域错/网络挂
  #   合并成「无镜像」静默退 stub,运维以为部署的是真模型(与「绝不静默降级」相悖)。这里捕获 stderr +
  #   exit code:仅 RepositoryNotFoundException / 空列表才是合法 stub 分支;其它 AWS 错 fail-fast 打原始 stderr。
  ECR_ERR=$(mktemp)
  if AIM_GPU_IMAGE_TAG=$(aws ecr describe-images --repository-name aim-gpu \
      --region "$AWS_REGION" ${AWS_PROFILE:+--profile "$AWS_PROFILE"} \
      --query 'sort_by(imageDetails,&imagePushedAt)[-1].imageTags[0]' --output text 2>"$ECR_ERR"); then
    [[ "$AIM_GPU_IMAGE_TAG" == "None" ]] && AIM_GPU_IMAGE_TAG=""  # repo 存在但 0 镜像 → 合法 stub 分支
  elif grep -q "RepositoryNotFoundException" "$ECR_ERR"; then
    AIM_GPU_IMAGE_TAG=""  # repo 从没建过(从没构建过镜像)→ 合法 stub 分支
  else
    # 权限/CLI/网络错:**不**静默退 stub(否则误部署假语音),fail-fast 打原始 stderr。
    cat "$ECR_ERR" >&2
    rm -f "$ECR_ERR"
    die "查询 ECR aim-gpu 失败(非「无镜像」——疑权限/CLI/网络)。修好或显式设 AIM_GPU_IMAGE_TAG=<tag> 再部署。"
  fi
  rm -f "$ECR_ERR"
fi
if [[ -n "${AIM_GPU_IMAGE_TAG:-}" ]]; then
  CTX+=(--context "gpuImageTag=$AIM_GPU_IMAGE_TAG")
  c_grn "  GPU 用真实模型镜像 aim-gpu:$AIM_GPU_IMAGE_TAG(真 ASR/TTS)"
  # 注:取「最近推送 manifest 的首个 tag」——若 build-gpu-image.sh 推送后校验失败留下半成品,或 tag 被重推
  #     导致 imageTags[0] 拿到陈旧 sibling tag,可能选到未验证镜像(review)。
  #     复现/回滚或要确定性,显式 AIM_GPU_IMAGE_TAG=<tag> 钉版本。
else
  printf '\033[33m  ⚠ ECR aim-gpu 无可用镜像(repo 不存在或 0 镜像)—— GPU 将跑 stub 假语音(非真模型)。\033[0m\n'
  printf '\033[33m    要真语音(默认三段式引擎),按顺序补齐:\033[0m\n'
  printf '\033[33m      1) 备权重到本账号桶 aim-model-weights-%s-%s:\033[0m\n' "${AWS_ACCOUNT:-<账号>}" "$AWS_REGION"
  printf '\033[33m         在 .env 设置 VIVA_MODEL_WEIGHTS_DIR 或 VIVA_MODEL_WEIGHTS_URL,然后运行 ./scripts/viva models\033[0m\n'
  printf '\033[33m      2) 构建并推 ECR:./scripts/viva gpu-image -t <tag>\033[0m\n'
  printf '\033[33m      3) 重新部署本脚本。\033[0m\n'
fi

# ── 6. synth / plan / bootstrap / deploy ──
if [[ "$SYNTH_ONLY" == "true" ]]; then
  step "6/6 synth 校验(不部署)"
  "$CDK_BIN" synth "$STACK_NAME" "${CTX[@]}" --quiet
  c_grn "✓ synth 通过(骨架)。去掉 --synth-only 即可部署。"
  exit 0
fi

if [[ "$PLAN_ONLY" == "true" ]]; then
  step "6/6 生成账号绑定的部署 plan"
  PLAN_DIR="${VIVA_PLAN_DIR:-$(dirname "$ROOT_DIR")/.vivavoce-plans/$(basename "$ROOT_DIR")}"
  [[ "$PLAN_DIR" == /* ]] || die "VIVA_PLAN_DIR 必须是绝对路径"
  PLAN_DIR="$(realpath -m "$PLAN_DIR")"
  case "$PLAN_DIR/" in
    "$ROOT_DIR/"*)
      die "VIVA_PLAN_DIR 必须位于源码树之外,避免 CDK asset 递归复制 plan"
      ;;
  esac
  mkdir -p "$PLAN_DIR"
  chmod 700 "$PLAN_DIR"
  find "$PLAN_DIR" -mindepth 1 -depth -delete
  mkdir -m 700 "$PLAN_DIR/cdk.out"

  if ! "$CDK_BIN" synth "$STACK_NAME" "${CTX[@]}" \
      --output "$PLAN_DIR/cdk.out" \
      --quiet \
      >"$PLAN_DIR/synth.log" 2>&1; then
    c_red "CDK synth 失败,脱敏日志尾部:"
    tail -n 40 "$PLAN_DIR/synth.log" \
      | sed -E \
          -e 's/[0-9]{12}/<account>/g' \
          -e 's#https?://[^[:space:]]+#<url>#g' \
          -e 's/[[:alnum:]._%+-]+@[[:alnum:].-]+/<email>/g' >&2
    exit 1
  fi

  if aws cloudformation describe-stacks \
      --region "$AWS_REGION" \
      --stack-name "$STACK_NAME" >/dev/null 2>&1; then
    aws cloudformation get-template \
      --region "$AWS_REGION" \
      --stack-name "$STACK_NAME" \
      --template-stage Processed \
      --query TemplateBody \
      --output json \
      >"$PLAN_DIR/current-template.json"
  else
    [[ "${VIVA_PLAN_REQUIRE_EXISTING_STACK:-0}" != "1" ]] \
      || die "线上栈 $STACK_NAME 不存在,拒绝把远程更新误变成新建"
    printf '{"Resources":{}}\n' >"$PLAN_DIR/current-template.json"
  fi

  if ! "$CDK_BIN" diff \
      --app "$PLAN_DIR/cdk.out" \
      "$STACK_NAME" \
      --change-set \
      --no-color \
      >"$PLAN_DIR/cdk-diff.log" 2>&1; then
    c_red "CDK diff 失败,脱敏日志尾部:"
    tail -n 40 "$PLAN_DIR/cdk-diff.log" \
      | sed -E \
          -e 's/[0-9]{12}/<account>/g' \
          -e 's#https?://[^[:space:]]+#<url>#g' \
          -e 's/[[:alnum:]._%+-]+@[[:alnum:].-]+/<email>/g' >&2
    exit 1
  fi

  plan_args=(
    --current "$PLAN_DIR/current-template.json"
    --proposed "$PLAN_DIR/cdk.out/${STACK_NAME}.template.json"
    --cdk-diff "$PLAN_DIR/cdk-diff.log"
    --summary "$PLAN_DIR/summary.json"
    --preserve-env-key AIM_CURSOR_VOICED_GATE
    --preserve-env-key AIM_BARGE_OPEN_COOLDOWN_MS
    --preserve-env-key AIM_BARGE_OPEN_COOLDOWN_MULT
  )
  [[ "${VIVA_PLAN_ALLOW_DESTRUCTIVE:-0}" == "1" ]] \
    && plan_args+=(--allow-destructive)
  [[ "${VIVA_PLAN_ALLOW_SECURITY_CHANGES:-0}" == "1" ]] \
    && plan_args+=(--allow-security-changes)
  python3 "$ROOT_DIR/scripts/check-deployment-plan.py" "${plan_args[@]}"
  chmod 600 "$PLAN_DIR"/*.json "$PLAN_DIR"/*.log
  c_grn "✓ 部署 plan 通过。摘要:$PLAN_DIR/summary.json"
  exit 0
fi

# 部署前跑 CDK UT(除非 --skip-tests),不让坏栈进 deploy
if [[ "$SKIP_TESTS" != "true" ]]; then
  step "部署前自检:CDK UT"
  cat > /tmp/vivavoce-noop-docker.sh <<'NOOP'
#!/bin/bash
case "$1" in inspect) echo 'sha256:0000000000000000000000000000000000000000000000000000000000000000';; *) exit 0;; esac
NOOP
  chmod +x /tmp/vivavoce-noop-docker.sh
  CDK_DOCKER=/tmp/vivavoce-noop-docker.sh npx jest || die "CDK UT 未通过,中止部署(--skip-tests 可跳过)"
fi

# 前端静态导出(去 CloudFront 后由 backend 镜像多阶段构建烘入并托管;此处预构建仅作
# 本地快速校验——真正进镜像的构建发生在 docker build 的 node 阶段)
if [[ -f "$FRONTEND_DIR/package.json" ]]; then
  step "构建前端 SPA(Next.js 静态导出 → frontend/out/)"
  ( cd "$FRONTEND_DIR" \
    && { [[ -f package-lock.json ]] && npm ci --no-audit --no-fund || npm install --no-audit --no-fund; } \
    && npm run build ) || die "前端构建失败"
  [[ -f "$FRONTEND_DIR/out/index.html" ]] || die "前端产物缺失(frontend/out/index.html)"
  c_grn "  前端产物就绪:frontend/out/"
fi

step "6/6 bootstrap + 部署(构建 backend/gpu/bridge 镜像并推 ECR)"
"$CDK_BIN" bootstrap "aws://$AWS_ACCOUNT/$AWS_REGION" "${CTX[@]}"
# 审批模式:有 TTY → 交互确认安全/IAM 放宽(broadening)。
# 无 TTY(CI/后台)→ 必须 --yes 显式 opt-in 才放行(never),否则失败,
# 避免安全敏感变更在无人确认下被悄悄部署(--skip-tests 也不应绕过此门)。
if [[ -t 0 ]]; then
  APPROVAL="broadening"
elif [[ "$ALLOW_NO_APPROVAL" == "true" ]]; then
  APPROVAL="never"
else
  die "非交互环境部署需显式批准:加 --yes 确认放行安全/IAM 放宽变更(或在 TTY 下运行交互确认)"
fi
"$CDK_BIN" deploy "$STACK_NAME" "${CTX[@]}" --require-approval "$APPROVAL"

c_grn "
✓ VivaVoce 部署完成。
  栈名:    $STACK_NAME
  region:  $AWS_REGION
  account: $AWS_ACCOUNT

镜像:backend(FastAPI API)/ gpu(ASR+TTS)/ bridge(媒体面)已由 CDK 自动构建并推 ECR。
卸载请使用同一组 `.env` / `.env.region` 参数执行 CDK destroy。
"

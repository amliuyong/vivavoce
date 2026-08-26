import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

/**
 * 可观测性(D-3):把 bridge EMF per-turn 指标(AIM/Realtime 命名空间)+ ALB 指标聚合成
 * 基线告警 + 总览 Dashboard。此前全栈仅 reconciler 心跳一个告警,生产延迟/失败率不可见、不可告警。
 *
 * 数据来源:
 *  - bridge turn-metrics.ts 的 EMF 输出(CloudWatch Logs 自动提取)→ AIM/Realtime:LLM、首声、
 *    TTS RTF、停声分段、失败率及 provider/cache/concurrency 维度。
 *  - ALB 自带指标(HTTPCode_ELB_5XX_Count / TargetResponseTime / UnHealthyHostCount)。
 * 告警发到共享 alarmTopic(与 reconciler 同一 SNS,运维订阅一处)。
 */
export interface ObservabilityProps {
  stackName: string;
  alarmTopic: sns.ITopic;           // 复用 reconciler 的告警通道
  backendAlb: elbv2.ApplicationLoadBalancer;
}

const RT_NS = 'AIM/Realtime';

export class Observability extends Construct {
  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id);

    const period = cdk.Duration.minutes(5);
    const m = (metricName: string, statistic: string, label?: string) =>
      new cloudwatch.Metric({ namespace: RT_NS, metricName, statistic, period, label });
    const quantiles = (metricName: string, label: string) =>
      ['p50', 'p95', 'p99'].map((statistic) =>
        m(metricName, statistic, `${label} ${statistic}`));
    const dimensionQuantiles = (metricName: string) =>
      ['p50', 'p95', 'p99'].map((statistic) =>
        new cloudwatch.SearchExpression({
          expression:
            `SEARCH('{${RT_NS},tts_provider,cache_state,concurrency_bucket} ` +
            `MetricName="${metricName}"', '${statistic}', 300)`,
          label: `${metricName} ${statistic}`,
          period,
        }));

    // ── per-turn 延迟指标(EMF)──
    const llmTtftP95 = m('llm_ttft_ms', 'p95');
    const ttsTtfbP95 = m('tts_ttfb_ms', 'p95');
    const asrFinalP95 = m('asr_final_delay_ms', 'p95');
    const turns = m('turns', 'Sum');
    const llmFailed = m('llm_failed', 'Sum');
    const ttsTimeout = m('tts_timeout', 'Sum');
    const bargeIn = m('barge_in', 'Sum');
    const firstSoundLatencyMetricNames = [
      'llm_ttft_ms',
      'sentence_ready_ms',
      'provider_start_to_first_send_ms',
      'bridge_first_receive_ms',
      'e2e_latency_ms',
      'marker_to_first_binary_ms',
      'first_binary_to_first_render_ms',
      'marker_to_first_render_ms',
      'cold_preroll_ms',
    ];
    const firstSound = firstSoundLatencyMetricNames.flatMap((metricName) =>
      quantiles(metricName, metricName));
    const firstSoundDimensions = firstSoundLatencyMetricNames.flatMap((metricName) =>
      dimensionQuantiles(metricName));
    const firstRenderUnderruns = quantiles(
      'underruns_before_first_render',
      'underruns_before_first_render',
    );
    const firstRenderUnderrunDimensions = dimensionQuantiles(
      'underruns_before_first_render',
    );
    const ttsRtf = quantiles('tts_rtf', 'TTS RTF');
    const evidenceToPause = quantiles('barge_evidence_to_pause_ms', 'evidence→pause');
    const pauseToConfirm = quantiles('pause_to_confirm_ms', 'pause→confirm');
    const pauseToSilence = quantiles(
      'pause_to_first_silent_render_ms',
      'pause→first silent render',
    );
    const confirmToFlush = quantiles('confirm_to_worklet_flush_ms', 'confirm→flush');
    const cancelToCompute = quantiles('cancel_to_last_model_compute_ms', 'cancel→last compute');
    const cancelToSend = quantiles('cancel_to_last_gpu_send_ms', 'cancel→last GPU send');
    const interruptionMetricNames = [
      'barge_evidence_to_pause_ms',
      'pause_to_confirm_ms',
      'pause_to_first_silent_render_ms',
      'confirm_to_worklet_flush_ms',
      'cancel_to_last_model_compute_ms',
      'cancel_to_last_gpu_send_ms',
      'browser_ring_depth_at_confirm_ms',
      'browser_ring_depth_before_flush_ms',
      'browser_ring_depth_after_flush_ms',
    ];
    const interruptionDimensions = interruptionMetricNames.flatMap(
      (metricName) => dimensionQuantiles(metricName),
    );
    const ringDepth = [
      'browser_ring_depth_at_confirm_ms',
      'browser_ring_depth_before_flush_ms',
      'browser_ring_depth_after_flush_ms',
    ].flatMap((metricName) => quantiles(metricName, metricName));

    // LLM 失败率 = llm_failed / turns(math expression;turns=0 时无数据不误报)。
    const llmFailRate = new cloudwatch.MathExpression({
      expression: 'IF(t > 0, 100 * f / t, 0)',
      usingMetrics: { f: llmFailed, t: turns },
      label: 'LLM 本轮失败率(%)',
      period,
    });

    // ── 告警 ──
    const alarmAction = new cwActions.SnsAction(props.alarmTopic);

    // 1. LLM 失败率过高(跨境 LLM 抖动/配额/降级频发)——降级不拆机但失败率飙升需运维介入(换模型/查配额)。
    const llmFailAlarm = new cloudwatch.Alarm(this, 'LlmFailRateAlarm', {
      alarmName: `${props.stackName}-llm-fail-rate-high`,
      alarmDescription: 'LLM 本轮失败率 >20%(近 15min):跨境 LLM 抖动/配额/降级频发,查 mantle 或换国内模型',
      metric: llmFailRate,
      threshold: 20,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3, // 3×5min 持续才告警,避免偶发抖动误报
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, // 无对话(turns=0)不告警
    });
    llmFailAlarm.addAlarmAction(alarmAction);

    // 2. LLM 首 token p95 过高(跨境链路劣化,体验下滑)。
    const llmSlowAlarm = new cloudwatch.Alarm(this, 'LlmTtftSlowAlarm', {
      alarmName: `${props.stackName}-llm-ttft-slow`,
      alarmDescription: 'LLM 首 token p95 >5s(近 15min):跨境链路劣化,首声延迟明显',
      metric: llmTtftP95,
      threshold: 5000,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    llmSlowAlarm.addAlarmAction(alarmAction);

    // 3. backend ALB 5xx(控制面异常)。
    const alb5xx = props.backendAlb.metrics.httpCodeElb(
      elbv2.HttpCodeElb.ELB_5XX_COUNT, { period, statistic: 'Sum' });
    const alb5xxAlarm = new cloudwatch.Alarm(this, 'BackendAlb5xxAlarm', {
      alarmName: `${props.stackName}-backend-alb-5xx`,
      alarmDescription: 'backend ALB 5xx >10(近 5min):控制面异常',
      metric: alb5xx,
      threshold: 10,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alb5xxAlarm.addAlarmAction(alarmAction);

    // ── 总览 Dashboard ──
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${props.stackName}-overview`,
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: '实时链路延迟 p95(ms)',
        left: [llmTtftP95, ttsTtfbP95, asrFinalP95],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: '首声分段 p50 / p95 / p99(ms)',
        left: firstSound,
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: '首渲染前 underrun p50 / p95 / p99(次)',
        left: firstRenderUnderruns,
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'TTS 稳态 RTF p50 / p95 / p99',
        left: ttsRtf,
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Bridge 打断判定 p50 / p95 / p99(ms)',
        left: [...evidenceToPause, ...pauseToConfirm],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: '浏览器暂停 / 确认停声 p50 / p95 / p99(ms)',
        left: [...pauseToSilence, ...confirmToFlush],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'GPU 取消尾延迟 p50 / p95 / p99(ms)',
        left: [...cancelToCompute, ...cancelToSend],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: '浏览器打断时 ring depth p50 / p95 / p99(ms)',
        left: ringDepth,
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: '首声时延分段按 provider / cache / 并发档',
        left: firstSoundDimensions,
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: '首渲染前 underrun 按 provider / cache / 并发档',
        left: firstRenderUnderrunDimensions,
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'RTF 按 provider / cache / 并发档',
        left: dimensionQuantiles('tts_rtf'),
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: '全部停声分段按 provider / cache / 并发档',
        left: interruptionDimensions,
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: '对话量 / 失败 / 打断(每 5min)',
        left: [turns, llmFailed, ttsTimeout, bargeIn],
        width: 12,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'LLM 失败率(%)',
        metrics: [llmFailRate],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'backend ALB',
        left: [alb5xx, props.backendAlb.metrics.targetResponseTime({ period, statistic: 'p95' })],
        width: 16,
      }),
    );
  }
}

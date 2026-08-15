import type { AlertEvent, AlertLevel, AlertMetric, AlertScope, NotificationChannel } from "./types.js";
import { alertMetricLabel } from "./service.js";

export interface AlertNotificationPayload {
  event: "alert.fired" | "alert.resolved";
  title: string;
  message: string;
  level: AlertLevel;
  scope: AlertScope;
  metric: AlertMetric;
  metricLabel: string;
  targetName: string;
  value?: number;
  threshold: number;
  firedAt: string;
  resolvedAt?: string;
}

export interface AlertDeliveryResult {
  ok: boolean;
  error?: string;
}

export const buildAlertPayload = (event: AlertEvent): AlertNotificationPayload => {
  const scopeLabel = event.scope === "node" ? "节点" : "实例";
  const metricLabel = alertMetricLabel(event.metric);
  const action = event.status === "firing" ? "触发" : "恢复";
  const valueText = event.metric === "offline" ? `${event.value} 秒` : `${event.value.toFixed(1)}%`;
  const title =
    event.status === "firing"
      ? `[${event.level === "critical" ? "严重" : "警告"}] ${event.ruleName}`
      : `${event.ruleName} 已恢复`;
  const message =
    event.status === "firing"
      ? `${scopeLabel}「${event.targetName}」的 ${metricLabel} 达到 ${valueText}，超过阈值 ${event.threshold}（${event.threshold}${event.metric === "offline" ? " 秒" : "%"}）。`
      : `${scopeLabel}「${event.targetName}」的 ${metricLabel} 已回落至阈值以下，告警解除。`;
  return {
    event: event.status === "firing" ? "alert.fired" : "alert.resolved",
    title,
    message,
    level: event.level,
    scope: event.scope,
    metric: event.metric,
    metricLabel,
    targetName: event.targetName,
    value: event.value,
    threshold: event.threshold,
    firedAt: event.firedAt,
    resolvedAt: event.resolvedAt
  };
};

interface ChannelRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export const buildChannelRequest = (channel: NotificationChannel, payload: AlertNotificationPayload): ChannelRequest | undefined => {
  const markdown = `### ${payload.title}\n\n${payload.message}\n\n- 对象：${payload.scope === "node" ? "节点" : "实例"}「${payload.targetName}」\n- 指标：${payload.metricLabel}\n- 等级：${payload.level === "critical" ? "严重" : "警告"}\n- 触发时间：${payload.firedAt}`;
  switch (channel.type) {
    case "webhook":
      if (!channel.url) return undefined;
      return { url: channel.url, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
    case "dingtalk":
      if (!channel.url) return undefined;
      return {
        url: channel.url,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msgtype: "markdown", markdown: { title: payload.title, text: `${markdown}\n\n[MicoPanel 控制面]` } })
      };
    case "wecom":
      if (!channel.url) return undefined;
      return {
        url: channel.url,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msgtype: "markdown", markdown: { content: markdown } })
      };
    case "serverchan":
      if (!channel.secret) return undefined;
      return {
        url: `https://sctapi.ftqq.com/${encodeURIComponent(channel.secret)}.send`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ title: payload.title, desp: payload.message }).toString()
      };
  }
};

const DELIVERY_TIMEOUT_MS = 20_000;

export type AlertDeliverer = (channel: NotificationChannel, payload: AlertNotificationPayload) => Promise<AlertDeliveryResult>;

export const deliverNotification: AlertDeliverer = async (channel, payload) => {
  const request = buildChannelRequest(channel, payload);
  if (!request) return { ok: false, error: "渠道配置不完整" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const response = await fetch(request.url, { method: "POST", headers: request.headers, body: request.body, signal: controller.signal });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "投递失败" };
  } finally {
    clearTimeout(timer);
  }
};

export const TEST_ALERT_PAYLOAD: AlertNotificationPayload = {
  event: "alert.fired",
  title: "MicoPanel 通知测试",
  message: "这是一条测试通知：如果你的运维群能收到这条消息，说明告警通知链路已就绪。",
  level: "warning",
  scope: "node",
  metric: "cpu",
  metricLabel: "CPU 使用率",
  targetName: "所有节点",
  value: 0,
  threshold: 90,
  firedAt: new Date().toISOString()
};

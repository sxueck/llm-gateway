<template>
  <div class="agent-run-detail-view">
    <div class="page-header">
      <div class="header-main">
        <n-button size="small" quaternary circle @click="goBack">
          <template #icon><n-icon><ArrowBackOutline /></n-icon></template>
        </n-button>
        <div class="header-title">
          <div class="title-row">
            <h1 class="page-title">{{ t("agentRunDetail.title") }}</h1>
            <code class="run-id">{{ runId }}</code>
            <n-tag v-if="run" :type="statusTypes[run.status]" :bordered="false">
              {{ t(`workerMonitoring.status.${run.status}`) }}
            </n-tag>
          </div>
          <p v-if="run" class="page-subtitle">
            <code>{{ run.plugin.id }}@{{ run.plugin.version }}</code>
            · {{ run.model_profile }}
            · {{ run.source.type === "snapshot" ? "snapshot" : "public git" }}
          </p>
        </div>
      </div>
      <n-space align="center">
        <span v-if="isActive" class="refresh-badge"
          ><span class="refresh-dot" />{{ t("agentRunDetail.liveBadge") }}</span
        >
        <n-button size="small" :loading="loading" @click="load">
          <template #icon
            ><n-icon><RefreshOutline /></n-icon
          ></template>
          {{ t("common.refresh") }}
        </n-button>
      </n-space>
    </div>

    <n-alert
      v-if="run?.error"
      type="error"
      :title="run.error.code"
      class="error-alert"
    >
      {{ run.error.message || "—" }}
    </n-alert>

    <div class="stat-panel">
      <div v-for="item in summaryItems" :key="item.label" class="stat-cell">
        <div class="stat-label">
          <span v-if="item.tone" class="stat-dot" :class="item.tone" />{{
            item.label
          }}
        </div>
        <div class="stat-value">{{ item.value }}</div>
      </div>
    </div>

    <div class="body-grid">
      <div class="side-column">
        <n-card class="flat-card" :title="t('agentRunDetail.lifecycle')">
          <n-timeline>
            <n-timeline-item
              v-for="step in lifecycleSteps"
              :key="step.key"
              :type="step.type"
              :title="step.title"
              :content="step.time"
              :line-type="step.pending ? 'dashed' : 'default'"
            />
          </n-timeline>
        </n-card>

        <n-card
          v-if="run"
          class="flat-card"
          :title="t('agentRunDetail.meta')"
        >
          <n-descriptions label-placement="left" :column="1" size="small">
            <n-descriptions-item
              :label="t('agentRunDetail.metaFields.plugin')"
            >
              <code>{{ run.plugin.id }}@{{ run.plugin.version }}</code>
            </n-descriptions-item>
            <n-descriptions-item
              :label="t('agentRunDetail.metaFields.digest')"
            >
              <code class="digest">{{ run.plugin.digest }}</code>
            </n-descriptions-item>
            <n-descriptions-item
              :label="t('agentRunDetail.metaFields.sourceType')"
            >
              {{ run.source.type }}
            </n-descriptions-item>
            <n-descriptions-item
              v-if="run.source.snapshot_id"
              :label="t('agentRunDetail.metaFields.snapshot')"
            >
              <code>{{ run.source.snapshot_id }}</code>
            </n-descriptions-item>
            <n-descriptions-item
              v-if="run.source.requested_ref"
              :label="t('agentRunDetail.metaFields.requestedRef')"
            >
              <code>{{ run.source.requested_ref }}</code>
            </n-descriptions-item>
            <n-descriptions-item
              v-if="run.source.commit"
              :label="t('agentRunDetail.metaFields.commit')"
            >
              <code>{{ run.source.commit }}</code>
            </n-descriptions-item>
            <n-descriptions-item
              :label="t('agentRunDetail.metaFields.modelProfile')"
            >
              <code>{{ run.model_profile }}</code>
            </n-descriptions-item>
            <n-descriptions-item
              :label="t('agentRunDetail.metaFields.user')"
            >
              {{ run.user_id }}
            </n-descriptions-item>
            <n-descriptions-item
              :label="t('agentRunDetail.metaFields.virtualKey')"
            >
              {{ run.virtual_key_id }}
            </n-descriptions-item>
            <n-descriptions-item
              :label="t('agentRunDetail.metaFields.createdAt')"
            >
              {{ formatTime(run.created_at) }}
            </n-descriptions-item>
            <n-descriptions-item
              v-if="run.started_at"
              :label="t('agentRunDetail.metaFields.startedAt')"
            >
              {{ formatTime(run.started_at) }}
            </n-descriptions-item>
            <n-descriptions-item
              v-if="run.completed_at"
              :label="t('agentRunDetail.metaFields.completedAt')"
            >
              {{ formatTime(run.completed_at) }}
            </n-descriptions-item>
            <n-descriptions-item
              v-if="run.cancellation_requested_at"
              :label="t('agentRunDetail.metaFields.cancelRequestedAt')"
            >
              {{ formatTime(run.cancellation_requested_at) }}
            </n-descriptions-item>
            <n-descriptions-item
              :label="t('agentRunDetail.metaFields.expiresAt')"
            >
              {{ formatTime(run.expires_at) }}
            </n-descriptions-item>
          </n-descriptions>
        </n-card>
      </div>

      <n-card class="flat-card events-card" :title="t('agentRunDetail.events')">
        <template #header-extra>
          <n-tag v-if="detail?.events_truncated" type="warning" :bordered="false">
            {{
              t("agentRunDetail.eventsTruncated", {
                max: detail?.events.length ?? 0,
              })
            }}
          </n-tag>
        </template>
        <n-empty
          v-if="detail && detail.events.length === 0"
          :description="t('agentRunDetail.eventsEmpty')"
          class="events-empty"
        />
        <div v-else class="event-list">
          <div
            v-for="event in detail?.events ?? []"
            :key="event.seq"
            class="event-row"
          >
            <span class="event-dot" :class="eventDotClass(event.type)" />
            <div class="event-body">
              <div class="event-head">
                <code class="event-seq">#{{ event.seq }}</code>
                <n-tag
                  size="small"
                  :bordered="false"
                  :type="eventTagType(event.type)"
                >
                  {{ event.type }}
                </n-tag>
                <span class="event-summary">{{ eventSummary(event) }}</span>
                <span class="event-time">
                  {{ formatEventTime(event.created_at) }}
                </span>
              </div>
              <n-collapse class="event-payload">
                <n-collapse-item
                  :title="t('agentRunDetail.payload')"
                  :name="event.seq"
                >
                  <pre class="payload-json">{{
                    JSON.stringify(event.payload, null, 2)
                  }}</pre>
                </n-collapse-item>
              </n-collapse>
            </div>
          </div>
        </div>
      </n-card>
    </div>

    <n-card
      class="flat-card related-card"
      :title="t('agentRunDetail.relatedRequests')"
    >
      <template #header-extra>
        <span class="related-count">{{ relatedTotal }}</span>
      </template>
      <n-empty
        v-if="relatedRequests.length === 0 && !relatedLoading"
        :description="t('agentRunDetail.relatedRequestsEmpty')"
        class="events-empty"
      />
      <n-data-table
        v-else
        size="small"
        :columns="relatedColumns"
        :data="relatedRequests"
        :loading="relatedLoading"
        :bordered="false"
        :row-key="(row: ApiRequest) => row.id"
      />
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { DataTableColumns } from "naive-ui";
import { useRoute, useRouter } from "vue-router";
import {
  NAlert,
  NButton,
  NCard,
  NCollapse,
  NCollapseItem,
  NDataTable,
  NDescriptions,
  NDescriptionsItem,
  NEmpty,
  NIcon,
  NSpace,
  NTag,
  NTimeline,
  NTimelineItem,
  useMessage,
} from "naive-ui";
import { ArrowBackOutline, RefreshOutline } from "@vicons/ionicons5";
import { useI18n } from "vue-i18n";
import { useAuthStore } from "@/stores/auth";
import { streamSSE } from "@/utils/sse";
import {
  configApi,
  type AgentRunDetailResponse,
  type AgentRunEvent,
  type AgentRunStatus,
} from "@/api/config";
import {
  apiRequestApi,
  type ApiRequest,
} from "@/api/api-request";

const POLL_INTERVAL_MS = 5000;
const ACTIVE_STATUSES: readonly AgentRunStatus[] = ["queued", "running"];
// 镜像 shared 的 TERMINAL_RUN_EVENT_TYPES：收到终局事件后拉一次最终状态并停止实时
const TERMINAL_EVENT_TYPES = new Set(["run.completed", "run.failed", "run.cancelled"]);

const route = useRoute();
const router = useRouter();
const message = useMessage();
const authStore = useAuthStore();
const { t } = useI18n();

const loading = ref(false);
const detail = ref<AgentRunDetailResponse | null>(null);
const relatedRequests = ref<ApiRequest[]>([]);
const relatedTotal = ref(0);
const relatedLoading = ref(false);
let pollTimer: ReturnType<typeof setInterval> | undefined;
let streamAbort: AbortController | null = null;

const runId = computed(() => String(route.params.id ?? ""));
const run = computed(() => detail.value?.run ?? null);
const isActive = computed(
  () => run.value !== null && ACTIVE_STATUSES.includes(run.value.status),
);

const statusTypes: Record<
  AgentRunStatus,
  "default" | "info" | "success" | "warning" | "error"
> = {
  queued: "default",
  running: "info",
  completed: "success",
  failed: "error",
  cancelled: "warning",
  timed_out: "error",
  budget_exceeded: "warning",
  expired: "default",
};

interface StatItem {
  label: string;
  value: string;
  tone?: "info" | "warning" | "success";
}

const summaryItems = computed<StatItem[]>(() => {
  const r = run.value;
  const usage = r?.usage ?? null;
  const durationMs = r?.duration_ms ?? null;
  const throughput =
    usage && durationMs && durationMs > 0 && r?.completed_at
      ? (usage.output_tokens / (durationMs / 1000)).toFixed(1)
      : null;
  return [
    {
      label: t("agentRunDetail.summary.duration"),
      value: formatDuration(durationMs),
    },
    {
      label: t("agentRunDetail.summary.turns"),
      value: formatNumber(usage?.turn_count ?? 0),
    },
    {
      label: t("agentRunDetail.summary.toolCalls"),
      value: formatNumber(usage?.tool_call_count ?? 0),
    },
    {
      label: t("agentRunDetail.summary.inputTokens"),
      value: formatNumber(usage?.input_tokens ?? 0),
    },
    {
      label: t("agentRunDetail.summary.outputTokens"),
      value: formatNumber(usage?.output_tokens ?? 0),
    },
    {
      label: t("agentRunDetail.summary.cost"),
      value: formatCost(usage?.cost ?? 0),
    },
    {
      label: t("agentRunDetail.summary.throughput"),
      value: throughput ?? "—",
    },
  ];
});

interface LifecycleStep {
  key: string;
  title: string;
  time: string;
  type: "default" | "info" | "success" | "warning" | "error";
  pending: boolean;
}

const lifecycleSteps = computed<LifecycleStep[]>(() => {
  const r = run.value;
  if (!r) return [];
  const steps: LifecycleStep[] = [
    {
      key: "queued",
      title: t("agentRunDetail.lifecycleSteps.queued"),
      time: formatTime(r.created_at),
      type: "default",
      pending: false,
    },
  ];
  if (r.started_at !== null) {
    steps.push({
      key: "started",
      title: t("agentRunDetail.lifecycleSteps.started"),
      time: formatTime(r.started_at),
      type: "info",
      pending: false,
    });
  } else {
    steps.push({
      key: "started",
      title: t("agentRunDetail.lifecycleSteps.started"),
      time: "—",
      type: "info",
      pending: true,
    });
  }
  if (r.cancellation_requested_at !== null) {
    steps.push({
      key: "cancel",
      title: t("agentRunDetail.lifecycleSteps.cancelRequested"),
      time: formatTime(r.cancellation_requested_at),
      type: "warning",
      pending: false,
    });
  }
  const terminalTime = r.completed_at;
  steps.push({
    key: "terminal",
    title: `${t("agentRunDetail.lifecycleSteps.terminal")} · ${t(
      `workerMonitoring.status.${r.status}`,
    )}`,
    time: terminalTime !== null ? formatTime(terminalTime) : "—",
    type:
      r.status === "completed"
        ? "success"
        : r.status === "cancelled" || r.status === "budget_exceeded"
          ? "warning"
          : r.status === "queued" || r.status === "running"
            ? "info"
            : "error",
    pending: terminalTime === null,
  });
  return steps;
});

function eventTagType(
  type: string,
): "default" | "info" | "success" | "warning" | "error" {
  if (type.startsWith("tool.")) return "warning";
  if (type === "model.completed") return "success";
  if (type === "run.failed") return "error";
  if (type === "run.cancelled") return "warning";
  if (type === "run.completed") return "success";
  if (type === "run.queued") return "default";
  return "info";
}

function eventDotClass(type: string): string {
  const tag = eventTagType(type);
  return `dot-${tag}`;
}

function eventSummary(event: AgentRunEvent): string {
  const p = event.payload ?? {};
  switch (event.type) {
    case "run.queued":
    case "run.started":
      return typeof p.plugin === "string" ? p.plugin : "";
    case "source.resolved":
      return [p.source_type, p.snapshot_id]
        .filter((v) => v !== null && v !== undefined && v !== "")
        .map(String)
        .join(" · ");
    case "worker.started":
      return typeof p.executor === "string" ? p.executor : "";
    case "model.completed":
      return `turn ${String(p.turn ?? "?")} · ↑${formatNumber(
        Number(p.prompt_tokens ?? 0),
      )} ↓${formatNumber(Number(p.completion_tokens ?? 0))}`;
    default: {
      const entries = Object.entries(p)
        .filter(
          ([, v]) =>
            typeof v === "string" ||
            typeof v === "number" ||
            typeof v === "boolean",
        )
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${String(v)}`);
      return entries.join(" · ");
    }
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatDuration(value: number | null): string {
  if (value === null) return "—";
  if (value < 1000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.floor(value / 60_000)}m ${Math.floor((value % 60_000) / 1000)}s`;
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString();
}

function formatEventTime(value: number): string {
  const d = new Date(value);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

function stopLive() {
  stopPolling();
  if (streamAbort) {
    streamAbort.abort();
    streamAbort = null;
  }
}

function maxEventSeq(): number {
  return (detail.value?.events ?? []).reduce(
    (max, event) => Math.max(max, event.seq),
    0,
  );
}

function mergeStreamEvent(incoming: AgentRunEvent) {
  const events = detail.value?.events;
  if (!events) return;
  if (events.some((event) => event.seq === incoming.seq)) return;
  events.push(incoming);
  events.sort((a, b) => a.seq - b.seq);
}

function schedulePolling() {
  stopPolling();
  if (isActive.value) {
    pollTimer = setInterval(load, POLL_INTERVAL_MS);
  }
}

// 实时优先：SSE 订阅（lastEventId 续传 + seq 去重）；断流时降级 5s 轮询，
// 每次轮询刷新都会重试 SSE，自愈。
function startLive() {
  stopLive();
  if (!isActive.value || !runId.value) return;
  const controller = new AbortController();
  streamAbort = controller;
  streamSSE(`/api/admin/agent-runs/${runId.value}/events`, {
    token: authStore.token ?? undefined,
    lastEventId: String(maxEventSeq()),
    signal: controller.signal,
    onEvent: (sse) => {
      if (!sse.data) return;
      try {
        const parsed = JSON.parse(sse.data) as AgentRunEvent;
        mergeStreamEvent(parsed);
        if (TERMINAL_EVENT_TYPES.has(parsed.type)) {
          void load();
        }
      } catch {
        // 坏帧忽略，等下一事件
      }
    },
  })
    .catch(() => {
      if (isActive.value && !controller.signal.aborted) {
        schedulePolling();
      }
    })
    .finally(() => {
      if (streamAbort === controller) streamAbort = null;
    });
}

const relatedColumns = computed<DataTableColumns<ApiRequest>>(() => [
  {
    title: t("agentRunDetail.relatedTable.time"),
    key: "created_at",
    width: 190,
    render: (row) => formatTime(row.created_at),
  },
  {
    title: t("agentRunDetail.relatedTable.model"),
    key: "model",
    minWidth: 200,
    ellipsis: { tooltip: true },
    render: (row) => row.model || "—",
  },
  {
    title: t("agentRunDetail.relatedTable.status"),
    key: "status",
    width: 100,
    render: (row) =>
      h(
        NTag,
        {
          size: "small",
          bordered: false,
          type: row.status === "success" ? "success" : "error",
        },
        { default: () => row.status },
      ),
  },
  {
    title: t("agentRunDetail.relatedTable.tokens"),
    key: "tokens",
    width: 140,
    render: (row) =>
      `${formatNumber(row.prompt_tokens)} / ${formatNumber(row.completion_tokens)}`,
  },
  {
    title: t("agentRunDetail.relatedTable.latency"),
    key: "response_time",
    width: 110,
    render: (row) => formatDuration(row.response_time),
  },
  {
    title: t("agentRunDetail.relatedTable.cache"),
    key: "cache_hit",
    width: 90,
    render: (row) => (row.cache_hit === 1 ? "HIT" : "—"),
  },
]);

async function loadRelated() {
  if (!runId.value) return;
  relatedLoading.value = true;
  try {
    const result = await apiRequestApi.getAll({
      runId: runId.value,
      pageSize: 50,
    });
    relatedRequests.value = result.data;
    relatedTotal.value = result.total;
  } catch {
    message.error(t("agentRunDetail.relatedRequestsLoadFailed"));
  } finally {
    relatedLoading.value = false;
  }
}

async function load() {
  if (loading.value || !runId.value) return;
  loading.value = true;
  try {
    detail.value = await configApi.getAgentRunDetail(runId.value);
    startLive();
    void loadRelated();
  } catch (error: any) {
    message.error(error?.message || t("agentRunDetail.loadFailed"));
  } finally {
    loading.value = false;
  }
}

function goBack() {
  router.push("/worker-monitoring");
}

watch(
  () => route.params.id,
  () => {
    stopLive();
    detail.value = null;
    load();
  },
);

onMounted(load);
onBeforeUnmount(stopLive);
</script>

<style scoped>
.agent-run-detail-view {
  max-width: 1400px;
  margin: 0 auto;
  padding-bottom: 32px;
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.header-main {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
}
.header-title {
  min-width: 0;
}
.title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.page-title {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
}
.run-id {
  font-size: 12px;
  color: #8c8c8c;
  word-break: break-all;
}
.page-subtitle {
  margin: 4px 0 0;
  font-size: 13px;
  color: #595959;
}

.agent-run-detail-view :deep(.n-card) {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  box-shadow: none;
}
.agent-run-detail-view :deep(.n-card:hover) {
  box-shadow: none;
}

.refresh-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid #e5e7eb;
  border-radius: 999px;
  background: #fff;
  font-size: 12px;
  color: #595959;
}
.refresh-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-info);
}

.error-alert {
  margin-bottom: 16px;
}

.stat-panel {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 0;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  margin-bottom: 16px;
}
.stat-cell {
  min-width: 0;
  padding: 14px 16px 16px;
}
.stat-cell + .stat-cell {
  border-left: 1px solid #e5e7eb;
}
.stat-label {
  font-size: 12px;
  color: #8c8c8c;
  white-space: nowrap;
}
.stat-value {
  margin-top: 2px;
  font-size: 20px;
  font-weight: 600;
  color: #1f1f1f;
  font-variant-numeric: tabular-nums;
}

.body-grid {
  display: grid;
  grid-template-columns: 360px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.side-column {
  display: grid;
  gap: 16px;
}
.digest {
  font-size: 11px;
  word-break: break-all;
}

.events-card :deep(.n-card__content) {
  max-height: calc(100vh - 220px);
  overflow-y: auto;
}
.events-empty {
  padding: 48px 0;
}
.event-list {
  display: flex;
  flex-direction: column;
}
.event-row {
  display: flex;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px dashed #ececec;
}
.event-row:last-child {
  border-bottom: none;
}
.event-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 6px;
  background: #d9d9d9;
}
.event-dot.dot-info {
  background: var(--color-info);
}
.event-dot.dot-success {
  background: var(--color-success);
}
.event-dot.dot-warning {
  background: var(--color-warning);
}
.event-dot.dot-error {
  background: var(--color-error);
}
.event-body {
  min-width: 0;
  flex: 1;
}
.event-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.event-seq {
  font-size: 11px;
  color: #8c8c8c;
}
.event-summary {
  font-size: 12px;
  color: #595959;
  word-break: break-all;
}
.event-time {
  margin-left: auto;
  font-size: 12px;
  color: #8c8c8c;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.event-payload :deep(.n-collapse-item__header) {
  font-size: 12px;
  color: #8c8c8c;
}
.payload-json {
  margin: 0;
  padding: 10px;
  background: #f7f8fa;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
}

@media (max-width: 1100px) {
  .body-grid {
    grid-template-columns: 1fr;
  }
  .stat-panel {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
  .stat-cell:nth-child(5) {
    border-left: none;
  }
  .stat-cell:nth-child(n + 5) {
    border-top: 1px solid #e5e7eb;
  }
}
</style>

<template>
  <div class="agent-metrics-panel">
    <!-- 顶部紧凑汇总行（同一采样窗口的 coding-agent 总览，不铺大卡） -->
    <n-skeleton
      v-if="codingLoading"
      text
      style="height: 46px; margin-bottom: 12px"
    />
    <div v-else-if="codingOverview" class="summary-bar">
      <div class="summary-item">
        <span class="summary-label">{{
          t("agentMetrics.summary.agentCount")
        }}</span>
        <span class="summary-value">{{
          formatNumber(codingOverview.totals.agentCount)
        }}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">{{
          t("agentMetrics.summary.requests")
        }}</span>
        <span class="summary-value">{{
          formatNumber(codingOverview.totals.requests)
        }}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">{{
          t("agentMetrics.summary.tokens")
        }}</span>
        <span class="summary-value">{{
          formatTokenNumber(codingOverview.totals.totalTokens)
        }}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">{{
          t("agentMetrics.summary.cost")
        }}</span>
        <span class="summary-value">{{
          formatCost(codingOverview.totals.estimatedCost)
        }}</span>
      </div>
      <n-tag
        v-if="codingOverview.costCoverage !== 'full'"
        type="warning"
        size="small"
        :bordered="false"
      >
        {{ t("agentMetrics.costCoverageWarning") }}
      </n-tag>
    </div>

    <n-tabs type="line" :animated="false">
      <!-- ============ Coding Agent 卡片区 ============ -->
      <n-tab-pane
        name="codingAgents"
        :tab="t('agentMetrics.tabs.codingAgents')"
      >
        <n-alert v-if="codingError" type="error" class="section-error">
          <div class="error-row">
            <span
              >{{ t("agentMetrics.error.loadFailed") }}：{{ codingError }}</span
            >
            <n-button size="small" secondary type="error" @click="loadCoding">
              {{ t("agentMetrics.retry") }}
            </n-button>
          </div>
        </n-alert>

        <n-grid
          v-else-if="codingLoading"
          cols="1 s:2 l:3"
          responsive="screen"
          :x-gap="12"
          :y-gap="12"
        >
          <n-gi v-for="i in 6" :key="i">
            <n-skeleton height="136px" :sharp="false" />
          </n-gi>
        </n-grid>

        <n-empty
          v-else-if="codingAgents.length === 0"
          :description="t('agentMetrics.agents.empty')"
          class="block-empty"
        />

        <n-grid
          v-else
          cols="1 s:2 l:3"
          responsive="screen"
          :x-gap="12"
          :y-gap="12"
        >
          <n-gi v-for="agent in codingAgents" :key="agent.key">
            <div class="agent-card" @click="openAgent(agent)">
              <div class="agent-card-head">
                <span class="agent-label" :title="agent.label">{{
                  agent.label
                }}</span>
                <n-tag
                  size="small"
                  :bordered="false"
                  :type="categoryTagTypes[agent.category]"
                >
                  {{ t(`agentMetrics.category.${agent.category}`) }}
                </n-tag>
              </div>
              <div class="agent-stats">
                <div class="agent-stat">
                  <span class="stat-k">{{
                    t("agentMetrics.agents.requests")
                  }}</span>
                  <span class="stat-v">{{ formatNumber(agent.requests) }}</span>
                </div>
                <div class="agent-stat">
                  <span class="stat-k">{{
                    t("agentMetrics.agents.tokens")
                  }}</span>
                  <span class="stat-v">{{
                    formatTokenNumber(agent.totalTokens)
                  }}</span>
                </div>
                <div class="agent-stat">
                  <span class="stat-k">{{
                    t("agentMetrics.agents.cost")
                  }}</span>
                  <span class="stat-v">{{
                    formatCost(agent.estimatedCost)
                  }}</span>
                </div>
              </div>
              <div class="agent-foot">
                <n-text depth="3"
                  >{{ t("agentMetrics.agents.lastActive") }}：{{
                    formatRelativeTime(agent.lastActiveAt)
                  }}</n-text
                >
              </div>
            </div>
          </n-gi>
        </n-grid>
      </n-tab-pane>

      <!-- ============ Worker Run 区（自有 craft worker） ============ -->
      <n-tab-pane name="workerRuns" :tab="t('agentMetrics.tabs.workerRuns')">
        <n-alert v-if="workerError" type="error" class="section-error">
          <div class="error-row">
            <span
              >{{ t("agentMetrics.error.loadFailed") }}：{{ workerError }}</span
            >
            <n-button
              size="small"
              secondary
              type="error"
              @click="loadWorkerRuns"
            >
              {{ t("agentMetrics.retry") }}
            </n-button>
          </div>
        </n-alert>

        <template v-else-if="workerLoading">
          <n-skeleton text style="height: 22px; margin-bottom: 14px" />
          <n-skeleton text style="height: 280px; margin-bottom: 16px" />
          <n-skeleton text style="height: 220px" />
        </template>

        <template v-else-if="workerOverview">
          <n-empty
            v-if="workerOverview.totals.runs === 0"
            :description="t('agentMetrics.worker.empty')"
            class="block-empty"
          />

          <template v-else>
            <!-- totals 小字一行 -->
            <div class="worker-totals">
              <span
                v-for="item in workerTotalsLine"
                :key="item.label"
                class="totals-item"
              >
                {{ item.label }} <strong>{{ item.value }}</strong>
              </span>
            </div>

            <!-- 趋势：runs（柱）+ cost（线，右轴） -->
            <div class="section-title">{{
              t("agentMetrics.trend.title")
            }}</div>
            <v-chart
              v-if="hasTrendData"
              class="trend-chart"
              :option="trendChartOption"
              autoresize
            />
            <n-empty
              v-else
              size="small"
              :description="t('agentMetrics.trend.empty')"
              class="block-empty small"
            />

            <div class="section-title">{{
              t("agentMetrics.worker.byPluginTitle")
            }}</div>
            <n-data-table
              size="small"
              :columns="pluginColumns"
              :data="workerOverview.byPlugin"
              :row-key="
                (row: WorkerPluginRow) => `${row.pluginId}@${row.version}`
              "
              :bordered="false"
              :scroll-x="1060"
            >
              <template #empty>
                <n-empty
                  size="small"
                  :description="t('agentMetrics.worker.empty')"
                />
              </template>
            </n-data-table>

            <div class="breakdown-grid">
              <div class="breakdown-block">
                <div class="section-title">{{
                  t("agentMetrics.worker.byStatusTitle")
                }}</div>
                <div class="tag-list">
                  <n-tag
                    v-for="row in workerOverview.byStatus"
                    :key="row.status"
                    size="small"
                    :bordered="false"
                    :type="statusTagType(row.status)"
                  >
                    {{ statusLabel(row.status) }} ·
                    {{ formatNumber(row.runs) }}
                  </n-tag>
                </div>

                <template v-if="workerOverview.errorCodes.length > 0">
                  <div class="section-title">{{
                    t("agentMetrics.worker.errorCodesTitle")
                  }}</div>
                  <div class="tag-list">
                    <n-tag
                      v-for="ec in workerOverview.errorCodes"
                      :key="ec.errorCode"
                      size="small"
                      type="error"
                      :bordered="false"
                    >
                      {{ ec.errorCode }} · {{ formatNumber(ec.count) }}
                    </n-tag>
                  </div>
                </template>
              </div>

              <div class="breakdown-block">
                <div class="section-title">{{
                  t("agentMetrics.worker.byModelProfileTitle")
                }}</div>
                <n-data-table
                  size="small"
                  :columns="profileColumns"
                  :data="workerOverview.byModelProfile"
                  :row-key="(row: WorkerProfileRow) => row.profile"
                  :bordered="false"
                >
                  <template #empty>
                    <n-empty
                      size="small"
                      :description="t('agentMetrics.worker.empty')"
                    />
                  </template>
                </n-data-table>
              </div>
            </div>
          </template>
        </template>
      </n-tab-pane>
    </n-tabs>

    <!-- ============ Agent 会话明细抽屉 ============ -->
    <n-drawer v-model:show="drawerVisible" :width="drawerWidth" placement="right">
      <n-drawer-content :title="drawerTitle" closable>
        <div v-if="drawerAgent" class="drawer-body">
          <div class="ua-samples">
            <div class="ua-title">{{ t("agentMetrics.drawer.uaSamples") }}</div>
            <n-text
              v-for="(ua, index) in drawerAgent.userAgents.slice(0, 3)"
              :key="index"
              depth="3"
              class="ua-line"
            >
              {{ ua }}
            </n-text>
          </div>

          <n-alert v-if="sessionsError" type="error" class="section-error">
            <div class="error-row">
              <span
                >{{ t("agentMetrics.error.loadFailed") }}：{{
                  sessionsError
                }}</span
              >
              <n-button
                size="small"
                secondary
                type="error"
                @click="loadSessions"
              >
                {{ t("agentMetrics.retry") }}
              </n-button>
            </div>
          </n-alert>

          <n-skeleton
            v-else-if="sessionsLoading && sessions.length === 0"
            text
            :repeat="6"
          />

          <n-data-table
            v-else
            size="small"
            :columns="sessionColumns"
            :data="sessions"
            :loading="sessionsLoading"
            :row-key="(row: AgentSessionSummary) => row.sessionId"
            :bordered="false"
            :scroll-x="1120"
          >
            <template #empty>
              <n-empty
                size="small"
                :description="t('agentMetrics.sessions.empty')"
              />
            </template>
          </n-data-table>
        </div>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  NAlert,
  NButton,
  NDataTable,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NGi,
  NGrid,
  NSkeleton,
  NTabPane,
  NTabs,
  NTag,
  NText,
  type DataTableColumns,
} from "naive-ui";
// echarts 组件已在 main.ts 全局 use([...]) 注册（含 BarChart/LineChart 等），
// 此处仅需引入 VChart，与 OperationsMonitoringView 的用法一致。
import VChart from "vue-echarts";
import {
  agentMetricsApi,
  type AgentMetricsPeriod,
  type AgentSessionSummary,
  type CodingAgentOverviewResponse,
  type CodingAgentSummary,
  type WorkerRunOverviewResponse,
} from "@/api/agent-metrics";
import { formatNumber, formatTokenNumber } from "@/utils/format";
import { formatDateTime } from "@/utils/date";
import { useDebouncedWindowSize } from "@/composables/useDebouncedWindowSize";

type WorkerPluginRow = WorkerRunOverviewResponse["byPlugin"][number];
type WorkerProfileRow = WorkerRunOverviewResponse["byModelProfile"][number];

const props = defineProps<{
  period: AgentMetricsPeriod;
  /** 同一刷新周期内固定的采样时刻；不传则组件在单次加载内自行固定。 */
  endTime?: number;
  /** 父组件刷新周期令牌，仅作依赖占位；重拉由 period/endTime 驱动，避免周期内重复拉数。 */
  loadingToken?: string | number;
}>();

const { t, te, locale } = useI18n();

const codingOverview = ref<CodingAgentOverviewResponse | null>(null);
const codingLoading = ref(false);
const codingError = ref<string | null>(null);
let codingRequestId = 0;

const workerOverview = ref<WorkerRunOverviewResponse | null>(null);
const workerLoading = ref(false);
const workerError = ref<string | null>(null);
let workerRequestId = 0;

// endTime prop 缺失时一次刷新周期内固定，供两路请求与 sessions 明细共用。
let pinnedEndTime: number | null = null;

function resolveEndTime(): number {
  if (props.endTime !== undefined) return props.endTime;
  if (pinnedEndTime === null) pinnedEndTime = Date.now();
  return pinnedEndTime;
}

function currentQuery(): { period: AgentMetricsPeriod; endTime: number } {
  return { period: props.period, endTime: resolveEndTime() };
}

// 两路请求各自 try/catch：一路失败不拖垮另一路（分区各自展示错误与重试）。
async function loadCoding(): Promise<void> {
  const requestId = ++codingRequestId;
  codingLoading.value = true;
  codingError.value = null;
  try {
    const response = await agentMetricsApi.getCodingAgents(currentQuery());
    if (requestId !== codingRequestId) return;
    codingOverview.value = response;
  } catch (error) {
    if (requestId === codingRequestId) codingError.value = errorMessage(error);
  } finally {
    if (requestId === codingRequestId) codingLoading.value = false;
  }
}

async function loadWorkerRuns(): Promise<void> {
  const requestId = ++workerRequestId;
  workerLoading.value = true;
  workerError.value = null;
  try {
    const response = await agentMetricsApi.getWorkerRuns(currentQuery());
    if (requestId !== workerRequestId) return;
    workerOverview.value = response;
  } catch (error) {
    if (requestId === workerRequestId) workerError.value = errorMessage(error);
  } finally {
    if (requestId === workerRequestId) workerLoading.value = false;
  }
}

function load(): void {
  pinnedEndTime = Date.now();
  void Promise.all([loadCoding(), loadWorkerRuns()]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const codingAgents = computed<CodingAgentSummary[]>(
  () => codingOverview.value?.agents ?? [],
);

onMounted(load);

// ---------- 会话明细抽屉 ----------

const drawerVisible = ref(false);
const drawerAgent = ref<CodingAgentSummary | null>(null);
const sessions = ref<AgentSessionSummary[]>([]);
const sessionsLoading = ref(false);
const sessionsError = ref<string | null>(null);
let sessionsRequestId = 0;

const { windowWidth } = useDebouncedWindowSize(200);
const drawerWidth = computed(() =>
  Math.min(880, Math.max(360, Math.floor(windowWidth.value * 0.68))),
);

const drawerTitle = computed(() =>
  t("agentMetrics.drawer.title", { label: drawerAgent.value?.label ?? "" }),
);

function openAgent(agent: CodingAgentSummary): void {
  drawerAgent.value = agent;
  sessions.value = [];
  drawerVisible.value = true;
  void loadSessions();
}

async function loadSessions(): Promise<void> {
  const agent = drawerAgent.value;
  if (!agent) return;
  const requestId = ++sessionsRequestId;
  sessionsLoading.value = true;
  sessionsError.value = null;
  try {
    const response = await agentMetricsApi.getAgentSessions(
      agent.key,
      currentQuery(),
    );
    if (requestId !== sessionsRequestId) return;
    sessions.value = response.sessions;
  } catch (error) {
    if (requestId === sessionsRequestId)
      sessionsError.value = errorMessage(error);
  } finally {
    if (requestId === sessionsRequestId) sessionsLoading.value = false;
  }
}

function renderModels(row: AgentSessionSummary) {
  if (row.models.length === 0) return "—";
  const shown = row.models.slice(0, 3);
  const rest = row.models.length - shown.length;
  const tags = shown.map((model) =>
    h(
      NTag,
      { key: model, size: "small", bordered: false },
      { default: () => model },
    ),
  );
  if (rest > 0) {
    tags.push(
      h(
        NTag,
        { key: "__more", size: "small", bordered: false, dashed: true },
        { default: () => `+${rest}` },
      ),
    );
  }
  return h("div", { class: "model-tags" }, tags);
}

const sessionColumns = computed<DataTableColumns<AgentSessionSummary>>(() => [
  {
    title: t("agentMetrics.sessions.startedAt"),
    key: "startedAt",
    width: 150,
    render: (row) => formatDateTime(row.startedAt),
  },
  {
    title: t("agentMetrics.sessions.duration"),
    key: "durationMs",
    width: 100,
    render: (row) => formatDurationMs(row.durationMs),
  },
  {
    title: t("agentMetrics.sessions.requests"),
    key: "requests",
    width: 90,
    render: (row) => formatNumber(row.requests),
  },
  {
    title: t("agentMetrics.sessions.tokens"),
    key: "totalTokens",
    width: 100,
    render: (row) => formatTokenNumber(row.totalTokens),
  },
  {
    title: t("agentMetrics.sessions.cost"),
    key: "estimatedCost",
    width: 100,
    render: (row) => formatCost(row.estimatedCost),
  },
  {
    title: t("agentMetrics.sessions.models"),
    key: "models",
    minWidth: 220,
    render: renderModels,
  },
  {
    title: t("agentMetrics.sessions.ip"),
    key: "ip",
    width: 130,
    render: (row) => row.ip ?? "—",
  },
  {
    title: t("agentMetrics.sessions.virtualKey"),
    key: "virtualKeyId",
    width: 170,
    render: (row) =>
      row.virtualKeyId
        ? h("code", { class: "vk-code" }, row.virtualKeyId)
        : "—",
  },
]);

// ---------- Worker Run 区 ----------

const workerTotalsLine = computed(() => {
  const totals = workerOverview.value?.totals;
  if (!totals) return [];
  return [
    { label: t("agentMetrics.worker.totals.runs"), value: formatNumber(totals.runs) },
    { label: t("agentMetrics.worker.totals.completed"), value: formatNumber(totals.completed) },
    { label: t("agentMetrics.worker.totals.failed"), value: formatNumber(totals.failed) },
    { label: t("agentMetrics.worker.totals.cancelled"), value: formatNumber(totals.cancelled) },
    { label: t("agentMetrics.worker.totals.running"), value: formatNumber(totals.running) },
    { label: t("agentMetrics.worker.totals.queued"), value: formatNumber(totals.queued) },
    { label: t("agentMetrics.worker.totals.other"), value: formatNumber(totals.other) },
    { label: t("agentMetrics.worker.totals.turns"), value: formatNumber(totals.turns) },
    { label: t("agentMetrics.worker.totals.toolCalls"), value: formatNumber(totals.toolCalls) },
    // 后端只有 input/output 两列，totals 的 tokens 口径取两者之和
    { label: t("agentMetrics.worker.totals.tokens"), value: formatTokenNumber(totals.inputTokens + totals.outputTokens) },
    { label: t("agentMetrics.worker.totals.cost"), value: formatCost(totals.cost) },
    { label: t("agentMetrics.worker.totals.avgDuration"), value: formatDurationMs(totals.avgDurationMs) },
  ];
});

const pluginColumns = computed<DataTableColumns<WorkerPluginRow>>(() => [
  {
    title: t("agentMetrics.worker.col.plugin"),
    key: "pluginId",
    minWidth: 210,
    render: (row) =>
      h("div", null, [
        h("div", { style: "font-weight: 500" }, row.pluginId),
        h("code", { class: "vk-code" }, `@v${row.version}`),
      ]),
  },
  {
    title: t("agentMetrics.worker.col.runs"),
    key: "runs",
    width: 90,
    sorter: "default",
    render: (row) => formatNumber(row.runs),
  },
  {
    title: t("agentMetrics.worker.col.completed"),
    key: "completed",
    width: 90,
    sorter: "default",
    render: (row) => formatNumber(row.completed),
  },
  {
    title: t("agentMetrics.worker.col.failed"),
    key: "failed",
    width: 90,
    sorter: "default",
    render: (row) => formatNumber(row.failed),
  },
  {
    title: t("agentMetrics.worker.col.turns"),
    key: "turns",
    width: 90,
    sorter: "default",
    render: (row) => formatNumber(row.turns),
  },
  {
    title: t("agentMetrics.worker.col.toolCalls"),
    key: "toolCalls",
    width: 100,
    sorter: "default",
    render: (row) => formatNumber(row.toolCalls),
  },
  {
    title: t("agentMetrics.worker.col.tokens"),
    key: "tokens",
    width: 110,
    sorter: "default",
    render: (row) => formatTokenNumber(row.inputTokens + row.outputTokens),
  },
  {
    title: t("agentMetrics.worker.col.cost"),
    key: "cost",
    width: 100,
    sorter: "default",
    render: (row) => formatCost(row.cost),
  },
  {
    title: t("agentMetrics.worker.col.avgDuration"),
    key: "avgDurationMs",
    width: 110,
    sorter: "default",
    render: (row) => formatDurationMs(row.avgDurationMs),
  },
]);

const profileColumns = computed<DataTableColumns<WorkerProfileRow>>(() => [
  {
    title: t("agentMetrics.worker.col.profile"),
    key: "profile",
    minWidth: 160,
    ellipsis: { tooltip: true },
  },
  {
    title: t("agentMetrics.worker.col.runs"),
    key: "runs",
    width: 80,
    render: (row) => formatNumber(row.runs),
  },
  {
    title: t("agentMetrics.worker.col.tokens"),
    key: "tokens",
    width: 90,
    render: (row) => formatTokenNumber(row.tokens),
  },
  {
    title: t("agentMetrics.worker.col.cost"),
    key: "cost",
    width: 90,
    render: (row) => formatCost(row.cost),
  },
]);

const statusTagTypes: Record<
  string,
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

function statusTagType(status: string) {
  return statusTagTypes[status] ?? "default";
}

// byStatus 的 status 是开放字符串，未知状态回落为原值展示
function statusLabel(status: string): string {
  const key = `agentMetrics.status.${status}`;
  return te(key) ? t(key) : status;
}

const categoryTagTypes: Record<
  CodingAgentSummary["category"],
  "default" | "info" | "success" | "warning" | "error"
> = {
  "coding-agent": "success",
  sdk: "info",
  script: "warning",
  browser: "info",
  worker: "default",
  unknown: "default",
};

// ---------- 趋势图（worker-runs.trend） ----------

const hasTrendData = computed(() =>
  (workerOverview.value?.trend ?? []).some(
    (point) => point.runs > 0 || point.cost > 0,
  ),
);

// bucketStart 为 epoch ms；粒度来自响应 granularity（24h→hour，7d/30d→day）
function bucketLabel(ts: number, granularity: "hour" | "day"): string {
  return new Intl.DateTimeFormat(locale.value === "zh-CN" ? "zh-CN" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    ...(granularity === "hour" ? { hour: "2-digit", minute: "2-digit" } : {}),
    hour12: false,
  }).format(new Date(ts));
}

const trendChartOption = computed(() => {
  const overview = workerOverview.value;
  if (!overview || overview.trend.length === 0) return {};
  const granularity = overview.granularity;
  const labels = overview.trend.map((point) =>
    bucketLabel(point.bucketStart, granularity),
  );
  const costs = overview.trend.map((point) => Number(point.cost.toFixed(4)));

  return {
    tooltip: {
      trigger: "axis",
      confine: true,
      formatter: (params: Array<{ dataIndex: number }>) => {
        const point = overview.trend[params[0]?.dataIndex ?? 0];
        if (!point) return "";
        return [
          bucketLabel(point.bucketStart, granularity),
          `${t("agentMetrics.trend.runs")}: ${formatNumber(point.runs)}`,
          `${t("agentMetrics.worker.col.completed")}: ${formatNumber(point.completed)}`,
          `${t("agentMetrics.worker.col.failed")}: ${formatNumber(point.failed)}`,
          `${t("agentMetrics.worker.col.tokens")}: ${formatTokenNumber(point.tokens)}`,
          `${t("agentMetrics.trend.cost")}: ${formatCost(point.cost)}`,
        ].join("<br/>");
      },
    },
    legend: {
      data: [t("agentMetrics.trend.runs"), t("agentMetrics.trend.cost")],
      bottom: 0,
    },
    grid: { left: "3%", right: "4%", bottom: "12%", top: "12%", containLabel: true },
    xAxis: {
      type: "category",
      data: labels,
      axisLabel: {
        rotate: granularity === "day" && props.period === "30d" ? 45 : 0,
        fontSize: 11,
      },
    },
    yAxis: [
      { type: "value", name: t("agentMetrics.trend.runs") },
      {
        type: "value",
        name: t("agentMetrics.trend.cost"),
        splitLine: { show: false },
        axisLabel: { formatter: "${value}" },
      },
    ],
    series: [
      {
        name: t("agentMetrics.trend.runs"),
        type: "bar",
        data: overview.trend.map((point) => point.runs),
        itemStyle: { color: "#2080f0", borderRadius: [3, 3, 0, 0] },
      },
      {
        name: t("agentMetrics.trend.cost"),
        type: "line",
        yAxisIndex: 1,
        data: costs,
        itemStyle: { color: "#f0a020" },
        lineStyle: { color: "#f0a020", width: 2 },
      },
    ],
  };
});

// ---------- 本地格式化（仓库无对应公共工具时的最小实现） ----------

// estimatedCost === null 表示至少一个模型缺价，宁缺勿假
function formatCost(value: number | null): string {
  if (value === null) return t("agentMetrics.costUnknown");
  return `$${value.toFixed(4)}`;
}

// 与 WorkerMonitoringView 的本地 formatDuration 同口径（该函数未抽到 utils）
function formatDurationMs(value: number | null): string {
  if (value === null) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.floor(value / 60_000)}m ${Math.floor((value % 60_000) / 1000)}s`;
}

// 仓库无现成相对时间工具（utils/format、utils/date 均为绝对格式），本地实现；
// 以采样窗口 endTime 充当“现在”，避免接口往返耗时造成的新鲜度漂移。
function formatRelativeTime(ts: number | null): string {
  if (ts === null) return t("agentMetrics.neverActive");
  const now = codingOverview.value?.window.endTime ?? Date.now();
  const diffMs = Math.max(0, now - ts);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return t("agentMetrics.relative.justNow");
  if (minutes < 60) return t("agentMetrics.relative.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("agentMetrics.relative.hoursAgo", { n: hours });
  return t("agentMetrics.relative.daysAgo", { n: Math.floor(hours / 24) });
}

// 抽屉状态声明在前，避免 watch 回调前向引用
watch(
  () => [props.period, props.endTime] as const,
  () => {
    drawerVisible.value = false; // 窗口口径变化后，抽屉里的旧会话明细不再成立
    load();
  },
);
</script>

<style scoped>
.agent-metrics-panel {
  width: 100%;
}

/* 汇总行：hairline 扁平风（对齐 WorkerMonitoringView 的 stat-panel 观感） */
.summary-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 28px;
  padding: 10px 16px;
  margin-bottom: 4px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
}
.summary-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  white-space: nowrap;
}
.summary-label {
  font-size: 12px;
  color: #8c8c8c;
}
.summary-value {
  font-size: 18px;
  font-weight: 600;
  color: #1f1f1f;
  font-variant-numeric: tabular-nums;
}

.section-error {
  margin-bottom: 12px;
}
.error-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.block-empty {
  padding: 40px 0;
}
.block-empty.small {
  padding: 16px 0;
}

/* Agent 卡片 */
.agent-card {
  background: linear-gradient(135deg, #ffffff 0%, #f8f8f8 100%);
  border: 1px solid #f0f0f0;
  border-radius: 10px;
  padding: 12px 14px;
  height: 100%;
  cursor: pointer;
  transition:
    transform 0.2s,
    box-shadow 0.2s;
}
.agent-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}
.agent-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.agent-label {
  font-size: 14px;
  font-weight: 600;
  color: #1f1f1f;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.agent-stat .stat-k {
  display: block;
  font-size: 12px;
  color: #8c8c8c;
}
.agent-stat .stat-v {
  font-size: 15px;
  font-weight: 600;
  color: #1f1f1f;
  font-variant-numeric: tabular-nums;
}
.agent-foot {
  margin-top: 10px;
  font-size: 12px;
}

/* Worker Run 区 */
.worker-totals {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  padding: 8px 12px;
  margin: 4px 0 8px;
  background: #fafafa;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  font-size: 12px;
  color: #8c8c8c;
}
.totals-item strong {
  margin-left: 4px;
  font-weight: 600;
  color: #1f1f1f;
  font-variant-numeric: tabular-nums;
}
.section-title {
  margin: 18px 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: #1f1f1f;
}
.trend-chart {
  width: 100%;
  height: 280px;
}
.breakdown-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 0 24px;
}
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* 会话抽屉 */
.drawer-body {
  display: block;
}
.ua-samples {
  margin-bottom: 12px;
  padding: 8px 12px;
  background: #fafafa;
  border-radius: 8px;
}
.ua-title {
  margin-bottom: 4px;
  font-size: 12px;
  color: #8c8c8c;
}
.ua-line {
  display: block;
  font-size: 12px;
  line-height: 1.6;
  word-break: break-all;
}
.model-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.vk-code {
  font-size: 12px;
}
</style>

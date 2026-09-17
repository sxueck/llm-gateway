<template>
  <div class="worker-monitoring-view">
    <div class="page-header">
      <div>
        <h1>Worker 监控</h1>
        <p>查看 Gateway 托管 Worker 的运行状态、Token 用量、成本与执行耗时。</p>
      </div>
      <n-space align="center">
        <n-tag type="success" round>每 10 秒自动刷新</n-tag>
        <n-button :loading="loading" @click="load">
          <template #icon
            ><n-icon><RefreshOutline /></n-icon
          ></template>
          刷新
        </n-button>
      </n-space>
    </div>

    <n-grid :cols="4" :x-gap="16" :y-gap="16" responsive="screen">
      <n-gi v-for="card in statCards" :key="card.label" span="2 s:2 m:1">
        <n-card><n-statistic :label="card.label" :value="card.value" /></n-card>
      </n-gi>
    </n-grid>

    <n-card title="执行记录" style="margin-top: 24px">
      <template #header-extra>
        <n-select
          v-model:value="status"
          clearable
          placeholder="全部状态"
          :options="statusOptions"
          style="width: 160px"
          @update:value="handleStatusChange"
        />
      </template>
      <n-data-table
        :columns="columns"
        :data="data?.items ?? []"
        :loading="loading"
        :bordered="false"
        :row-key="(row: AgentRunMonitoringItem) => row.id"
        :pagination="pagination"
        :scroll-x="1180"
      />
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref } from "vue";
import type { DataTableColumns } from "naive-ui";
import {
  NButton,
  NCard,
  NDataTable,
  NGi,
  NGrid,
  NIcon,
  NSelect,
  NSpace,
  NStatistic,
  NTag,
  useMessage,
} from "naive-ui";
import { RefreshOutline } from "@vicons/ionicons5";
import {
  configApi,
  type AgentRunMonitoringItem,
  type AgentRunMonitoringResponse,
  type AgentRunStatus,
} from "@/api/config";

const message = useMessage();
const loading = ref(false);
const status = ref<AgentRunStatus | null>(null);
const data = ref<AgentRunMonitoringResponse | null>(null);
const page = ref(1);
const pageSize = 20;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

const statCards = computed(() => {
  const s = data.value?.summary;
  const reuseRate =
    s && s.total > 0
      ? `${((s.snapshot_runs / s.total) * 100).toFixed(1)}%`
      : "—";
  return [
    { label: "全部任务", value: formatNumber(s?.total ?? 0) },
    { label: "运行中", value: formatNumber(s?.running ?? 0) },
    { label: "排队中", value: formatNumber(s?.queued ?? 0) },
    { label: "已完成", value: formatNumber(s?.completed ?? 0) },
    { label: "输入 Token", value: formatNumber(s?.input_tokens ?? 0) },
    { label: "输出 Token", value: formatNumber(s?.output_tokens ?? 0) },
    { label: "累计成本", value: formatCost(s?.cost ?? 0) },
    {
      label: "平均耗时",
      value:
        s?.avg_duration_ms == null
          ? "—"
          : formatDuration(Math.round(s.avg_duration_ms)),
    },
    { label: "已缓存快照", value: formatNumber(s?.snapshots.ready ?? 0) },
    { label: "快照大小", value: formatSize(s?.snapshots.total_size ?? 0) },
    { label: "文件总数", value: formatNumber(s?.snapshots.file_count ?? 0) },
    { label: "快照复用率", value: reuseRate },
  ];
});

const pagination = computed(() => ({
  page: page.value,
  pageSize,
  itemCount: data.value?.summary.total ?? 0,
  onUpdatePage: (newPage: number) => {
    page.value = newPage;
    load();
  },
}));

const statusOptions = [
  { label: "排队中", value: "queued" },
  { label: "运行中", value: "running" },
  { label: "已完成", value: "completed" },
  { label: "失败", value: "failed" },
  { label: "已取消", value: "cancelled" },
  { label: "超时", value: "timed_out" },
  { label: "预算耗尽", value: "budget_exceeded" },
  { label: "已过期", value: "expired" },
];

const statusLabels: Record<AgentRunStatus, string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  timed_out: "超时",
  budget_exceeded: "预算耗尽",
  expired: "已过期",
};

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

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10));
  return `${(bytes / 2 ** (10 * i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
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

const columns: DataTableColumns<AgentRunMonitoringItem> = [
  {
    title: "Worker / 插件",
    key: "plugin_id",
    minWidth: 210,
    render: (row) =>
      h("div", null, [
        h("div", { style: "font-weight: 500" }, row.plugin_id),
        h(
          "code",
          { style: "font-size: 12px; color: #888" },
          `v${row.plugin_version} · ${row.model_profile}`,
        ),
      ]),
  },
  {
    title: "状态",
    key: "status",
    width: 110,
    render: (row) =>
      h(
        NTag,
        { type: statusTypes[row.status], bordered: false },
        { default: () => statusLabels[row.status] },
      ),
  },
  {
    title: "创建时间",
    key: "created_at",
    width: 180,
    render: (row) => formatTime(row.created_at),
  },
  {
    title: "运行时长",
    key: "duration_ms",
    width: 110,
    render: (row) => formatDuration(row.duration_ms),
  },
  {
    title: "输入 Token",
    key: "input",
    width: 110,
    render: (row) => formatNumber(row.usage?.input_tokens ?? 0),
  },
  {
    title: "输出 Token",
    key: "output",
    width: 110,
    render: (row) => formatNumber(row.usage?.output_tokens ?? 0),
  },
  {
    title: "轮次 / 工具",
    key: "turns",
    width: 120,
    render: (row) =>
      `${row.usage?.turn_count ?? 0} / ${row.usage?.tool_call_count ?? 0}`,
  },
  {
    title: "成本",
    key: "cost",
    width: 100,
    render: (row) => formatCost(row.usage?.cost ?? 0),
  },
  {
    title: "错误",
    key: "error_message",
    minWidth: 180,
    ellipsis: { tooltip: true },
    render: (row) => row.error_message || "—",
  },
];

async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    data.value = await configApi.getAgentRunMonitoring({
      status: status.value ?? undefined,
      limit: pageSize,
      offset: (page.value - 1) * pageSize,
    });
  } catch (error: any) {
    message.error(error?.message || "加载 Worker 监控数据失败");
  } finally {
    loading.value = false;
  }
}

// 切换状态筛选时结果集变化，回到第一页避免 offset 越界
function handleStatusChange() {
  page.value = 1;
  load();
}

onMounted(() => {
  load();
  refreshTimer = setInterval(load, 10_000);
});

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<style scoped>
.worker-monitoring-view {
  max-width: 1400px;
  margin: 0 auto;
  padding-bottom: 32px;
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 24px;
  flex-wrap: wrap;
}
h1 {
  margin: 0;
  font-size: 28px;
}
p {
  margin: 8px 0 0;
  color: #666;
}
</style>

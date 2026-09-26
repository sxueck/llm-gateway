<template>
  <div class="worker-monitoring-view">
    <div class="page-header">
      <div>
        <h1 class="page-title">{{ t("workerMonitoring.title") }}</h1>
        <p class="page-subtitle">{{ t("workerMonitoring.subtitle") }}</p>
      </div>
      <n-space align="center">
        <span class="refresh-badge"
          ><span class="refresh-dot" />{{ t("workerMonitoring.autoRefresh") }}</span
        >
        <n-button size="small" :loading="loading" @click="load">
          <template #icon
            ><n-icon><RefreshOutline /></n-icon
          ></template>
          {{ t("common.refresh") }}
        </n-button>
      </n-space>
    </div>

    <div class="stat-panel">
      <section
        v-for="group in statGroups"
        :key="group.title"
        class="stat-group"
      >
        <div class="stat-group-title">{{ group.title }}</div>
        <div class="stat-grid">
          <div
            v-for="item in group.items"
            :key="item.label"
            class="stat-cell"
          >
            <div class="stat-label">
              <span v-if="item.tone" class="stat-dot" :class="item.tone" />{{
                item.label
              }}
            </div>
            <div class="stat-value">{{ item.value }}</div>
          </div>
        </div>
      </section>
    </div>

    <n-card class="runs-card" :title="t('workerMonitoring.runs')">
      <template #header-extra>
        <n-space align="center">
          <n-select
            v-model:value="status"
            clearable
            :placeholder="t('workerMonitoring.allStatuses')"
            :options="statusOptions"
            style="width: 160px"
            @update:value="handleStatusChange"
          />
          <n-button size="small" :loading="exporting" @click="exportCsv">
            <template #icon
              ><n-icon><DownloadOutline /></n-icon
            ></template>
            {{ t("workerMonitoring.exportCsv") }}
          </n-button>
        </n-space>
      </template>
      <n-data-table
        size="small"
        :columns="columns"
        :data="data?.items ?? []"
        :loading="loading"
        :bordered="false"
        :row-key="(row: AgentRunMonitoringItem) => row.id"
        :row-props="rowProps"
        :pagination="pagination"
        :scroll-x="1280"
      />
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import type { DataTableColumns } from "naive-ui";
import {
  NButton,
  NCard,
  NDataTable,
  NIcon,
  NSelect,
  NSpace,
  NTag,
  useMessage,
} from "naive-ui";
import { RefreshOutline, DownloadOutline } from "@vicons/ionicons5";
import { useI18n } from "vue-i18n";
import {
  configApi,
  type AgentRunMonitoringItem,
  type AgentRunMonitoringResponse,
  type AgentRunStatus,
} from "@/api/config";

const message = useMessage();
const router = useRouter();
const { t } = useI18n();
const loading = ref(false);
const exporting = ref(false);
const status = ref<AgentRunStatus | null>(null);
const data = ref<AgentRunMonitoringResponse | null>(null);
const page = ref(1);
const pageSize = 20;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

type StatTone = "info" | "warning" | "success";
interface StatItem {
  label: string;
  value: string;
  tone?: StatTone;
}
interface StatGroup {
  title: string;
  items: StatItem[];
}

const statGroups = computed<StatGroup[]>(() => {
  const s = data.value?.summary;
  const reuseRate =
    s && s.total > 0
      ? `${((s.snapshot_runs / s.total) * 100).toFixed(1)}%`
      : "—";
  return [
    {
      title: t("workerMonitoring.groups.tasks"),
      items: [
        {
          label: t("workerMonitoring.stats.totalTasks"),
          value: formatNumber(s?.total ?? 0),
        },
        {
          label: t("workerMonitoring.stats.running"),
          value: formatNumber(s?.running ?? 0),
          tone: "info",
        },
        {
          label: t("workerMonitoring.stats.queued"),
          value: formatNumber(s?.queued ?? 0),
          tone: "warning",
        },
        {
          label: t("workerMonitoring.stats.completed"),
          value: formatNumber(s?.completed ?? 0),
          tone: "success",
        },
      ],
    },
    {
      title: t("workerMonitoring.groups.usage"),
      items: [
        {
          label: t("workerMonitoring.stats.inputTokens"),
          value: formatNumber(s?.input_tokens ?? 0),
        },
        {
          label: t("workerMonitoring.stats.outputTokens"),
          value: formatNumber(s?.output_tokens ?? 0),
        },
        {
          label: t("workerMonitoring.stats.totalCost"),
          value: formatCost(s?.cost ?? 0),
        },
        {
          label: t("workerMonitoring.stats.avgDuration"),
          value:
            s?.avg_duration_ms == null
              ? "—"
              : formatDuration(Math.round(s.avg_duration_ms)),
        },
      ],
    },
    {
      title: t("workerMonitoring.groups.snapshots"),
      items: [
        {
          label: t("workerMonitoring.stats.snapshotsReady"),
          value: formatNumber(s?.snapshots.ready ?? 0),
        },
        {
          label: t("workerMonitoring.stats.snapshotSize"),
          value: formatSize(s?.snapshots.total_size ?? 0),
        },
        {
          label: t("workerMonitoring.stats.fileCount"),
          value: formatNumber(s?.snapshots.file_count ?? 0),
        },
        {
          label: t("workerMonitoring.stats.reuseRate"),
          value: reuseRate,
        },
      ],
    },
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

const statusOptions = computed(() =>
  (
    [
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
      "timed_out",
      "budget_exceeded",
      "expired",
    ] as AgentRunStatus[]
  ).map((value) => ({
    label: t(`workerMonitoring.status.${value}`),
    value,
  })),
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

const columns = computed<DataTableColumns<AgentRunMonitoringItem>>(() => [
  {
    title: t("workerMonitoring.table.plugin"),
    key: "plugin_id",
    minWidth: 210,
    render: (row) =>
      h("div", null, [
        h("div", { style: "font-weight: 500" }, row.plugin_id),
        h(
          "code",
          { style: "font-size: 12px; color: #888" },
          `${row.id} · v${row.plugin_version} · ${row.model_profile}`,
        ),
      ]),
  },
  {
    title: t("workerMonitoring.table.status"),
    key: "status",
    width: 110,
    render: (row) =>
      h(
        NTag,
        { type: statusTypes[row.status], bordered: false },
        { default: () => t(`workerMonitoring.status.${row.status}`) },
      ),
  },
  {
    title: t("workerMonitoring.table.createdAt"),
    key: "created_at",
    width: 180,
    render: (row) => formatTime(row.created_at),
  },
  {
    title: t("workerMonitoring.table.duration"),
    key: "duration_ms",
    width: 110,
    render: (row) => formatDuration(row.duration_ms),
  },
  {
    title: t("workerMonitoring.table.inputTokens"),
    key: "input",
    width: 110,
    render: (row) => formatNumber(row.usage?.input_tokens ?? 0),
  },
  {
    title: t("workerMonitoring.table.outputTokens"),
    key: "output",
    width: 110,
    render: (row) => formatNumber(row.usage?.output_tokens ?? 0),
  },
  {
    title: t("workerMonitoring.table.turnsTools"),
    key: "turns",
    width: 120,
    render: (row) =>
      `${row.usage?.turn_count ?? 0} / ${row.usage?.tool_call_count ?? 0}`,
  },
  {
    title: t("workerMonitoring.table.cost"),
    key: "cost",
    width: 100,
    render: (row) => formatCost(row.usage?.cost ?? 0),
  },
  {
    title: t("workerMonitoring.table.error"),
    key: "error_message",
    minWidth: 180,
    ellipsis: { tooltip: true },
    render: (row) => row.error_message || "—",
  },
  {
    title: t("workerMonitoring.table.actions"),
    key: "actions",
    width: 90,
    render: (row) =>
      h(
        NButton,
        {
          size: "small",
          quaternary: true,
          type: "primary",
          onClick: (e: MouseEvent) => {
            e.stopPropagation();
            openDetail(row);
          },
        },
        { default: () => t("workerMonitoring.viewRun") },
      ),
  },
]);

function openDetail(row: AgentRunMonitoringItem) {
  router.push(`/worker-monitoring/runs/${row.id}`);
}

function rowProps(row: AgentRunMonitoringItem) {
  return {
    style: "cursor: pointer",
    onClick: () => openDetail(row),
  };
}

// 导出的是当前筛选下的全量行（分页拉取），而非仅当前已加载页；
// 上限防住异常大的导出 —— 超出时管理员应先收窄筛选。
const CSV_EXPORT_ROW_CAP = 2000;

async function exportCsv() {
  if (exporting.value) return;
  exporting.value = true;
  try {
    const rows: AgentRunMonitoringItem[] = [];
    for (;;) {
      const page = await configApi.getAgentRunMonitoring({
        status: status.value ?? undefined,
        limit: 100,
        offset: rows.length,
      });
      rows.push(...page.items);
      if (page.items.length < 100 || rows.length >= CSV_EXPORT_ROW_CAP) break;
    }
    downloadCsv(rows);
    message.success(
      t("workerMonitoring.exportDone", { count: rows.length }),
    );
  } catch (error: any) {
    message.error(error?.message || t("workerMonitoring.exportFailed"));
  } finally {
    exporting.value = false;
  }
}

function csvEscape(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  // 防 CSV 公式注入：危险前缀且非纯数字时补单引号
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadCsv(rows: AgentRunMonitoringItem[]) {
  const header = [
    "run_id",
    "plugin_id",
    "plugin_version",
    "model_profile",
    "source_type",
    "status",
    "created_at",
    "started_at",
    "completed_at",
    "duration_ms",
    "turn_count",
    "tool_call_count",
    "input_tokens",
    "output_tokens",
    "cost_usd",
    "error_code",
    "error_message",
  ];
  const lines = [header.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.plugin_id,
        row.plugin_version,
        row.model_profile,
        row.source_type,
        row.status,
        row.created_at ? new Date(row.created_at).toISOString() : "",
        row.started_at ? new Date(row.started_at).toISOString() : "",
        row.completed_at ? new Date(row.completed_at).toISOString() : "",
        row.duration_ms ?? "",
        row.usage?.turn_count ?? "",
        row.usage?.tool_call_count ?? "",
        row.usage?.input_tokens ?? "",
        row.usage?.output_tokens ?? "",
        row.usage?.cost ?? "",
        row.error_code ?? "",
        row.error_message ?? "",
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  // BOM 保证 Excel 中文不乱码
  const blob = new Blob([`\uFEFF${lines.join("\n")}`], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  anchor.download = `agent-runs-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

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
    message.error(error?.message || t("workerMonitoring.loadFailed"));
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
  margin-bottom: 16px;
  flex-wrap: wrap;
}

/* 仅本视图内抹平全局卡片的阴影与大圆角，换成 hairline 扁平风 */
.worker-monitoring-view :deep(.n-card) {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  box-shadow: none;
}
.worker-monitoring-view :deep(.n-card:hover) {
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
  background: var(--color-success);
}

.stat-panel {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
}
.stat-group {
  min-width: 0;
  padding: 14px 20px 16px;
}
.stat-group + .stat-group {
  border-left: 1px solid #e5e7eb;
}
.stat-group-title {
  margin-bottom: 12px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: #8c8c8c;
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
}
.stat-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #8c8c8c;
  white-space: nowrap;
}
.stat-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.stat-dot.info {
  background: var(--color-info);
}
.stat-dot.warning {
  background: var(--color-warning);
}
.stat-dot.success {
  background: var(--color-success);
}
.stat-value {
  margin-top: 2px;
  font-size: 20px;
  font-weight: 600;
  color: #1f1f1f;
  font-variant-numeric: tabular-nums;
}

.runs-card {
  margin-top: 16px;
}

@media (max-width: 960px) {
  .stat-panel {
    grid-template-columns: 1fr;
  }
  .stat-group + .stat-group {
    border-left: none;
    border-top: 1px solid #e5e7eb;
  }
}
</style>

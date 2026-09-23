<template>
  <div class="ops-monitoring-container">
    <div class="page-header">
      <div class="page-title-section">
        <h1 class="page-title">{{ t("operationsMonitoring.title") }}</h1>
        <div class="page-subtitle">
          {{ t("operationsMonitoring.subtitle") }}
        </div>
      </div>
      <div class="page-actions">
        <n-radio-group v-model:value="period" size="medium">
          <n-radio-button value="24h">{{
            t("operationsMonitoring.period.last24h")
          }}</n-radio-button>
          <n-radio-button value="7d">{{
            t("operationsMonitoring.period.last7d")
          }}</n-radio-button>
          <n-radio-button value="30d">{{
            t("operationsMonitoring.period.last30d")
          }}</n-radio-button>
        </n-radio-group>
        <n-button secondary round :loading="loading" :disabled="loading" @click="refresh()">
          <template #icon>
            <n-icon><RefreshOutline /></n-icon>
          </template>
          {{ t("common.refresh") }}
        </n-button>
      </div>
    </div>

    <!-- Window metadata + coverage, identical across all requests of one refresh cycle -->
    <div v-if="overview" class="window-info-bar">
      <span class="window-info-item">
        {{ t("operationsMonitoring.window.range") }}:
        <n-text strong
          >{{ formatShanghaiTime(overview.window.startTime) }} ~
          {{ formatShanghaiTime(overview.window.endTime) }}</n-text
        >
        <n-text depth="3" style="margin-left: 6px">{{
          overview.window.timezone
        }}</n-text>
      </span>
      <n-tag size="small" :bordered="false" type="warning">
        {{ t("operationsMonitoring.window.samplingNote") }}
      </n-tag>
      <span class="window-info-item">
        {{ t("operationsMonitoring.window.updated") }}:
        <n-text strong>{{ formatShanghaiDateTime(overview.updatedAt) }}</n-text>
      </span>
      <n-tag
        v-if="coverage?.exact"
        size="small"
        :bordered="false"
        type="success"
      >
        {{ t("operationsMonitoring.coverage.exact") }}
      </n-tag>
    </div>

    <n-alert
      v-if="coverage && !coverage.exact"
      type="warning"
      class="coverage-alert"
      :show-icon="true"
    >
      {{ t("operationsMonitoring.coverage.gapWarning") }}
      <template v-if="coverage.gaps.length > 0">
        （{{ coverage.gaps.length }} 段）
      </template>
      <div class="coverage-detail">
        {{ t("operationsMonitoring.coverage.detailSince") }}
        {{ formatShanghaiDateTime(coverage.detailStart) }}
        <template v-if="coverage.hourlyFrom && coverage.hourlyTo">
          · {{ t("operationsMonitoring.coverage.hourlyRange") }}
          {{ formatShanghaiTime(coverage.hourlyFrom) }} ~
          {{ formatShanghaiTime(coverage.hourlyTo) }}
        </template>
      </div>
    </n-alert>

    <n-alert
      v-if="overview && !loading && overview.metrics.requestCount === 0"
      type="info"
      class="coverage-alert"
      :show-icon="true"
    >
      {{ t("operationsMonitoring.empty.zeroRequests") }}
    </n-alert>

    <n-card class="filter-card" :bordered="false">
      <n-space align="center" :wrap="true" :size="16">
        <div class="filter-item">
          <div class="filter-label">
            {{ t("operationsMonitoring.filters.virtualKey") }}
          </div>
          <n-select
            v-model:value="filterVirtualKeyId"
            :options="keyOptions"
            :placeholder="t('operationsMonitoring.filters.allVirtualKeys')"
            clearable
            filterable
            remote
            :style="{ width: '220px' }"
            @search="(query: string) => handleFilterSearch('virtualKey', query)"
          />
        </div>
        <div class="filter-item">
          <div class="filter-label">
            {{ t("operationsMonitoring.filters.model") }}
          </div>
          <n-select
            v-model:value="filterModel"
            :options="modelOptions"
            :placeholder="t('operationsMonitoring.filters.allModels')"
            clearable
            filterable
            remote
            tag
            :style="{ width: '220px' }"
            @search="(query: string) => handleFilterSearch('model', query)"
          />
        </div>
        <div class="filter-item">
          <div class="filter-label">
            {{ t("operationsMonitoring.filters.provider") }}
          </div>
          <n-select
            v-model:value="filterProviderId"
            :options="providerOptions"
            :placeholder="t('operationsMonitoring.filters.allProviders')"
            clearable
            filterable
            remote
            :style="{ width: '200px' }"
            @search="(query: string) => handleFilterSearch('provider', query)"
          />
        </div>
        <n-button :disabled="!hasActiveFilters" @click="clearFilters">
          <template #icon>
            <n-icon><CloseOutline /></n-icon>
          </template>
          {{ t("operationsMonitoring.filters.clear") }}
        </n-button>
      </n-space>
    </n-card>

    <n-card :bordered="false" class="content-card">
      <n-tabs
        v-model:value="activeTab"
        type="line"
        :animated="false"
        @update:value="handleTabChange"
      >
        <n-tab-pane
          name="overview"
          :tab="t('operationsMonitoring.tabs.overview')"
        >
          <div v-if="loading" class="loading-container">
            <n-skeleton
              text
              :repeat="2"
              style="height: 96px; margin-bottom: 16px"
            />
            <n-skeleton text style="height: 340px" />
          </div>
          <template v-else-if="overview">
            <n-grid
              :cols="2"
              :x-gap="16"
              :y-gap="16"
              responsive="screen"
              item-responsive
            >
              <n-gi
                v-for="card in metricCards"
                :key="card.key"
                span="1 m:1 l:1"
                class="metric-gi"
              >
                <div class="summary-card">
                  <div class="summary-header">
                    <span>{{ card.label }}</span>
                    <n-tooltip v-if="card.tip" trigger="hover">
                      <template #trigger>
                        <n-icon size="14" depth="3"
                          ><InformationCircleOutline
                        /></n-icon>
                      </template>
                      {{ card.tip }}
                    </n-tooltip>
                  </div>
                  <div class="summary-value">
                    {{ card.value
                    }}<span v-if="card.unit" class="summary-unit">{{
                      card.unit
                    }}</span>
                  </div>
                  <div v-if="card.sub" class="summary-sub">{{ card.sub }}</div>
                </div>
              </n-gi>
            </n-grid>

            <n-card
              :title="t('operationsMonitoring.trend.title')"
              class="trend-card"
              :bordered="false"
              size="small"
            >
              <template #header-extra>
                <n-space :size="12" align="center">
                  <span class="trend-legend-hint">
                    <span class="partial-dot" />
                    {{ t("operationsMonitoring.trend.partial") }}
                    <span class="gap-dot" />
                    {{ t("operationsMonitoring.trend.gap") }}
                  </span>
                  <n-text depth="3" style="font-size: 12px">
                    {{
                      trend?.granularity === "hour"
                        ? t("operationsMonitoring.period.last24h")
                        : granularityDayLabel
                    }}
                  </n-text>
                </n-space>
              </template>
              <v-chart
                v-if="hasTrendData"
                class="trend-chart"
                :option="trendChartOption"
                autoresize
                @click="handleTrendClick"
              />
              <n-empty
                v-else
                :description="t('operationsMonitoring.trend.empty')"
                style="padding: 48px 0"
              />
            </n-card>

            <n-grid
              :cols="1"
              :x-gap="16"
              :y-gap="16"
              responsive="screen"
              item-responsive
              class="ranking-grid"
            >
              <n-gi span="1 m:1 l:1">
                <n-card size="small" :bordered="false" class="ranking-card">
                  <template #header>
                    <n-space align="center" :size="12">
                      {{ t("operationsMonitoring.ranking.topModels") }}
                      <n-radio-group v-model:value="rankingSort" size="small" @update:value="handleRankingSortChange">
                        <n-radio-button value="requestCount">{{
                          t("operationsMonitoring.ranking.byRequests")
                        }}</n-radio-button>
                        <n-radio-button value="failureCount">{{
                          t("operationsMonitoring.ranking.byFailures")
                        }}</n-radio-button>
                      </n-radio-group>
                    </n-space>
                  </template>
                  <template #header-extra>
                    <n-button text size="small" @click="goToTab('model')">
                      {{ t("operationsMonitoring.ranking.more") }}
                    </n-button>
                  </template>
                  <div v-if="modelRanking.length === 0" class="ranking-empty">
                    —
                  </div>
                  <div
                    v-for="item in modelRanking"
                    :key="item.id ?? '__unknown__'"
                    class="ranking-row"
                    @click="setModelFilter(item.name)"
                  >
                    <span class="ranking-name" :title="item.name">{{
                      item.name
                    }}</span>
                    <span class="ranking-metrics">
                      <span class="ranking-count">{{
                        formatCount(item.requestCount)
                      }}</span>
                      <span
                        class="ranking-rate"
                        :class="{
                          'ranking-rate-bad':
                            item.successRate !== null &&
                            item.failureCount > 0 &&
                            item.successRate < 0.9,
                        }"
                      >
                        {{ formatSuccessRate(item.successRate) }}
                      </span>
                    </span>
                  </div>
                </n-card>
              </n-gi>
              <n-gi span="1 m:1 l:1">
                <n-card size="small" :bordered="false" class="ranking-card">
                  <template #header>
                    {{ t("operationsMonitoring.ranking.topProviders") }}
                  </template>
                  <template #header-extra>
                    <n-button text size="small" @click="goToTab('provider')">
                      {{ t("operationsMonitoring.ranking.more") }}
                    </n-button>
                  </template>
                  <div
                    v-if="providerRanking.length === 0"
                    class="ranking-empty"
                  >
                    —
                  </div>
                  <div
                    v-for="item in providerRanking"
                    :key="item.id ?? '__unknown__'"
                    class="ranking-row"
                    @click="setProviderFilter(item.id)"
                  >
                    <span class="ranking-name" :title="item.name">{{
                      item.name
                    }}</span>
                    <span class="ranking-metrics">
                      <span class="ranking-count">{{
                        formatCount(item.requestCount)
                      }}</span>
                      <span
                        class="ranking-rate"
                        :class="{
                          'ranking-rate-bad':
                            item.successRate !== null &&
                            item.failureCount > 0 &&
                            item.successRate < 0.9,
                        }"
                      >
                        {{ formatSuccessRate(item.successRate) }}
                      </span>
                    </span>
                  </div>
                </n-card>
              </n-gi>
            </n-grid>
          </template>
        </n-tab-pane>

        <n-tab-pane
          v-for="dim in DIMENSIONS"
          :key="dim"
          :name="dim"
          :tab="t(`operationsMonitoring.tabs.${dim === 'virtualKey' ? 'virtualKeys' : dim === 'model' ? 'models' : 'providers'}`)"
        >
          <div class="dimension-toolbar">
            <n-input
              v-model:value="dimStates[dim].search"
              clearable
              :placeholder="
                t(
                  `operationsMonitoring.filters.search${dim === 'virtualKey' ? 'VirtualKey' : dim === 'model' ? 'Model' : 'Provider'}`,
                )
              "
              :style="{ width: '260px' }"
              @input="handleDimensionSearch(dim)"
            >
              <template #prefix>
                <n-icon><SearchOutline /></n-icon>
              </template>
            </n-input>
            <n-text depth="3" style="font-size: 12px">
              {{ t("operationsMonitoring.window.samplingNote") }}
            </n-text>
          </div>
          <n-data-table
            :columns="dimensionColumns[dim]"
            :data="dimStates[dim].items"
            :loading="dimStates[dim].loading"
            :pagination="dimensionPagination[dim]"
            :row-key="(row: OpsDimensionItem) => row.id ?? `__unknown_${dim}`"
            remote
            striped
            :scroll-x="dim === 'virtualKey' ? 1280 : 1500"
            :max-height="560"
            @update:sorter="
              (sorter: TableSorter | TableSorter[]) =>
                handleDimensionSorter(dim, sorter)
            "
          />
        </n-tab-pane>
      </n-tabs>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import {
  ref,
  reactive,
  computed,
  watch,
  onMounted,
  onBeforeUnmount,
  h,
  type VNode,
} from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import {
  useMessage,
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NEmpty,
  NGi,
  NGrid,
  NIcon,
  NInput,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSkeleton,
  NSpace,
  NTabPane,
  NTabs,
  NTag,
  NText,
  NTooltip,
} from "naive-ui";
import type { DataTableColumns, PaginationProps } from "naive-ui";

// naive-ui does not export SorterInfo in this version
interface TableSorter {
  columnKey: string;
  order: "ascend" | "descend" | false;
}
import VChart from "vue-echarts";
import {
  RefreshOutline,
  CloseOutline,
  SearchOutline,
  InformationCircleOutline,
  CopyOutline,
  DocumentTextOutline,
  TrendingUpOutline,
} from "@vicons/ionicons5";
import {
  opsMetricsApi,
  type OpsPeriod,
  type OpsDimension,
  type OpsOverviewResponse,
  type OpsTrendResponse,
  type OpsTrendPoint,
  type OpsDimensionItem,
  type OpsCoverage,
  type OpsFilters,
} from "@/api/ops-metrics";
import { copyToClipboard } from "@/utils/common";
import { formatTokenNumber } from "@/utils/format";

const { t, locale } = useI18n();
const message = useMessage();
const router = useRouter();

type TabKey = "overview" | OpsDimension;

interface DimState {
  items: OpsDimensionItem[];
  total: number;
  page: number;
  pageSize: number;
  sortBy: string | undefined;
  sortOrder: "asc" | "desc" | undefined;
  search: string;
  loading: boolean;
  searchTimer: ReturnType<typeof setTimeout> | null;
  loadedSig: string | null;
  requestId: number;
}

const loading = ref(false);
const period = ref<OpsPeriod>("24h");
const activeTab = ref<TabKey>("overview");

const filterVirtualKeyId = ref<string | null>(null);
const filterModel = ref<string | null>(null);
const filterProviderId = ref<string | null>(null);

const overview = ref<OpsOverviewResponse | null>(null);
const trend = ref<OpsTrendResponse | null>(null);

// Sampling instant pinned once per refresh/condition change so every card,
// chart and table of this cycle reports the identical window.
let pinnedEndTime: number | null = null;
let refreshId = 0;

const DIMENSIONS: readonly OpsDimension[] = ["virtualKey", "model", "provider"];

function createDimState(): DimState {
  return {
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    sortBy: undefined,
    sortOrder: undefined,
    search: "",
    loading: false,
    searchTimer: null,
    loadedSig: null,
    requestId: 0,
  };
}

const dimStates = reactive<Record<OpsDimension, DimState>>({
  virtualKey: createDimState(),
  model: createDimState(),
  provider: createDimState(),
});

const rankingSort = ref<"requestCount" | "failureCount">("requestCount");
const modelRanking = ref<OpsDimensionItem[]>([]);
const providerRanking = ref<OpsDimensionItem[]>([]);
let rankingSig: string | null = null;

const keyOptions = ref<Array<{ label: string; value: string }>>([]);
const modelOptions = ref<Array<{ label: string; value: string }>>([]);
const providerOptions = ref<Array<{ label: string; value: string }>>([]);
const filterOptionRequests: Record<OpsDimension, number> = {
  virtualKey: 0,
  model: 0,
  provider: 0,
};
const filterSearchTimers: Partial<Record<OpsDimension, ReturnType<typeof setTimeout>>> = {};

const coverage = computed<OpsCoverage | null>(
  () => overview.value?.dataCoverage ?? null,
);

const hasActiveFilters = computed(
  () =>
    filterVirtualKeyId.value !== null ||
    filterModel.value !== null ||
    filterProviderId.value !== null,
);

function currentFilters(): OpsFilters {
  const filters: OpsFilters = {};
  if (filterVirtualKeyId.value) filters.virtualKeyId = filterVirtualKeyId.value;
  if (filterModel.value) filters.model = filterModel.value;
  if (filterProviderId.value) filters.providerId = filterProviderId.value;
  return filters;
}

function baseQuery() {
  return {
    period: period.value,
    endTime: pinnedEndTime ?? Date.now(),
    ...currentFilters(),
  };
}

function currentSignature() {
  return [
    period.value,
    filterVirtualKeyId.value ?? "",
    filterModel.value ?? "",
    filterProviderId.value ?? "",
    pinnedEndTime ?? "",
  ].join("|");
}

// ---------- formatting ----------

const shanghaiLocale = computed(() =>
  locale.value === "zh-CN" ? "zh-CN" : "en-US",
);

function formatShanghaiTime(ts: number): string {
  return new Intl.DateTimeFormat(shanghaiLocale.value, {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ts));
}

function formatShanghaiDateTime(ts: number): string {
  return new Intl.DateTimeFormat(shanghaiLocale.value, {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ts));
}

function formatCount(num: number): string {
  return formatTokenNumber(num);
}

function formatSuccessRate(rate: number | null): string {
  if (rate === null) return t("operationsMonitoring.metrics.noValue");
  return `${(rate * 100).toFixed(1)}%`;
}

function formatSpeed(value: number | null): string {
  if (value === null) return t("operationsMonitoring.metrics.noValue");
  return `${value.toFixed(1)} tok/s`;
}

function formatLastUsed(ts: number | null): string {
  if (ts === null) return t("operationsMonitoring.metrics.noValue");
  return formatShanghaiDateTime(ts);
}

// ---------- data loading ----------

async function refresh(force = false) {
  if (loading.value && !force) return;
  loading.value = true;
  const requestId = ++refreshId;
  pinnedEndTime = Date.now();
  const sig = currentSignature();
  const base = baseQuery();
  try {
    await Promise.all([
      opsMetricsApi.getOverview(base).then((result) => {
        if (requestId === refreshId) overview.value = result;
      }),
      opsMetricsApi.getTrend(base).then((result) => {
        if (requestId === refreshId) trend.value = result;
      }),
      loadFilterOptions(),
      activeTab.value === "overview"
        ? loadRankings(sig)
        : loadDimension(activeTab.value, sig),
    ]);
  } catch (error) {
    if (requestId === refreshId) {
      console.error("Failed to load ops metrics:", error);
      message.error(t("operationsMonitoring.loadFailed"));
    }
  } finally {
    if (requestId === refreshId) loading.value = false;
  }
}

async function loadFilterOptions() {
  await Promise.all(DIMENSIONS.map((dim) => loadFilterOption(dim, "")));
}

async function loadFilterOption(dim: OpsDimension, search: string) {
  // The dimension endpoint supplies masked keys only; search server-side
  // because the initial page is capped at 100 options.
  const requestId = ++filterOptionRequests[dim];
  const sig = currentSignature();
  const query = baseQuery();
  if (dim === "virtualKey") delete query.virtualKeyId;
  if (dim === "model") delete query.model;
  if (dim === "provider") delete query.providerId;
  const result = await opsMetricsApi.getDimensionList(dim, {
    ...query,
    search: search || undefined,
    pageSize: 100,
  });
  if (requestId !== filterOptionRequests[dim] || sig !== currentSignature())
    return;
  const options =
    dim === "virtualKey"
      ? keyOptions
      : dim === "model"
        ? modelOptions
        : providerOptions;
  const selected =
    dim === "virtualKey"
      ? filterVirtualKeyId.value
      : dim === "model"
        ? filterModel.value
        : filterProviderId.value;
  const previous = options.value.find((option) => option.value === selected);
  const next = result.items
    .filter((item) => item.id !== null)
    .map((item) => ({
      label:
        dim === "virtualKey" && item.maskedKey
          ? `${item.name} (${item.maskedKey})`
          : item.name,
      value: item.id as string,
    }));
  if (selected && !next.some((option) => option.value === selected)) {
    next.unshift(previous ?? { label: selected, value: selected });
  }
  options.value = next;
}

function handleFilterSearch(dim: OpsDimension, search: string) {
  clearTimeout(filterSearchTimers[dim]);
  filterSearchTimers[dim] = setTimeout(() => {
    loadFilterOption(dim, search).catch(() => {
      message.error(t("operationsMonitoring.loadFailed"));
    });
  }, 300);
}

async function loadDimension(dim: OpsDimension, sig: string) {
  const state = dimStates[dim];
  if (state.loadedSig === sig && !state.loading) return;
  state.loading = true;
  const requestId = ++state.requestId;
  try {
    const res = await opsMetricsApi.getDimensionList(dim, {
      ...baseQuery(),
      search: state.search || undefined,
      sortBy: state.sortBy,
      sortOrder: state.sortOrder,
      page: state.page,
      pageSize: state.pageSize,
    });
    if (requestId === state.requestId && sig === currentSignature()) {
      state.items = res.items;
      state.total = res.pagination.total;
      state.loadedSig = sig;
    }
  } finally {
    if (requestId === state.requestId) state.loading = false;
  }
}

async function loadRankings(sig: string) {
  const sortField = rankingSort.value;
  const rankingKey = `${sig}|${sortField}`;
  if (rankingSig === rankingKey) return;
  const base = baseQuery();
  const [models, providers] = await Promise.all([
    opsMetricsApi.getDimensionList("model", {
      ...base,
      pageSize: 5,
      sortBy: sortField,
    }),
    opsMetricsApi.getDimensionList("provider", {
      ...base,
      pageSize: 5,
      sortBy: sortField,
    }),
  ]);
  if (sig !== currentSignature() || sortField !== rankingSort.value) return;
  modelRanking.value = models.items;
  providerRanking.value = providers.items;
  rankingSig = rankingKey;
}

function handleRankingSortChange(sort: "requestCount" | "failureCount") {
  rankingSort.value = sort;
  loadRankings(currentSignature()).catch(() => {
    message.error(t("operationsMonitoring.loadFailed"));
  });
}

function handleTabChange(tab: string) {
  const sig = currentSignature();
  if (tab === "overview") {
    if (overview.value) {
      loadRankings(sig).catch(() => {});
    }
    return;
  }
  loadDimension(tab as OpsDimension, sig).catch(() => {});
}

function handleDimensionSearch(dim: OpsDimension) {
  const state = dimStates[dim];
  if (state.searchTimer) clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => {
    state.page = 1;
    state.loadedSig = null;
    loadDimension(dim, currentSignature()).catch(() => {});
  }, 400);
}

function handleDimensionSorter(
  dim: OpsDimension,
  sorter: TableSorter | TableSorter[],
) {
  const one = Array.isArray(sorter) ? sorter[0] : sorter;
  const state = dimStates[dim];
  if (!one || !one.order) {
    state.sortBy = undefined;
    state.sortOrder = undefined;
  } else {
    state.sortBy = String(one.columnKey);
    state.sortOrder = one.order === "ascend" ? "asc" : "desc";
  }
  state.page = 1;
  state.loadedSig = null;
  loadDimension(dim, currentSignature()).catch(() => {});
}

function dimensionPaginationFor(dim: OpsDimension): PaginationProps {
  const state = dimStates[dim];
  return {
    page: state.page,
    pageSize: state.pageSize,
    itemCount: state.total,
    pageSizes: [10, 20, 50, 100],
    showSizePicker: true,
    prefix: (info) => `共 ${info.itemCount ?? 0} 条`,
    onChange: (page: number) => {
      state.page = page;
      state.loadedSig = null;
      loadDimension(dim, currentSignature()).catch(() => {});
    },
    onUpdatePageSize: (pageSize: number) => {
      state.pageSize = pageSize;
      state.page = 1;
      state.loadedSig = null;
      loadDimension(dim, currentSignature()).catch(() => {});
    },
  };
}

const dimensionPagination = computed<Record<OpsDimension, PaginationProps>>(
  () => ({
    virtualKey: dimensionPaginationFor("virtualKey"),
    model: dimensionPaginationFor("model"),
    provider: dimensionPaginationFor("provider"),
  }),
);

// ---------- filter actions ----------

function clearFilters() {
  filterVirtualKeyId.value = null;
  filterModel.value = null;
  filterProviderId.value = null;
}

function setModelFilter(model: string) {
  filterModel.value = model;
  activeTab.value = "model";
}

function setProviderFilter(providerId: string | null) {
  if (providerId === null) return;
  filterProviderId.value = providerId;
  activeTab.value = "provider";
}

function goToTab(tab: TabKey) {
  activeTab.value = tab;
}

// Filter changes re-pin endTime (per PRD: fixed on refresh or condition change).
watch([period, filterVirtualKeyId, filterModel, filterProviderId], () => {
  refresh(true);
});

// ---------- overview metric cards ----------

interface MetricCard {
  key: string;
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  tip?: string;
}

const granularityDayLabel = computed(() =>
  period.value === "7d"
    ? t("operationsMonitoring.period.last7d")
    : t("operationsMonitoring.period.last30d"),
);

const metricCards = computed<MetricCard[]>(() => {
  const m = overview.value?.metrics;
  if (!m) return [];
  return [
    {
      key: "requestCount",
      label: t("operationsMonitoring.metrics.requestCount"),
      value: formatCount(m.requestCount),
    },
    {
      key: "successCount",
      label: t("operationsMonitoring.metrics.successCount"),
      value: formatCount(m.successCount),
    },
    {
      key: "failureCount",
      label: t("operationsMonitoring.metrics.failureCount"),
      value: formatCount(m.failureCount),
    },
    {
      key: "successRate",
      label: t("operationsMonitoring.metrics.successRate"),
      value: formatSuccessRate(m.successRate),
      sub: `${t("operationsMonitoring.metrics.successCount")} ${formatCount(m.successCount)} / ${t("operationsMonitoring.metrics.requestCount")} ${formatCount(m.requestCount)}`,
    },
    {
      key: "totalTokens",
      label: t("operationsMonitoring.metrics.totalTokens"),
      value: formatCount(m.totalTokens),
      tip: t("operationsMonitoring.metrics.tokenNote"),
    },
    {
      key: "promptTokens",
      label: t("operationsMonitoring.metrics.promptTokens"),
      value: formatCount(m.promptTokens),
    },
    {
      key: "completionTokens",
      label: t("operationsMonitoring.metrics.completionTokens"),
      value: formatCount(m.completionTokens),
    },
    {
      key: "cachedTokens",
      label: t("operationsMonitoring.metrics.cachedTokens"),
      value: formatCount(m.cachedTokens),
    },
    {
      key: "avgTffbMs",
      label: t("operationsMonitoring.metrics.avgTffb"),
      value:
        m.avgTffbMs === null
          ? t("operationsMonitoring.metrics.noValue")
          : Math.round(m.avgTffbMs).toLocaleString(),
      unit: m.avgTffbMs === null ? undefined : "ms",
      sub: t("operationsMonitoring.metrics.samples", {
        n: formatCount(m.validTffbCount),
      }),
    },
    {
      key: "avgResponseTimeMs",
      label: t("operationsMonitoring.metrics.avgResponseTime"),
      value:
        m.avgResponseTimeMs === null
          ? t("operationsMonitoring.metrics.noValue")
          : Math.round(m.avgResponseTimeMs).toLocaleString(),
      unit: m.avgResponseTimeMs === null ? undefined : "ms",
      sub: t("operationsMonitoring.metrics.samples", {
        n: formatCount(m.validResponseTimeCount),
      }),
    },
    {
      key: "avgOutputSpeed",
      label: t("operationsMonitoring.metrics.avgOutputSpeed"),
      value: formatSpeed(m.avgOutputSpeed).replace(" tok/s", ""),
      unit: m.avgOutputSpeed === null ? undefined : "tok/s",
      sub: t("operationsMonitoring.metrics.perRequestSpeed"),
    },
  ];
});

// ---------- trend chart ----------

const hasTrendData = computed(
  () =>
    !!trend.value &&
    trend.value.points.some(
      (p) => p.requestCount !== null && p.requestCount > 0,
    ),
);

function bucketLabel(
  point: OpsTrendPoint,
  granularity: "hour" | "day",
): string {
  return new Intl.DateTimeFormat(shanghaiLocale.value, {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    ...(granularity === "hour" ? { hour: "2-digit", minute: "2-digit" } : {}),
    hour12: false,
  }).format(new Date(point.bucketStart));
}

const trendChartOption = computed(() => {
  if (!trend.value) return {};
  const granularity = trend.value.granularity;
  const labels = trend.value.points.map((p) => bucketLabel(p, granularity));
  const barData = trendBarDataWithStyle(trend.value.points);
  const rates = trend.value.points.map((p) =>
    p.successRate === null ? null : Number((p.successRate * 100).toFixed(2)),
  );

  return {
    tooltip: {
      trigger: "axis",
      confine: true,
      formatter: (params: Array<{ dataIndex: number }>) => {
        const idx = params[0]?.dataIndex ?? 0;
        const p = trend.value?.points[idx];
        if (!p) return "";
        const lines = [
          `${formatShanghaiTime(p.bucketStart)} ~ ${formatShanghaiTime(p.bucketEnd)}`,
        ];
        if (p.gap) {
          lines.push(t("operationsMonitoring.trend.gap"));
        } else if (p.requestCount === null) {
          lines.push(t("operationsMonitoring.trend.empty"));
        } else {
          lines.push(
            `${t("operationsMonitoring.trend.requests")}: ${p.requestCount.toLocaleString()}`,
          );
          if (p.successRate !== null) {
            lines.push(
              `${t("operationsMonitoring.trend.successRate")}: ${(p.successRate * 100).toFixed(1)}%`,
            );
          }
        }
        if (p.partial) {
          lines.push(t("operationsMonitoring.trend.partial"));
        }
        return lines.join("<br/>");
      },
    },
    legend: {
      data: [
        t("operationsMonitoring.trend.requests"),
        t("operationsMonitoring.trend.successRate"),
      ],
      bottom: 0,
    },
    grid: {
      left: "3%",
      right: "4%",
      bottom: "12%",
      top: "10%",
      containLabel: true,
    },
    xAxis: {
      type: "category",
      data: labels,
      axisLabel: {
        rotate: granularity === "day" && period.value === "30d" ? 45 : 0,
        fontSize: 11,
      },
    },
    yAxis: [
      { type: "value", name: t("operationsMonitoring.trend.requests") },
      {
        type: "value",
        name: "%",
        min: 0,
        max: 100,
        axisLabel: { formatter: "{value}%" },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: t("operationsMonitoring.trend.requests"),
        type: "bar",
        data: barData,
        itemStyle: { color: "#2080f0", borderRadius: [3, 3, 0, 0] },
      },
      {
        name: t("operationsMonitoring.trend.successRate"),
        type: "line",
        yAxisIndex: 1,
        data: rates,
        connectNulls: false,
        itemStyle: { color: "#18a058" },
        lineStyle: { color: "#18a058", width: 2 },
      },
    ],
  };
});

// Per-datum bar styles: null = no data (bucket not drawn); gap buckets are
// invisible; partial edge buckets render translucent so a half-day never
// reads as a full day of data.
function trendBarDataWithStyle(points: OpsTrendPoint[]) {
  return points.map((p) => {
    if (p.requestCount === null) return null;
    if (p.gap)
      return { value: p.requestCount, itemStyle: { color: "transparent" } };
    if (p.partial)
      return {
        value: p.requestCount,
        itemStyle: { color: "rgba(32, 128, 240, 0.4)" },
      };
    return p.requestCount;
  });
}

// ---------- drill-down to request logs ----------

function drillToLogs(options: {
  startTime: number;
  endTime: number;
  status?: "error";
  filters?: OpsFilters;
}) {
  const detailStart = overview.value?.dataCoverage.detailStart;
  let start = options.startTime;
  let clamped = false;
  if (detailStart && start < detailStart) {
    start = detailStart;
    clamped = true;
  }
  if (options.endTime <= start) {
    message.warning(t("operationsMonitoring.drill.clampedNotice"));
    return;
  }
  if (clamped) {
    message.info(t("operationsMonitoring.drill.clampedNotice"));
  }
  const filters = { ...currentFilters(), ...options.filters };
  router.push({
    path: "/api-requests",
    query: {
      startTime: String(start),
      endTime: String(options.endTime),
      ...(filters.virtualKeyId ? { virtualKeyId: filters.virtualKeyId } : {}),
      ...(filters.model ? { model: filters.model } : {}),
      ...(filters.providerId ? { providerId: filters.providerId } : {}),
      ...(options.status ? { status: options.status } : {}),
    },
  });
}

function handleTrendClick(params: { dataIndex: number }) {
  if (!trend.value) return;
  const p = trend.value.points[params.dataIndex];
  if (!p || p.gap || p.requestCount === null) return;
  drillToLogs({ startTime: p.bucketStart, endTime: p.bucketEnd });
}

// ---------- dimension table columns ----------

function renderMetricWithSamples(
  value: number | null,
  samples: number,
  formatter: (v: number) => string,
) {
  return h("div", { class: "metric-cell" }, [
    h(
      "div",
      { class: "metric-value" },
      value === null
        ? t("operationsMonitoring.metrics.noValue")
        : formatter(value),
    ),
    h(
      "div",
      { class: "metric-samples" },
      t("operationsMonitoring.metrics.samples", {
        n: samples.toLocaleString(),
      }),
    ),
  ]);
}

function renderSuccessRateCell(row: OpsDimensionItem) {
  return h("div", { class: "metric-cell" }, [
    h("div", { class: "metric-value" }, formatSuccessRate(row.successRate)),
    h(
      "div",
      { class: "metric-samples" },
      `${t("operationsMonitoring.table.successCount")} ${row.successCount.toLocaleString()} · ${t("operationsMonitoring.table.failureCount")} ${row.failureCount.toLocaleString()}`,
    ),
  ]);
}

function renderNameCell(row: OpsDimensionItem, dim: OpsDimension) {
  if (dim === "virtualKey") {
    return h("div", { class: "metric-cell" }, [
      h("div", { class: "metric-value metric-name" }, row.name),
      row.maskedKey
        ? h("code", { class: "metric-masked" }, row.maskedKey)
        : null,
    ]);
  }
  return h("code", { class: "metric-name-code" }, row.name);
}

function renderInternalIdCell(row: OpsDimensionItem) {
  const id = row.id;
  if (id === null) {
    return h("span", { class: "metric-samples" }, "—");
  }
  return h(
    NSpace,
    { size: 4, align: "center", wrap: false },
    {
      default: () => [
        h("code", { class: "metric-id-code" }, id),
        h(
          NTooltip,
          {},
          {
            trigger: () =>
              h(
                NButton,
                {
                  size: "tiny",
                  text: true,
                  onClick: (e: MouseEvent) => {
                    e.stopPropagation();
                    copyToClipboard(id).then(() => {
                      message.success(t("operationsMonitoring.table.copied"));
                    });
                  },
                },
                {
                  icon: () =>
                    h(NIcon, { size: 14 }, { default: () => h(CopyOutline) }),
                },
              ),
            default: () => t("operationsMonitoring.table.copy"),
          },
        ),
      ],
    },
  );
}

function renderRowActions(row: OpsDimensionItem, dim: OpsDimension) {
  const buttons: VNode[] = [];
  if (dim === "virtualKey" && row.id !== null) {
    buttons.push(
      h(
        NButton,
        {
          size: "tiny",
          text: true,
          type: "primary",
          onClick: (e: MouseEvent) => {
            e.stopPropagation();
            filterVirtualKeyId.value = row.id;
            activeTab.value = "overview";
          },
        },
        {
          icon: () =>
            h(NIcon, { size: 14 }, { default: () => h(TrendingUpOutline) }),
          default: () => t("operationsMonitoring.trend.title"),
        },
      ),
    );
  }
  if (dim === "model") {
    buttons.push(
      h(
        NButton,
        {
          size: "tiny",
          text: true,
          type: "primary",
          onClick: (e: MouseEvent) => {
            e.stopPropagation();
            setModelFilter(row.name);
            activeTab.value = "provider";
          },
        },
        { default: () => t("operationsMonitoring.tabs.providers") },
      ),
    );
  }
  if (dim === "provider" && row.id !== null) {
    buttons.push(
      h(
        NButton,
        {
          size: "tiny",
          text: true,
          type: "primary",
          onClick: (e: MouseEvent) => {
            e.stopPropagation();
            setProviderFilter(row.id);
            activeTab.value = "model";
          },
        },
        { default: () => t("operationsMonitoring.tabs.models") },
      ),
    );
  }
  buttons.push(
    h(
      NButton,
      {
        size: "tiny",
        text: true,
        disabled: row.id === null,
        onClick: (e: MouseEvent) => {
          e.stopPropagation();
          drillDimensionRow(row, dim);
        },
      },
      {
        icon: () =>
          h(NIcon, { size: 14 }, { default: () => h(DocumentTextOutline) }),
        default: () => t("operationsMonitoring.table.toLogs"),
      },
    ),
    h(
      NButton,
      {
        size: "tiny",
        text: true,
        type: "error",
        disabled: row.id === null,
        onClick: (e: MouseEvent) => {
          e.stopPropagation();
          drillDimensionRow(row, dim, "error");
        },
      },
      { default: () => t("operationsMonitoring.table.failedToLogs") },
    ),
  );
  return h(NSpace, { size: 10, wrap: false }, { default: () => buttons });
}

function drillDimensionRow(
  row: OpsDimensionItem,
  dim: OpsDimension,
  status?: "error",
) {
  if (row.id === null) return;
  const windowInfo = overview.value?.window;
  drillToLogs({
    startTime: windowInfo?.startTime ?? Date.now() - 24 * 3600 * 1000,
    endTime: windowInfo?.endTime ?? Date.now(),
    status,
    filters:
      dim === "virtualKey"
        ? { virtualKeyId: row.id }
        : dim === "model"
          ? { model: row.id }
          : { providerId: row.id },
  });
}

const dimensionColumns = computed<
  Record<OpsDimension, DataTableColumns<OpsDimensionItem>>
>(() => ({
  virtualKey: [
    {
      title: t("operationsMonitoring.table.name"),
      key: "name",
      width: 200,
      ellipsis: { tooltip: true },
      render: (row: OpsDimensionItem) => renderNameCell(row, "virtualKey"),
    },
    {
      title: t("operationsMonitoring.table.internalId"),
      key: "internalId",
      width: 250,
      render: (row: OpsDimensionItem) => renderInternalIdCell(row),
    },
    {
      title: t("operationsMonitoring.table.requestCount"),
      key: "requestCount",
      width: 100,
      sorter: true,
      render: (row: OpsDimensionItem) => formatCount(row.requestCount),
    },
    {
      title: t("operationsMonitoring.table.successCount"),
      key: "successCount",
      width: 90,
      sorter: true,
      render: (row: OpsDimensionItem) => row.successCount.toLocaleString(),
    },
    {
      title: t("operationsMonitoring.table.failureCount"),
      key: "failureCount",
      width: 90,
      sorter: true,
      render: (row: OpsDimensionItem) => row.failureCount.toLocaleString(),
    },
    {
      title: t("operationsMonitoring.table.successRate"),
      key: "successRate",
      width: 140,
      sorter: true,
      render: renderSuccessRateCell,
    },
    {
      title: t("operationsMonitoring.table.promptTokens"),
      key: "promptTokens",
      width: 110,
      sorter: true,
      render: (row: OpsDimensionItem) => formatCount(row.promptTokens),
    },
    {
      title: t("operationsMonitoring.table.completionTokens"),
      key: "completionTokens",
      width: 110,
      sorter: true,
      render: (row: OpsDimensionItem) => formatCount(row.completionTokens),
    },
    {
      title: t("operationsMonitoring.table.cachedTokens"),
      key: "cachedTokens",
      width: 110,
      sorter: true,
      render: (row: OpsDimensionItem) => formatCount(row.cachedTokens),
    },
    {
      title: t("operationsMonitoring.table.totalTokens"),
      key: "totalTokens",
      width: 110,
      sorter: true,
      render: (row: OpsDimensionItem) => formatCount(row.totalTokens),
    },
    {
      title: t("operationsMonitoring.table.lastUsedAt"),
      key: "lastUsedAt",
      width: 150,
      sorter: true,
      render: (row: OpsDimensionItem) => formatLastUsed(row.lastUsedAt),
    },
    {
      title: "",
      key: "actions",
      width: 210,
      render: (row: OpsDimensionItem) => renderRowActions(row, "virtualKey"),
    },
  ],
  model: [
    {
      title: t("operationsMonitoring.table.name"),
      key: "name",
      width: 220,
      ellipsis: { tooltip: true },
      render: (row: OpsDimensionItem) => renderNameCell(row, "model"),
    },
    {
      title: t("operationsMonitoring.table.requestCount"),
      key: "requestCount",
      width: 100,
      sorter: true,
      render: (row: OpsDimensionItem) => formatCount(row.requestCount),
    },
    {
      title: t("operationsMonitoring.table.successCount"),
      key: "successCount",
      width: 90,
      sorter: true,
      render: (row: OpsDimensionItem) => row.successCount.toLocaleString(),
    },
    {
      title: t("operationsMonitoring.table.failureCount"),
      key: "failureCount",
      width: 90,
      sorter: true,
      render: (row: OpsDimensionItem) => row.failureCount.toLocaleString(),
    },
    {
      title: t("operationsMonitoring.table.successRate"),
      key: "successRate",
      width: 140,
      sorter: true,
      render: renderSuccessRateCell,
    },
    {
      title: t("operationsMonitoring.table.promptTokens"),
      key: "promptTokens",
      width: 110,
      sorter: true,
      render: (row: OpsDimensionItem) => formatCount(row.promptTokens),
    },
    {
      title: t("operationsMonitoring.table.completionTokens"),
      key: "completionTokens",
      width: 110,
      sorter: true,
      render: (row: OpsDimensionItem) => formatCount(row.completionTokens),
    },
    {
      title: t("operationsMonitoring.table.cachedTokens"),
      key: "cachedTokens",
      width: 110,
      sorter: true,
      render: (row: OpsDimensionItem) => formatCount(row.cachedTokens),
    },
    {
      title: t("operationsMonitoring.table.totalTokens"),
      key: "totalTokens",
      width: 110,
      sorter: true,
      render: (row: OpsDimensionItem) => formatCount(row.totalTokens),
    },
    {
      title: t("operationsMonitoring.table.avgTffb"),
      key: "avgTffbMs",
      width: 150,
      sorter: true,
      render: (row: OpsDimensionItem) =>
        renderMetricWithSamples(
          row.avgTffbMs,
          row.validTffbCount,
          (v) => `${Math.round(v).toLocaleString()} ms`,
        ),
    },
    {
      title: t("operationsMonitoring.table.avgResponseTime"),
      key: "avgResponseTimeMs",
      width: 150,
      sorter: true,
      render: (row: OpsDimensionItem) =>
        renderMetricWithSamples(
          row.avgResponseTimeMs,
          row.validResponseTimeCount,
          (v) => `${Math.round(v).toLocaleString()} ms`,
        ),
    },
    {
      title: t("operationsMonitoring.table.avgOutputSpeed"),
      key: "avgOutputSpeed",
      width: 150,
      sorter: true,
      render: (row: OpsDimensionItem) =>
        renderMetricWithSamples(
          row.avgOutputSpeed,
          row.validSpeedCount,
          (v) => `${v.toFixed(1)} tok/s`,
        ),
    },
    {
      title: t("operationsMonitoring.table.lastUsedAt"),
      key: "lastUsedAt",
      width: 150,
      sorter: true,
      render: (row: OpsDimensionItem) => formatLastUsed(row.lastUsedAt),
    },
    {
      title: "",
      key: "actions",
      width: 180,
      render: (row: OpsDimensionItem) => renderRowActions(row, "model"),
    },
  ],
  provider: [
    {
      title: t("operationsMonitoring.table.name"),
      key: "name",
      width: 200,
      ellipsis: { tooltip: true },
      render: (row: OpsDimensionItem) => renderNameCell(row, "provider"),
    },
    {
      title: t("operationsMonitoring.table.requestCount"),
      key: "requestCount",
      width: 100,
      sorter: true,
      render: (row: OpsDimensionItem) => formatCount(row.requestCount),
    },
    {
      title: t("operationsMonitoring.table.successCount"),
      key: "successCount",
      width: 90,
      sorter: true,
      render: (row: OpsDimensionItem) => row.successCount.toLocaleString(),
    },
    {
      title: t("operationsMonitoring.table.failureCount"),
      key: "failureCount",
      width: 90,
      sorter: true,
      render: (row: OpsDimensionItem) => row.failureCount.toLocaleString(),
    },
    {
      title: t("operationsMonitoring.table.successRate"),
      key: "successRate",
      width: 140,
      sorter: true,
      render: renderSuccessRateCell,
    },
    {
      title: t("operationsMonitoring.table.promptTokens"),
      key: "promptTokens",
      width: 110,
      sorter: true,
      render: (row: OpsDimensionItem) => formatCount(row.promptTokens),
    },
    {
      title: t("operationsMonitoring.table.completionTokens"),
      key: "completionTokens",
      width: 110,
      sorter: true,
      render: (row: OpsDimensionItem) => formatCount(row.completionTokens),
    },
    {
      title: t("operationsMonitoring.table.cachedTokens"),
      key: "cachedTokens",
      width: 110,
      sorter: true,
      render: (row: OpsDimensionItem) => formatCount(row.cachedTokens),
    },
    {
      title: t("operationsMonitoring.table.totalTokens"),
      key: "totalTokens",
      width: 110,
      sorter: true,
      render: (row: OpsDimensionItem) => formatCount(row.totalTokens),
    },
    {
      title: t("operationsMonitoring.table.avgTffb"),
      key: "avgTffbMs",
      width: 150,
      sorter: true,
      render: (row: OpsDimensionItem) =>
        renderMetricWithSamples(
          row.avgTffbMs,
          row.validTffbCount,
          (v) => `${Math.round(v).toLocaleString()} ms`,
        ),
    },
    {
      title: t("operationsMonitoring.table.avgResponseTime"),
      key: "avgResponseTimeMs",
      width: 150,
      sorter: true,
      render: (row: OpsDimensionItem) =>
        renderMetricWithSamples(
          row.avgResponseTimeMs,
          row.validResponseTimeCount,
          (v) => `${Math.round(v).toLocaleString()} ms`,
        ),
    },
    {
      title: t("operationsMonitoring.table.avgOutputSpeed"),
      key: "avgOutputSpeed",
      width: 150,
      sorter: true,
      render: (row: OpsDimensionItem) =>
        renderMetricWithSamples(
          row.avgOutputSpeed,
          row.validSpeedCount,
          (v) => `${v.toFixed(1)} tok/s`,
        ),
    },
    {
      title: t("operationsMonitoring.table.lastUsedAt"),
      key: "lastUsedAt",
      width: 150,
      sorter: true,
      render: (row: OpsDimensionItem) => formatLastUsed(row.lastUsedAt),
    },
    {
      title: "",
      key: "actions",
      width: 180,
      render: (row: OpsDimensionItem) => renderRowActions(row, "provider"),
    },
  ],
}));

// ---------- lifecycle ----------

onMounted(() => {
  refresh();
});

onBeforeUnmount(() => {
  for (const dim of DIMENSIONS) {
    if (dimStates[dim].searchTimer) clearTimeout(dimStates[dim].searchTimer);
    clearTimeout(filterSearchTimers[dim]);
  }
});
</script>

<style scoped>
.ops-monitoring-container {
  max-width: 1500px;
  margin: 0 auto;
  padding: 0 0 32px 0;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
  flex-wrap: wrap;
  gap: 16px;
}

.page-actions {
  display: flex;
  gap: 12px;
  align-items: center;
}

.window-info-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--color-text, #374151);
}

.window-info-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.coverage-alert {
  margin-bottom: 12px;
}

.coverage-detail {
  margin-top: 4px;
  font-size: 12.5px;
  opacity: 0.85;
}

.filter-card {
  margin-bottom: 20px;
  background-color: #fafafa;
}

.filter-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.filter-label {
  font-size: 12px;
  color: #666;
  font-weight: 500;
}

.content-card {
  background-color: transparent;
}

.loading-container {
  padding: 24px 0;
}

.metric-gi {
  margin-bottom: 0;
}

.summary-card {
  background: linear-gradient(135deg, #ffffff 0%, #f8f8f8 100%);
  border: 1px solid #f0f0f0;
  border-radius: 10px;
  padding: 14px 16px;
  height: 100%;
  transition:
    transform 0.2s,
    box-shadow 0.2s;
}

.summary-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}

.summary-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #666;
  margin-bottom: 8px;
}

.summary-value {
  font-size: 24px;
  font-weight: 600;
  color: #1a1a1a;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}

.summary-unit {
  font-size: 13px;
  font-weight: 400;
  color: #999;
  margin-left: 4px;
}

.summary-sub {
  margin-top: 6px;
  font-size: 12px;
  color: #999;
  font-variant-numeric: tabular-nums;
}

.trend-card {
  margin-top: 20px;
  background-color: transparent;
}

.trend-chart {
  width: 100%;
  height: 340px;
}

.trend-legend-hint {
  font-size: 12px;
  color: #666;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.partial-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  background: rgba(32, 128, 240, 0.4);
}

.gap-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  border: 1px dashed #bbb;
  background: transparent;
}

.ranking-grid {
  margin-top: 16px;
}

.ranking-card {
  background-color: #fafafa;
}

.ranking-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 4px;
  border-bottom: 1px solid #f0f0f0;
  cursor: pointer;
  transition: background-color 0.15s;
}

.ranking-row:last-child {
  border-bottom: none;
}

.ranking-row:hover {
  background-color: rgba(15, 107, 74, 0.04);
}

.ranking-name {
  font-size: 13px;
  color: #1f2937;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}

.ranking-metrics {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  font-variant-numeric: tabular-nums;
}

.ranking-count {
  font-size: 13px;
  color: #1f2937;
  font-weight: 600;
}

.ranking-rate {
  font-size: 12.5px;
  color: #18a058;
  min-width: 52px;
  text-align: right;
}

.ranking-rate-bad {
  color: #d03050;
}

.ranking-empty {
  padding: 24px 0;
  text-align: center;
  color: #999;
}

.dimension-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.metric-cell {
  line-height: 1.4;
}

.metric-value {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  color: #1f2937;
}

.metric-samples {
  font-size: 11.5px;
  color: #9ca3af;
  font-variant-numeric: tabular-nums;
}

.metric-name {
  font-weight: 500;
}

.metric-name-code {
  font-size: 12.5px;
  color: #111827;
}

.metric-masked {
  font-size: 11.5px;
  color: #6b7280;
  background: #f3f4f6;
  border-radius: 4px;
  padding: 1px 6px;
}

.metric-id-code {
  font-size: 11.5px;
  color: #6b7280;
  word-break: break-all;
}

@media (max-width: 768px) {
  .page-actions {
    width: 100%;
    justify-content: flex-start;
  }

  .filter-item {
    width: 100%;
  }

  .filter-item :deep(.n-select) {
    width: 100% !important;
  }
}
</style>

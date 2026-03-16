<template>
  <div class="performance-monitoring-container">
    <!-- Header -->
    <div class="page-header">
      <div class="page-title-section">
        <h1 class="page-title">{{ t('performanceMonitoring.title') }}</h1>
        <div class="page-subtitle">{{ t('performanceMonitoring.subtitle') }}</div>
      </div>
      <div class="page-actions">
        <n-tag type="info" size="large" round>
          <template #icon>
            <n-icon><TimeOutline /></n-icon>
          </template>
          {{ t('performanceMonitoring.last7Days') }}
        </n-tag>
        <n-button secondary round @click="loadData" :loading="loading">
          <template #icon>
            <n-icon><RefreshOutline /></n-icon>
          </template>
          {{ t('common.refresh') }}
        </n-button>
      </div>
    </div>

    <!-- Filters -->
    <n-card class="filter-card" :bordered="false">
      <n-space align="center" :wrap="true" :size="16">
        <div class="filter-item">
          <div class="filter-label">{{ t('performanceMonitoring.filters.provider') }}</div>
          <n-select
            v-model:value="selectedProvider"
            :options="providerOptions"
            :placeholder="t('performanceMonitoring.filters.allProviders')"
            clearable
            :style="{ width: '200px' }"
            @update:value="handleFilterChange"
          />
        </div>
        <div class="filter-item">
          <div class="filter-label">{{ t('performanceMonitoring.filters.model') }}</div>
          <n-select
            v-model:value="selectedModel"
            :options="modelOptions"
            :placeholder="t('performanceMonitoring.filters.allModels')"
            clearable
            :style="{ width: '200px' }"
            @update:value="handleFilterChange"
          />
        </div>
        <n-button @click="clearFilters" :disabled="!hasActiveFilter">
          <template #icon>
            <n-icon><CloseOutline /></n-icon>
          </template>
          {{ t('performanceMonitoring.filters.clear') }}
        </n-button>
      </n-space>
    </n-card>

    <!-- Loading State -->
    <div v-if="loading" class="loading-container">
      <n-skeleton text :repeat="4" style="height: 100px; margin-bottom: 16px" />
      <n-skeleton text style="height: 400px" />
    </div>

    <!-- Empty State -->
    <n-empty
      v-else-if="!data || data.items.length === 0"
      :description="t('performanceMonitoring.empty.noData')"
      class="empty-state"
    >
      <template #icon>
        <n-icon size="48"><BarChartOutline /></n-icon>
      </template>
    </n-empty>

    <!-- No Results After Filter -->
    <n-empty
      v-else-if="filteredItems.length === 0"
      :description="t('performanceMonitoring.empty.noResults')"
      class="empty-state"
    >
      <template #icon>
        <n-icon size="48"><FilterOutline /></n-icon>
      </template>
      <template #extra>
        <n-button @click="clearFilters">{{ t('performanceMonitoring.filters.clear') }}</n-button>
      </template>
    </n-empty>

    <!-- Main Content -->
    <template v-else>
      <!-- Summary Cards -->
      <n-grid :cols="4" :x-gap="16" :y-gap="16" responsive="screen">
        <n-gi span="1 s:1 m:2 l:1">
          <n-card class="summary-card" :bordered="false">
            <div class="summary-header">
              <span>{{ t('performanceMonitoring.metrics.avgTffb') }}</span>
            </div>
            <div class="summary-value">
              {{ data.summary.avgTffbMs !== null ? formatNumber(data.summary.avgTffbMs) : '-' }}
              <span v-if="data.summary.avgTffbMs !== null" class="summary-unit">ms</span>
            </div>
          </n-card>
        </n-gi>
        <n-gi span="1 s:1 m:2 l:1">
          <n-card class="summary-card" :bordered="false">
            <div class="summary-header">
              <span>{{ t('performanceMonitoring.metrics.avgOutputSpeed') }}</span>
            </div>
            <div class="summary-value">
              {{ data.summary.avgOutputSpeed !== null ? formatNumber(data.summary.avgOutputSpeed) : '-' }}
              <span v-if="data.summary.avgOutputSpeed !== null" class="summary-unit">tokens/s</span>
            </div>
          </n-card>
        </n-gi>
        <n-gi span="1 s:1 m:2 l:1">
          <n-card class="summary-card" :bordered="false">
            <div class="summary-header">
              <span>{{ t('performanceMonitoring.metrics.availability') }}</span>
            </div>
            <div class="summary-value">
              {{ formatPercentage(data.summary.successRate) }}%
            </div>
          </n-card>
        </n-gi>
        <n-gi span="1 s:1 m:2 l:1">
          <n-card class="summary-card" :bordered="false">
            <div class="summary-header">
              <span>{{ t('performanceMonitoring.metrics.totalRequests') }}</span>
            </div>
            <div class="summary-value">
              {{ formatNumber(data.summary.totalRequests) }}
            </div>
          </n-card>
        </n-gi>
      </n-grid>

      <!-- Token Summary Cards -->
      <n-grid :cols="4" :x-gap="16" :y-gap="16" responsive="screen" style="margin-top: 16px;">
        <n-gi span="1 s:1 m:2 l:1">
          <n-card class="summary-card token-card" :bordered="false">
            <div class="summary-header">
              <span>{{ t('performanceMonitoring.metrics.promptTokens') }}</span>
            </div>
            <div class="summary-value">
              {{ formatNumber(tokenSummaries.promptTokens) }}
            </div>
          </n-card>
        </n-gi>
        <n-gi span="1 s:1 m:2 l:1">
          <n-card class="summary-card token-card" :bordered="false">
            <div class="summary-header">
              <span>{{ t('performanceMonitoring.metrics.completionTokens') }}</span>
            </div>
            <div class="summary-value">
              {{ formatNumber(tokenSummaries.completionTokens) }}
            </div>
          </n-card>
        </n-gi>
        <n-gi span="1 s:1 m:2 l:1">
          <n-card class="summary-card token-card" :bordered="false">
            <div class="summary-header">
              <span>{{ t('performanceMonitoring.metrics.cachedTokens') }}</span>
            </div>
            <div class="summary-value">
              {{ formatNumber(tokenSummaries.cachedTokens) }}
            </div>
          </n-card>
        </n-gi>
        <n-gi span="1 s:1 m:2 l:1">
          <n-card class="summary-card token-card" :bordered="false">
            <div class="summary-header">
              <span>{{ t('performanceMonitoring.metrics.totalTokens') }}</span>
            </div>
            <div class="summary-value">
              {{ formatNumber(tokenSummaries.totalTokens) }}
            </div>
          </n-card>
        </n-gi>
      </n-grid>

      <!-- Charts -->
      <n-grid :cols="2" :x-gap="16" :y-gap="16" responsive="screen" class="charts-grid">
        <n-gi span="2 s:2 m:1">
          <n-card :title="chart1Title" class="chart-card" :bordered="false">
            <v-chart class="chart" :option="chartOption1" autoresize />
          </n-card>
        </n-gi>
        <n-gi span="2 s:2 m:1">
          <n-card :title="chart2Title" class="chart-card" :bordered="false">
            <v-chart class="chart" :option="chartOption2" autoresize />
          </n-card>
        </n-gi>
      </n-grid>

      <!-- Detail Table -->
      <n-card :title="t('performanceMonitoring.table.title')" class="table-card" :bordered="false">
        <n-data-table
          :columns="tableColumns"
          :data="filteredItems"
          :pagination="pagination"
          :max-height="500"
          striped
        />
      </n-card>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, h } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  useMessage,
  NTag,
  NSpace,
  NGrid,
  NGi,
  NCard,
  NSelect,
  NButton,
  NIcon,
  NSkeleton,
  NEmpty,
  NDataTable,
} from 'naive-ui';
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { BarChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
} from 'echarts/components';
import VChart from 'vue-echarts';
import {
  RefreshOutline,
  TimeOutline,
  CloseOutline,
  BarChartOutline,
  FilterOutline,
} from '@vicons/ionicons5';
import { configApi, type PerformanceMetricsResponse, type PerformanceMetricItem } from '@/api/config';

// Register ECharts components
use([
  CanvasRenderer,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
]);

const { t } = useI18n();
const message = useMessage();

// State
const loading = ref(false);
const data = ref<PerformanceMetricsResponse | null>(null);
const selectedProvider = ref<string | null>(null);
const selectedModel = ref<string | null>(null);

// Filter options
const providerOptions = computed(() => {
  if (!data.value) return [];
  return data.value.filters.providers;
});

const modelOptions = computed(() => {
  if (!data.value) return [];
  return data.value.filters.models;
});

const hasActiveFilter = computed(() => {
  return selectedProvider.value !== null || selectedModel.value !== null;
});

// Token summaries computed from filteredItems to follow provider/model filters
const tokenSummaries = computed(() => {
  const items = filteredItems.value;
  if (items.length === 0) {
    return {
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
    };
  }
  return items.reduce(
    (acc, item) => {
      acc.promptTokens += item.promptTokens || 0;
      acc.completionTokens += item.completionTokens || 0;
      acc.cachedTokens += item.cachedTokens || 0;
      acc.totalTokens += item.totalTokens || 0;
      return acc;
    },
    { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 }
  );
});

// Filtered items (shared by charts and table)
const filteredItems = computed(() => {
  if (!data.value) return [];
  
  return data.value.items.filter((item) => {
    // Provider filter: when selected, show items matching that provider
    if (selectedProvider.value) {
      const itemProviderId = item.providerId ?? '__unknown_provider__';
      if (itemProviderId !== selectedProvider.value) {
        return false;
      }
    }
    
    // Model filter: when selected, show items matching that model
    if (selectedModel.value) {
      if (item.model !== selectedModel.value) {
        return false;
      }
    }
    
    return true;
  });
});

// Chart titles based on filter state
const chart1Title = computed(() => {
  if (selectedModel.value) {
    return t('performanceMonitoring.charts.modelComparison', { model: selectedModel.value });
  }
  // Default state shows top models by request count
  return t('performanceMonitoring.charts.topModels');
});

const chart2Title = computed(() => {
  if (selectedProvider.value) {
    const providerName = providerOptions.value.find(p => p.value === selectedProvider.value)?.label || '';
    return t('performanceMonitoring.charts.modelRanking', { provider: providerName });
  }
  return t('performanceMonitoring.charts.overallPerformance');
});

// Chart 1: Model comparison across providers OR provider comparison
const chartOption1 = computed(() => {
  const items = filteredItems.value;
  if (items.length === 0) return {};

  // If model is selected, compare across providers
  if (selectedModel.value) {
    const providers = items.map(item => item.providerName);
    const availabilities = items.map(item => (item.availability * 100).toFixed(1));
    const avgSpeeds = items.map(item => item.avgOutputSpeed || 0);

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: any[]) => {
          let result = params[0].name + '<br/>';
          params.forEach(param => {
            const suffix = param.seriesName === t('performanceMonitoring.metrics.availability') ? '%' : ' tokens/s';
            result += `${param.marker} ${param.seriesName}: ${param.value}${suffix}<br/>`;
          });
          return result;
        },
      },
      legend: {
        data: [t('performanceMonitoring.metrics.availability'), t('performanceMonitoring.metrics.avgOutputSpeed')],
        bottom: 0,
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '15%',
        top: '10%',
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        data: providers,
        axisLabel: { rotate: 30, fontSize: 11 },
      },
      yAxis: [
        {
          type: 'value',
          name: t('performanceMonitoring.metrics.availability') + ' (%)',
          max: 100,
          axisLabel: { formatter: '{value}%' },
        },
        {
          type: 'value',
          name: t('performanceMonitoring.metrics.avgOutputSpeed') + ' (tokens/s)',
          axisLabel: { formatter: '{value}' },
        },
      ],
      series: [
        {
          name: t('performanceMonitoring.metrics.availability'),
          type: 'bar',
          data: availabilities,
          itemStyle: { color: '#18a058', borderRadius: [4, 4, 0, 0] },
        },
        {
          name: t('performanceMonitoring.metrics.avgOutputSpeed'),
          type: 'bar',
          yAxisIndex: 1,
          data: avgSpeeds,
          itemStyle: { color: '#2080f0', borderRadius: [4, 4, 0, 0] },
        },
      ],
    };
  }

  // Default: Show top models by request count
  const sortedItems = [...items].sort((a, b) => b.requestCount - a.requestCount).slice(0, 10);
  const modelNames = sortedItems.map(item => item.model);
  const requestCounts = sortedItems.map(item => item.requestCount);

  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
    },
    grid: {
      left: '3%',
      right: '4%',
      bottom: '10%',
      top: '10%',
      containLabel: true,
    },
    xAxis: {
      type: 'category',
      data: modelNames,
      axisLabel: { rotate: 30, fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      name: t('performanceMonitoring.metrics.totalRequests'),
    },
    series: [
      {
        name: t('performanceMonitoring.metrics.totalRequests'),
        type: 'bar',
        data: requestCounts,
        itemStyle: { color: '#2080f0', borderRadius: [4, 4, 0, 0] },
      },
    ],
  };
});

// Chart 2: Model ranking within provider OR overall performance
const chartOption2 = computed(() => {
  const items = filteredItems.value;
  if (items.length === 0) return {};

  // Sort by availability descending, take top 10
  const sortedItems = [...items]
    .sort((a, b) => b.availability - a.availability)
    .slice(0, 10);

  const labels = sortedItems.map(item => 
    selectedProvider.value ? item.model : `${item.providerName} - ${item.model}`
  );
  const availabilities = sortedItems.map(item => (item.availability * 100).toFixed(1));
  const tffbValues = sortedItems.map(item => item.avgTffbMs || 0);

  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: any[]) => {
        let result = params[0].name + '<br/>';
        params.forEach(param => {
          const suffix = param.seriesName === t('performanceMonitoring.metrics.availability') ? '%' : ' ms';
          result += `${param.marker} ${param.seriesName}: ${param.value}${suffix}<br/>`;
        });
        return result;
      },
    },
    legend: {
      data: [t('performanceMonitoring.metrics.availability'), t('performanceMonitoring.metrics.avgTffb')],
      bottom: 0,
    },
    grid: {
      left: '3%',
      right: '4%',
      bottom: '15%',
      top: '10%',
      containLabel: true,
    },
    xAxis: {
      type: 'category',
      data: labels,
      axisLabel: { rotate: 30, fontSize: 10 },
    },
    yAxis: [
      {
        type: 'value',
        name: t('performanceMonitoring.metrics.availability') + ' (%)',
        max: 100,
        axisLabel: { formatter: '{value}%' },
      },
      {
        type: 'value',
        name: t('performanceMonitoring.metrics.avgTffb') + ' (ms)',
        axisLabel: { formatter: '{value}' },
      },
    ],
    series: [
      {
        name: t('performanceMonitoring.metrics.availability'),
        type: 'bar',
        data: availabilities,
        itemStyle: { color: '#18a058', borderRadius: [4, 4, 0, 0] },
      },
      {
        name: t('performanceMonitoring.metrics.avgTffb'),
        type: 'bar',
        yAxisIndex: 1,
        data: tffbValues,
        itemStyle: { color: '#f0a020', borderRadius: [4, 4, 0, 0] },
      },
    ],
  };
});

// Table columns
const tableColumns = [
  {
    title: t('performanceMonitoring.table.provider'),
    key: 'providerName',
    render(row: PerformanceMetricItem) {
      return h(NTag, { type: 'default', bordered: false }, { default: () => row.providerName });
    },
  },
  {
    title: t('performanceMonitoring.table.model'),
    key: 'model',
    render(row: PerformanceMetricItem) {
      return h('code', { style: { fontSize: '13px' } }, row.model);
    },
  },
  {
    title: t('performanceMonitoring.metrics.totalRequests'),
    key: 'requestCount',
    sorter: (a: PerformanceMetricItem, b: PerformanceMetricItem) => a.requestCount - b.requestCount,
    render(row: PerformanceMetricItem) {
      return formatNumber(row.requestCount);
    },
  },
  {
    title: t('performanceMonitoring.metrics.availability'),
    key: 'availability',
    sorter: (a: PerformanceMetricItem, b: PerformanceMetricItem) => a.availability - b.availability,
    render(row: PerformanceMetricItem) {
      const percentage = (row.availability * 100).toFixed(1);
      let type: 'success' | 'warning' | 'error' = 'success';
      if (row.availability < 0.95) type = 'warning';
      if (row.availability < 0.90) type = 'error';
      return h(NTag, { type, bordered: false }, { default: () => `${percentage}%` });
    },
  },
  {
    title: t('performanceMonitoring.metrics.avgTffb'),
    key: 'avgTffbMs',
    sorter: (a: PerformanceMetricItem, b: PerformanceMetricItem) => (a.avgTffbMs || 0) - (b.avgTffbMs || 0),
    render(row: PerformanceMetricItem) {
      return row.avgTffbMs !== null ? `${formatNumber(row.avgTffbMs)} ms` : '-';
    },
  },
  {
    title: t('performanceMonitoring.metrics.avgOutputSpeed'),
    key: 'avgOutputSpeed',
    sorter: (a: PerformanceMetricItem, b: PerformanceMetricItem) => (a.avgOutputSpeed || 0) - (b.avgOutputSpeed || 0),
    render(row: PerformanceMetricItem) {
      return row.avgOutputSpeed !== null ? `${formatNumber(row.avgOutputSpeed)} tokens/s` : '-';
    },
  },
  {
    title: t('performanceMonitoring.metrics.promptTokens'),
    key: 'promptTokens',
    sorter: (a: PerformanceMetricItem, b: PerformanceMetricItem) => a.promptTokens - b.promptTokens,
    render(row: PerformanceMetricItem) {
      return formatNumber(row.promptTokens);
    },
  },
  {
    title: t('performanceMonitoring.metrics.completionTokens'),
    key: 'completionTokens',
    sorter: (a: PerformanceMetricItem, b: PerformanceMetricItem) => a.completionTokens - b.completionTokens,
    render(row: PerformanceMetricItem) {
      return formatNumber(row.completionTokens);
    },
  },
  {
    title: t('performanceMonitoring.metrics.cachedTokens'),
    key: 'cachedTokens',
    sorter: (a: PerformanceMetricItem, b: PerformanceMetricItem) => a.cachedTokens - b.cachedTokens,
    render(row: PerformanceMetricItem) {
      return formatNumber(row.cachedTokens);
    },
  },
  {
    title: t('performanceMonitoring.metrics.totalTokens'),
    key: 'totalTokens',
    sorter: (a: PerformanceMetricItem, b: PerformanceMetricItem) => a.totalTokens - b.totalTokens,
    render(row: PerformanceMetricItem) {
      return formatNumber(row.totalTokens);
    },
  },
];

// Pagination
const pagination = {
  pageSize: 10,
};

// Methods
function formatNumber(num: number): string {
  if (num === 0) return '0';
  if (num < 1000) return num.toFixed(0);
  if (num < 1000000) return (num / 1000).toFixed(1) + 'K';
  return (num / 1000000).toFixed(2) + 'M';
}

function formatPercentage(value: number): string {
  return (value * 100).toFixed(1);
}

function handleFilterChange() {
  // Filters are applied reactively via computed properties
}

function clearFilters() {
  selectedProvider.value = null;
  selectedModel.value = null;
}

async function loadData() {
  loading.value = true;
  try {
    data.value = await configApi.getPerformanceMetrics();
  } catch (error) {
    message.error(t('messages.loadFailed'));
    console.error('Failed to load performance metrics:', error);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadData();
});
</script>

<style scoped>
.performance-monitoring-container {
  max-width: 1400px;
  margin: 0 auto;
  padding: 0 0 32px 0;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 24px;
  flex-wrap: wrap;
  gap: 16px;
}

.page-title {
  margin: 0 0 8px 0;
  font-size: 28px;
  font-weight: 600;
  color: #1e3932;
}

.page-subtitle {
  color: #666;
  font-size: 14px;
}

.page-actions {
  display: flex;
  gap: 12px;
  align-items: center;
}

.filter-card {
  margin-bottom: 24px;
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

.loading-container {
  padding: 24px 0;
}

.empty-state {
  padding: 64px 0;
}

.summary-card {
  background: linear-gradient(135deg, #ffffff 0%, #f8f8f8 100%);
  transition: transform 0.2s, box-shadow 0.2s;
}

.summary-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}

.summary-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: #666;
  margin-bottom: 12px;
}

.summary-value {
  font-size: 28px;
  font-weight: 600;
  color: #1a1a1a;
  line-height: 1.2;
}

.summary-unit {
  font-size: 14px;
  font-weight: 400;
  color: #999;
  margin-left: 4px;
}

.charts-grid {
  margin-top: 24px;
}

.chart-card {
  height: 400px;
}

.chart {
  width: 100%;
  height: 320px;
}

.table-card {
  margin-top: 24px;
}

.token-card {
  background: linear-gradient(135deg, #ffffff 0%, #f0f7ff 100%);
}

.token-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(32, 128, 240, 0.12);
}
</style>

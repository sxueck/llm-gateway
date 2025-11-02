<template>
  <div class="dashboard-view">
    <n-space vertical :size="24">
      <div class="dashboard-header">
        <div>
          <h2 class="page-title">{{ t('dashboard.title') }}</h2>
          <p class="page-subtitle">{{ t('dashboard.subtitle') }}</p>
        </div>
        <n-space :size="12">
          <n-button secondary round @click="loadData">
            <template #icon>
              <n-icon><RefreshOutline /></n-icon>
            </template>
            {{ t('common.refresh') }}
          </n-button>
          <n-select
            v-model:value="selectedPeriod"
            :options="periodOptions"
            size="medium"
            style="width: 160px;"
            @update:value="loadStats"
          />
        </n-space>
      </div>

      <n-grid :cols="4" :x-gap="20" :y-gap="20">
        <n-gi>
          <n-card class="stat-card stat-card-primary">
            <n-statistic :label="t('dashboard.tokenConsumption')">
              <template #default>
                <span class="stat-value-primary">{{ formatTokenNumber(stats?.totalTokens || 0) }}</span>
              </template>
            </n-statistic>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <n-statistic :label="t('dashboard.totalRequests')">
              <template #default>
                <span class="stat-value">{{ formatNumber(stats?.totalRequests || 0) }}</span>
              </template>
              <template #suffix>
                <span class="stat-suffix">{{ t('dashboard.times') }}</span>
              </template>
            </n-statistic>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <n-statistic :label="t('dashboard.successfulRequests')">
              <template #default>
                <span class="stat-value stat-value-success">{{ formatNumber(stats?.successfulRequests || 0) }}</span>
              </template>
              <template #suffix>
                <span class="stat-suffix">{{ t('dashboard.times') }}</span>
              </template>
            </n-statistic>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <n-statistic :label="t('dashboard.failedRequests')">
              <template #default>
                <span class="stat-value stat-value-error">{{ formatNumber(stats?.failedRequests || 0) }}</span>
              </template>
              <template #suffix>
                <span class="stat-suffix">{{ t('dashboard.times') }}</span>
              </template>
            </n-statistic>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <n-statistic :label="t('dashboard.successRate')">
              <template #default>
                <span class="stat-value">{{ formatPercentage(successRate) }}</span>
              </template>
              <template #suffix>
                <span class="stat-suffix">%</span>
              </template>
            </n-statistic>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <n-statistic :label="t('dashboard.avgResponseTime')">
              <template #default>
                <span class="stat-value">{{ formatResponseTime(avgResponseTime) }}</span>
              </template>
              <template #suffix>
                <span class="stat-suffix">ms</span>
              </template>
            </n-statistic>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <n-statistic :label="t('dashboard.gatewayLatency')">
              <template #default>
                <span class="stat-value">{{ formatResponseTime(gatewayLatency) }}</span>
              </template>
              <template #suffix>
                <span class="stat-suffix">ms</span>
              </template>
            </n-statistic>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <n-statistic :label="t('dashboard.errorRate')">
              <template #default>
                <span class="stat-value" :class="{ 'stat-value-error': errorRate > 5 }">{{ formatPercentage(errorRate) }}</span>
              </template>
              <template #suffix>
                <span class="stat-suffix">%</span>
              </template>
            </n-statistic>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <n-statistic :label="t('dashboard.recentRequests')">
              <template #default>
                <span class="stat-value">{{ formatNumber(recentRequestsCount) }}</span>
              </template>
              <template #suffix>
                <span class="stat-suffix stat-suffix-light">{{ t('dashboard.perHour') }}</span>
              </template>
            </n-statistic>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <n-statistic :label="t('dashboard.cacheHits')">
              <template #default>
                <span class="stat-value stat-value-success">{{ formatNumber(stats?.cacheHits || 0) }}</span>
              </template>
              <template #suffix>
                <span class="stat-suffix">{{ t('dashboard.times') }}</span>
              </template>
            </n-statistic>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <n-statistic :label="t('dashboard.cacheHitRate')">
              <template #default>
                <span class="stat-value" :class="{ 'stat-value-success': cacheHitRate > 20 }">{{ formatPercentage(cacheHitRate) }}</span>
              </template>
              <template #suffix>
                <span class="stat-suffix">%</span>
              </template>
            </n-statistic>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <n-statistic :label="t('dashboard.cacheSavedTokens')">
              <template #default>
                <span class="stat-value stat-value-success">{{ formatTokenNumber(stats?.cacheSavedTokens || 0) }}</span>
              </template>
            </n-statistic>
          </n-card>
        </n-gi>
      </n-grid>

      <n-card class="trend-card">
        <template #header>
          <n-space justify="space-between" align="center">
            <span>请求趋势</span>
            <n-space :size="12">
              <n-button
                :type="chartMetric === 'requests' ? 'primary' : 'default'"
                size="small"
                @click="chartMetric = 'requests'"
              >
                请求数
              </n-button>
              <n-button
                :type="chartMetric === 'tokens' ? 'primary' : 'default'"
                size="small"
                @click="chartMetric = 'tokens'"
              >
                Token 消耗
              </n-button>
            </n-space>
          </n-space>
        </template>
        <div v-if="loading" class="trend-loading">
          <n-spin size="large" />
        </div>
        <div v-else-if="loadError" class="trend-error">
          <n-result status="error" :title="loadError" description="请稍后重试">
            <template #footer>
              <n-button @click="loadStats">重新加载</n-button>
            </template>
          </n-result>
        </div>
        <div v-else-if="trendData.length > 0" class="trend-chart-container">
          <v-chart :option="chartOption" :autoresize="true" class="trend-chart" />
        </div>
        <n-empty v-else description="暂无数据" :show-icon="false" />
      </n-card>

      <n-card class="overview-card" title="系统概览">
        <div class="overview-grid">
          <div class="overview-item">
            <span class="overview-label">提供商</span>
            <span class="overview-value">{{ providerStore.providers.length }} 个</span>
          </div>
          <div class="overview-item">
            <span class="overview-label">虚拟密钥</span>
            <span class="overview-value">{{ virtualKeyStore.virtualKeys.length }} 个</span>
          </div>
          <div class="overview-item">
            <span class="overview-label">启用的密钥</span>
            <span class="overview-value">{{ enabledKeysCount }} 个</span>
          </div>
        </div>
      </n-card>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useMessage, NSpace, NGrid, NGi, NCard, NStatistic, NSelect, NEmpty, NButton, NIcon, NSpin, NResult } from 'naive-ui';
import { RefreshOutline } from '@vicons/ionicons5';
import { useI18n } from 'vue-i18n';
import { useProviderStore } from '@/stores/provider';
import { useVirtualKeyStore } from '@/stores/virtual-key';
import { configApi, type ApiStats, type VirtualKeyTrend } from '@/api/config';
import { portkeyGatewayApi } from '@/api/portkey-gateways';
import { formatNumber, formatTokenNumber, formatPercentage, formatResponseTime, formatTimestamp } from '@/utils/format';
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { LineChart } from 'echarts/charts';
import {
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
} from 'echarts/components';
import VChart from 'vue-echarts';

use([
  CanvasRenderer,
  LineChart,
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
]);

const { t } = useI18n();
const message = useMessage();
const providerStore = useProviderStore();
const virtualKeyStore = useVirtualKeyStore();

const stats = ref<ApiStats | null>(null);
const trendData = ref<VirtualKeyTrend[]>([]);
const selectedPeriod = ref<'24h' | '7d' | '30d'>('24h');
const defaultGatewayLatency = ref<number | null>(null);
const chartMetric = ref<'requests' | 'tokens'>('requests');
const loading = ref(false);
const loadError = ref<string | null>(null);

const periodOptions = computed(() => [
  { label: t('dashboard.period.last24Hours'), value: '24h' },
  { label: t('dashboard.period.last7Days'), value: '7d' },
  { label: t('dashboard.period.last30Days'), value: '30d' },
]);

const enabledKeysCount = computed(() => {
  return virtualKeyStore.virtualKeys.filter(k => k.enabled).length;
});

const successRate = computed(() => {
  if (!stats.value || stats.value.totalRequests === 0) return 0;
  return (stats.value.successfulRequests / stats.value.totalRequests) * 100;
});

const errorRate = computed(() => {
  if (!stats.value || stats.value.totalRequests === 0) return 0;
  return (stats.value.failedRequests / stats.value.totalRequests) * 100;
});

const avgResponseTime = computed(() => {
  return stats.value?.avgResponseTime || 0;
});

const gatewayLatency = computed(() => {
  return defaultGatewayLatency.value || 0;
});

const recentRequestsCount = computed(() => {
  if (trendData.value.length === 0) return 0;
  let totalRequests = 0;
  trendData.value.forEach(keyTrend => {
    const lastData = keyTrend.data.slice(-1)[0];
    if (lastData) {
      totalRequests += lastData.requestCount;
    }
  });
  return totalRequests;
});

const cacheHitRate = computed(() => {
  if (!stats.value || stats.value.totalRequests === 0) return 0;
  return (stats.value.cacheHits / stats.value.totalRequests) * 100;
});

const COLOR_PALETTE = [
  { line: '#0f6b4a', gradient: ['rgba(15, 107, 74, 0.4)', 'rgba(15, 107, 74, 0.05)'] },
  { line: '#3b82f6', gradient: ['rgba(59, 130, 246, 0.4)', 'rgba(59, 130, 246, 0.05)'] },
  { line: '#f59e0b', gradient: ['rgba(245, 158, 11, 0.4)', 'rgba(245, 158, 11, 0.05)'] },
  { line: '#ef4444', gradient: ['rgba(239, 68, 68, 0.4)', 'rgba(239, 68, 68, 0.05)'] },
  { line: '#8b5cf6', gradient: ['rgba(139, 92, 246, 0.4)', 'rgba(139, 92, 246, 0.05)'] },
  { line: '#10b981', gradient: ['rgba(16, 185, 129, 0.4)', 'rgba(16, 185, 129, 0.05)'] },
  { line: '#f97316', gradient: ['rgba(249, 115, 22, 0.4)', 'rgba(249, 115, 22, 0.05)'] },
  { line: '#6366f1', gradient: ['rgba(99, 102, 241, 0.4)', 'rgba(99, 102, 241, 0.05)'] },
  { line: '#ec4899', gradient: ['rgba(236, 72, 153, 0.4)', 'rgba(236, 72, 153, 0.05)'] },
  { line: '#14b8a6', gradient: ['rgba(20, 184, 166, 0.4)', 'rgba(20, 184, 166, 0.05)'] },
];

const chartOption = computed(() => {
  if (!trendData.value || trendData.value.length === 0) {
    return {};
  }

  const firstKeyData = trendData.value[0]?.data;
  if (!firstKeyData || firstKeyData.length === 0) {
    return {};
  }

  const timePoints = firstKeyData
    .map(d => d.timestamp)
    .filter(t => t && !isNaN(t));

  if (timePoints.length === 0) {
    return {};
  }

  const series = trendData.value.map((keyTrend, index) => {
    const colorScheme = COLOR_PALETTE[index % COLOR_PALETTE.length];

    return {
      name: keyTrend.virtualKeyName,
      type: 'line',
      smooth: true,
      smoothMonotone: 'x',
      symbol: 'circle',
      symbolSize: 7,
      showSymbol: false,
      lineStyle: {
        width: 3,
        shadowColor: colorScheme.line,
        shadowBlur: 8,
        shadowOffsetY: 2,
      },
      itemStyle: {
        borderWidth: 2,
        borderColor: '#ffffff',
      },
      emphasis: {
        focus: 'series',
        scale: true,
        itemStyle: {
          borderWidth: 3,
          shadowBlur: 10,
          shadowColor: colorScheme.line,
        },
      },
      areaStyle: {
        color: {
          type: 'linear',
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            { offset: 0, color: colorScheme.gradient[0] },
            { offset: 1, color: colorScheme.gradient[1] }
          ],
        },
      },
      data: keyTrend.data.map(d =>
        chartMetric.value === 'requests' ? d.requestCount : d.tokenCount
      ),
      color: colorScheme.line,
    };
  });

  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(255, 255, 255, 0.95)',
      borderColor: '#e5e7eb',
      borderWidth: 1,
      textStyle: {
        color: '#1f2937',
        fontSize: 13,
      },
      padding: [12, 16],
      axisPointer: {
        type: 'line',
        lineStyle: {
          color: '#d1d5db',
          width: 1,
          type: 'solid',
        },
        crossStyle: {
          color: '#d1d5db',
          width: 1,
          type: 'dashed',
        },
      },
      formatter: (params: any) => {
        if (!params || params.length === 0) return '';
        const dataIndex = params[0].dataIndex;
        if (dataIndex === undefined || dataIndex >= timePoints.length) return '';
        const timestamp = timePoints[dataIndex];
        if (!timestamp || isNaN(timestamp)) return '';
        let result = `<div style="font-weight: 600; margin-bottom: 10px; color: #111827; font-size: 14px;">${formatTimestamp(timestamp, selectedPeriod.value)}</div>`;
        params.forEach((param: any) => {
          const value = chartMetric.value === 'requests'
            ? `${formatNumber(param.value)} 次`
            : `${formatTokenNumber(param.value)} tokens`;
          result += `<div style="display: flex; align-items: center; margin: 6px 0;">
            <span style="display: inline-block; width: 12px; height: 12px; border-radius: 3px; background-color: ${param.color}; margin-right: 10px;"></span>
            <span style="flex: 1; color: #4b5563; font-size: 13px;">${param.seriesName}</span>
            <span style="font-weight: 600; margin-left: 16px; color: #111827; font-size: 13px;">${value}</span>
          </div>`;
        });
        return result;
      }
    },
    legend: {
      data: trendData.value.map(t => t.virtualKeyName),
      top: 12,
      left: 'center',
      type: 'scroll',
      pageButtonPosition: 'end',
      itemWidth: 14,
      itemHeight: 14,
      itemGap: 20,
      textStyle: {
        color: '#6b7280',
        fontSize: 13,
        fontWeight: 500,
      },
      pageIconColor: '#0f6b4a',
      pageIconInactiveColor: '#d1d5db',
      pageTextStyle: {
        color: '#6b7280',
      },
    },
    grid: {
      left: '2%',
      right: '2%',
      bottom: '5%',
      top: 70,
      containLabel: true
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: timePoints.map(t => formatTimestamp(t, selectedPeriod.value)),
      axisLine: {
        lineStyle: {
          color: '#e5e7eb',
          width: 1,
        }
      },
      axisTick: {
        show: false,
      },
      axisLabel: {
        rotate: selectedPeriod.value === '24h' ? 0 : 45,
        interval: 'auto',
        color: '#9ca3af',
        fontSize: 12,
        margin: 12,
      },
      splitLine: {
        show: false,
      }
    },
    yAxis: {
      type: 'value',
      axisLine: {
        show: false,
      },
      axisTick: {
        show: false,
      },
      axisLabel: {
        color: '#9ca3af',
        fontSize: 12,
        margin: 12,
        formatter: (value: number) => {
          if (chartMetric.value === 'requests') {
            return formatNumber(value);
          }
          return formatTokenNumber(value);
        }
      },
      splitLine: {
        lineStyle: {
          color: '#f3f4f6',
          width: 1,
          type: 'solid',
        }
      }
    },
    series,
  };
});

async function loadDefaultGatewayLatency() {
  try {
    const gateways = await portkeyGatewayApi.getAll();
    const defaultGateway = gateways.find(g => g.isDefault && g.enabled);

    if (defaultGateway) {
      const healthResult = await portkeyGatewayApi.checkHealth(defaultGateway.id);
      defaultGatewayLatency.value = healthResult.latency;
    } else {
      defaultGatewayLatency.value = null;
    }
  } catch {
    defaultGatewayLatency.value = null;
  }
}

async function loadData() {
  await Promise.all([
    providerStore.fetchProviders(),
    virtualKeyStore.fetchVirtualKeys(),
    loadStats(),
    loadDefaultGatewayLatency(),
  ]);
}

async function loadStats() {
  loading.value = true;
  loadError.value = null;
  try {
    const result = await configApi.getStats(selectedPeriod.value);

    if (!result || !result.stats) {
      throw new Error('获取统计数据失败');
    }

    stats.value = result.stats;
    trendData.value = result.trend || [];
  } catch (error: any) {
    const errorMsg = error.message || '加载数据失败';
    loadError.value = errorMsg;
    message.error(errorMsg);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadData();
});
</script>

<style scoped>
.dashboard-view {
  max-width: 1400px;
  margin: 0 auto;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}

.dashboard-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.page-title {
  font-size: 32px;
  font-weight: 600;
  color: #1a1a1a;
  margin: 0;
  letter-spacing: -0.03em;
}

.page-subtitle {
  font-size: 14px;
  color: #8c8c8c;
  margin: 4px 0 0 0;
  font-weight: 400;
}

.stat-card {
  background: #ffffff;
  border-radius: 16px;
  border: none;
  transition: all 0.3s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.stat-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
}

.stat-card-primary {
  background: linear-gradient(135deg, #0f6b4a 0%, #0d5a3e 100%);
  color: #ffffff;
}

.stat-card-primary:hover {
  box-shadow: 0 6px 16px rgba(15, 107, 74, 0.3);
}

.stat-card-primary :deep(.n-statistic__label) {
  color: rgba(255, 255, 255, 0.9) !important;
}

.stat-value-primary {
  font-size: 36px;
  font-weight: 600;
  color: #ffffff;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.stat-card :deep(.n-statistic__label) {
  font-size: 13px;
  color: #8c8c8c;
  font-weight: 500;
  margin-bottom: 12px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.stat-card :deep(.n-statistic__value) {
  font-size: 36px;
  font-weight: 600;
  color: #1a1a1a;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.stat-value {
  font-size: 36px;
  font-weight: 600;
  color: #1a1a1a;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.stat-value-success {
  color: #0f6b4a;
}

.stat-value-error {
  color: #d03050;
}

.stat-suffix {
  font-size: 14px;
  font-weight: 400;
  color: #595959;
  margin-left: 4px;
}

.stat-suffix-light {
  color: #8c8c8c;
}

.token-display {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.token-value-primary {
  font-size: 28px;
  font-weight: 600;
  color: #1a1a1a;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.token-value-secondary {
  font-size: 16px;
  font-weight: 400;
  color: #8c8c8c;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}

.trend-card {
  background: #ffffff;
  border-radius: 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  transition: box-shadow 0.3s ease;
}

.trend-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
}

.trend-card :deep(.n-card__header) {
  padding: 24px 28px 20px;
  border-bottom: 1px solid #f3f4f6;
}

.trend-card :deep(.n-card-header__main) {
  font-size: 18px;
  font-weight: 600;
  color: #1a1a1a;
  letter-spacing: -0.02em;
}

.trend-chart-container {
  padding: 24px 16px 16px;
  min-height: 400px;
}

.trend-chart {
  width: 100%;
  height: 420px;
}

.trend-loading {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 400px;
}

.trend-error {
  padding: 40px 20px;
}

.overview-card {
  background: #ffffff;
  border-radius: 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.overview-card :deep(.n-card__header) {
  padding: 24px 28px;
  border-bottom: 1px solid #f0f0f0;
}

.overview-card :deep(.n-card-header__main) {
  font-size: 18px;
  font-weight: 600;
  color: #1a1a1a;
  letter-spacing: -0.02em;
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 24px;
}

.overview-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.overview-label {
  font-size: 13px;
  color: #8c8c8c;
  font-weight: 400;
}

.overview-value {
  font-size: 18px;
  font-weight: 500;
  color: #1a1a1a;
  font-variant-numeric: tabular-nums;
}
</style>


<template>
  <div class="dashboard-view">
    <n-space vertical :size="24">
      <div class="dashboard-header">
        <div>
          <h2 class="page-title">{{ t('dashboard.title') }}</h2>
          <p class="page-subtitle">{{ t('dashboard.subtitle') }}</p>
        </div>
        <n-space :size="12" class="dashboard-controls">
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
            :style="{ width: windowWidth < 640 ? '140px' : '160px' }"
            @update:value="loadStats"
          />
        </n-space>
      </div>

      <n-grid :cols="gridCols" :x-gap="gridGap" :y-gap="gridGap">
        <n-gi>
          <n-card class="stat-card stat-card-primary">
            <div class="stat-content">
              <div class="stat-header">{{ t('dashboard.tokenConsumption') }}</div>
              <div class="stat-main-value">{{ formatTokenNumber(stats?.totalTokens || 0) }}</div>
              <div class="stat-details">
                <span class="stat-detail-item">
                  <span class="stat-detail-label">输入:</span>
                  <span class="stat-detail-value">{{ formatTokenNumber(promptTokens) }}</span>
                </span>
                <span class="stat-detail-item">
                  <span class="stat-detail-label">输出:</span>
                  <span class="stat-detail-value">{{ formatTokenNumber(completionTokens) }}</span>
                </span>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">{{ t('dashboard.totalRequests') }}</div>
              <div class="stat-main-value">{{ formatNumber(stats?.totalRequests || 0) }}</div>
              <div class="stat-details">
                <span class="stat-detail-item stat-detail-success">
                  <span class="stat-detail-label">成功:</span>
                  <span class="stat-detail-value">{{ formatNumber(stats?.successfulRequests || 0) }}</span>
                </span>
                <span class="stat-detail-item stat-detail-error">
                  <span class="stat-detail-label">失败:</span>
                  <span class="stat-detail-value">{{ formatNumber(stats?.failedRequests || 0) }}</span>
                </span>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">{{ t('dashboard.successRate') }}</div>
              <div class="stat-main-value">{{ formatPercentage(successRate) }}<span class="stat-unit">%</span></div>
              <div class="stat-progress">
                <div class="stat-progress-bar" :style="{ width: successRate + '%' }"></div>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">{{ t('dashboard.avgResponseTime') }}</div>
              <div class="stat-main-value">{{ formatResponseTime(avgResponseTime) }}<span class="stat-unit">ms</span></div>
            </div>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">缓存 Tokens</div>
              <div class="stat-main-value">{{ formatTokenNumber(stats?.cachedTokens || 0) }}</div>
              <div class="stat-details">
                <span class="stat-detail-item">
                  <span class="stat-detail-label">缓存命中:</span>
                  <span class="stat-detail-value">{{ formatNumber(stats?.promptCacheHits || 0) }}</span>
                </span>
                <span class="stat-detail-item">
                  <span class="stat-detail-label">命中率:</span>
                  <span class="stat-detail-value">{{ formatPercentage(cacheHitRate) }}%</span>
                </span>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">错误率</div>
              <div class="stat-main-value" :class="{ 'stat-value-error': errorRate > 5 }">{{ formatPercentage(errorRate) }}<span class="stat-unit">%</span></div>
              <div class="stat-details">
                <span class="stat-detail-item">
                  <span class="stat-detail-label">错误数:</span>
                  <span class="stat-detail-value">{{ formatNumber(stats?.failedRequests || 0) }}</span>
                </span>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">路由分类速度</div>
              <div class="stat-main-value">{{ formatResponseTime(expertRoutingSpeed) }}<span class="stat-unit">{{ expertRoutingSpeed >= 1000 ? 's' : 'ms' }}</span></div>
              <div class="stat-details">
                <span class="stat-detail-item">
                  <span class="stat-detail-label">分类次数:</span>
                  <span class="stat-detail-value">{{ formatNumber(expertRoutingCount) }}</span>
                </span>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">热门模型</div>
              <div class="stat-main-value top-model-name">{{ topModel }}</div>
              <div class="stat-provider">{{ topModelProvider }}</div>
              <div class="stat-details">
                <span class="stat-detail-item">
                  <span class="stat-detail-label">请求:</span>
                  <span class="stat-detail-value">{{ formatNumber(topModelRequests) }}</span>
                </span>
                <span class="stat-detail-item">
                  <span class="stat-detail-label">Token:</span>
                  <span class="stat-detail-value">{{ formatTokenNumber(topModelTokens) }}</span>
                </span>
              </div>
            </div>
          </n-card>
        </n-gi>
      </n-grid>

      <n-card class="trend-card">
        <template #header>
          <n-space justify="space-between" align="center" class="trend-header">
            <span>请求趋势</span>
            <n-space :size="8" class="trend-buttons">
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
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useMessage, NSpace, NGrid, NGi, NCard, NSelect, NEmpty, NButton, NIcon, NSpin, NResult } from 'naive-ui';
import { RefreshOutline } from '@vicons/ionicons5';
import { useI18n } from 'vue-i18n';
import { useProviderStore } from '@/stores/provider';
import { useVirtualKeyStore } from '@/stores/virtual-key';
import { configApi, type ApiStats, type VirtualKeyTrend, type ExpertRoutingStats, type ModelStat } from '@/api/config';
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
const expertRoutingStats = ref<ExpertRoutingStats | null>(null);
const modelStats = ref<ModelStat[]>([]);
const selectedPeriod = ref<'24h' | '7d' | '30d'>('24h');
const chartMetric = ref<'requests' | 'tokens'>('requests');
const loading = ref(false);
const loadError = ref<string | null>(null);
const windowWidth = ref(window.innerWidth);

const periodOptions = computed(() => [
  { label: t('dashboard.period.last24Hours'), value: '24h' },
  { label: t('dashboard.period.last7Days'), value: '7d' },
  { label: t('dashboard.period.last30Days'), value: '30d' },
]);

const gridCols = computed(() => {
  if (windowWidth.value < 640) return 1; // 手机端：1列
  if (windowWidth.value < 1024) return 2; // 平板端：2列
  if (windowWidth.value < 1280) return 3; // 小桌面：3列
  return 4; // 大桌面：4列
});

const gridGap = computed(() => {
  if (windowWidth.value < 640) return 12; // 手机端：较小间距
  return 20; // 桌面端：正常间距
});

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

const expertRoutingSpeed = computed(() => {
  return expertRoutingStats.value?.avgClassificationTime || 0;
});

const expertRoutingCount = computed(() => {
  return expertRoutingStats.value?.totalRequests || 0;
});

const topModel = computed(() => {
  if (modelStats.value.length === 0) return '-';
  return modelStats.value[0].model;
});

const topModelProvider = computed(() => {
  if (modelStats.value.length === 0) return '-';
  return modelStats.value[0].provider_name || '-';
});

const topModelRequests = computed(() => {
  if (modelStats.value.length === 0) return 0;
  return modelStats.value[0].request_count || 0;
});

const topModelTokens = computed(() => {
  if (modelStats.value.length === 0) return 0;
  return modelStats.value[0].total_tokens || 0;
});

const cacheHitRate = computed(() => {
  if (!stats.value) return 0;
  const cached = stats.value.cachedTokens || 0;
  const prompt = stats.value.promptTokens || 0;
  const denom = cached + prompt;
  return denom === 0 ? 0 : (cached / denom) * 100;
});

const promptTokens = computed(() => {
  if (!stats.value) return 0;
  return stats.value.promptTokens || 0;
});

const completionTokens = computed(() => {
  if (!stats.value) return 0;
  return stats.value.completionTokens || 0;
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

  const isMobile = windowWidth.value < 640;

  const series = trendData.value.map((keyTrend, index) => {
    const colorScheme = COLOR_PALETTE[index % COLOR_PALETTE.length];

    return {
      name: keyTrend.virtualKeyName,
      type: 'line',
      smooth: true,
      smoothMonotone: 'x',
      symbol: 'circle',
      symbolSize: isMobile ? 5 : 7,
      showSymbol: false,
      lineStyle: {
        width: isMobile ? 2 : 3,
        shadowColor: colorScheme.line,
        shadowBlur: isMobile ? 4 : 8,
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
        fontSize: isMobile ? 11 : 13,
      },
      padding: isMobile ? [8, 12] : [12, 16],
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
        const headerFontSize = isMobile ? 12 : 14;
        const itemFontSize = isMobile ? 11 : 13;
        const marginBottom = isMobile ? 6 : 10;
        const itemMargin = isMobile ? 4 : 6;
        let result = `<div style="font-weight: 600; margin-bottom: ${marginBottom}px; color: #111827; font-size: ${headerFontSize}px;">${formatTimestamp(timestamp, selectedPeriod.value)}</div>`;
        params.forEach((param: any) => {
          const value = chartMetric.value === 'requests'
            ? `${formatNumber(param.value)} 次`
            : `${formatTokenNumber(param.value)} tokens`;
          result += `<div style="display: flex; align-items: center; margin: ${itemMargin}px 0;">
            <span style="display: inline-block; width: ${isMobile ? 10 : 12}px; height: ${isMobile ? 10 : 12}px; border-radius: 3px; background-color: ${param.color}; margin-right: ${isMobile ? 8 : 10}px;"></span>
            <span style="flex: 1; color: #4b5563; font-size: ${itemFontSize}px;">${param.seriesName}</span>
            <span style="font-weight: 600; margin-left: ${isMobile ? 12 : 16}px; color: #111827; font-size: ${itemFontSize}px;">${value}</span>
          </div>`;
        });
        return result;
      }
    },
    legend: {
      data: trendData.value.map(t => t.virtualKeyName),
      top: isMobile ? 8 : 12,
      left: 'center',
      type: 'scroll',
      pageButtonPosition: 'end',
      itemWidth: isMobile ? 12 : 14,
      itemHeight: isMobile ? 12 : 14,
      itemGap: isMobile ? 12 : 20,
      textStyle: {
        color: '#6b7280',
        fontSize: isMobile ? 11 : 13,
        fontWeight: 500,
      },
      pageIconColor: '#0f6b4a',
      pageIconInactiveColor: '#d1d5db',
      pageTextStyle: {
        color: '#6b7280',
      },
    },
    grid: {
      left: isMobile ? '1%' : '2%',
      right: isMobile ? '1%' : '2%',
      bottom: isMobile ? '3%' : '5%',
      top: isMobile ? 55 : 70,
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
        fontSize: isMobile ? 10 : 12,
        margin: isMobile ? 8 : 12,
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
        fontSize: isMobile ? 10 : 12,
        margin: isMobile ? 8 : 12,
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

async function loadData() {
  await Promise.all([
    providerStore.fetchProviders(),
    virtualKeyStore.fetchVirtualKeys(),
    loadStats(),
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
    expertRoutingStats.value = result.expertRoutingStats || { totalRequests: 0, avgClassificationTime: 0 };
    modelStats.value = result.modelStats || [];
  } catch (error: any) {
    const errorMsg = error.message || '加载数据失败';
    loadError.value = errorMsg;
    message.error(errorMsg);
  } finally {
    loading.value = false;
  }
}

const handleResize = () => {
  windowWidth.value = window.innerWidth;
};

onMounted(() => {
  loadData();
  window.addEventListener('resize', handleResize);
});

onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
});
</script>

<style scoped>
.dashboard-view {
  max-width: 1400px;
  margin: 0 auto;
  padding: 0 16px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}

@media (max-width: 639px) {
  .dashboard-view {
    padding: 0 12px;
  }
}

.dashboard-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  flex-wrap: wrap;
  gap: 16px;
}

@media (max-width: 639px) {
  .dashboard-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }

  .dashboard-controls {
    width: 100%;
  }
}

.page-title {
  font-size: 32px;
  font-weight: 600;
  color: #1a1a1a;
  margin: 0;
  letter-spacing: -0.03em;
}

@media (max-width: 639px) {
  .page-title {
    font-size: 24px;
  }
}

.page-subtitle {
  font-size: 14px;
  color: #8c8c8c;
  margin: 4px 0 0 0;
  font-weight: 400;
}

@media (max-width: 639px) {
  .page-subtitle {
    font-size: 13px;
  }
}

.stat-card {
  background: #ffffff;
  border-radius: 16px;
  border: none;
  transition: all 0.3s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  height: 100%;
}

@media (max-width: 639px) {
  .stat-card {
    border-radius: 12px;
  }
}

.stat-card :deep(.n-card__content) {
  padding: 0;
  height: 100%;
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

.stat-card-primary .stat-header {
  color: rgba(255, 255, 255, 0.9);
}

.stat-card-primary .stat-main-value {
  color: #ffffff;
}

.stat-card-primary .stat-detail-label,
.stat-card-primary .stat-detail-value {
  color: rgba(255, 255, 255, 0.85);
}

.stat-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 24px;
}

@media (max-width: 639px) {
  .stat-content {
    padding: 20px;
  }
}

.stat-header {
  font-size: 12px;
  font-weight: 500;
  color: #8c8c8c;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 16px;
}

.stat-main-value {
  font-size: 42px;
  font-weight: 600;
  color: #1a1a1a;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  margin-bottom: 8px;
}

@media (max-width: 639px) {
  .stat-main-value {
    font-size: 36px;
  }
}

.top-model-name {
  font-size: 16px !important;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 639px) {
  .top-model-name {
    font-size: 14px !important;
  }
}

.stat-provider {
  font-size: 13px;
  font-weight: 500;
  color: #0f6b4a;
  margin-bottom: auto;
  padding-bottom: 16px;
}

@media (max-width: 639px) {
  .stat-provider {
    font-size: 12px;
  }
}

.stat-value-error {
  color: #d03050;
}

.stat-unit {
  font-size: 18px;
  font-weight: 400;
  margin-left: 4px;
}

.stat-details {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  font-size: 13px;
  margin-top: auto;
}

@media (max-width: 639px) {
  .stat-details {
    gap: 12px;
    font-size: 12px;
  }
}

.stat-detail-item {
  display: flex;
  gap: 6px;
  align-items: center;
}

.stat-detail-label {
  color: #8c8c8c;
  font-weight: 400;
}

.stat-detail-value {
  color: #1a1a1a;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.stat-detail-success .stat-detail-label {
  color: #0f6b4a;
}

.stat-detail-success .stat-detail-value {
  color: #0f6b4a;
}

.stat-detail-error .stat-detail-label {
  color: #d03050;
}

.stat-detail-error .stat-detail-value {
  color: #d03050;
}

.stat-progress {
  width: 100%;
  height: 8px;
  background: #f0f0f0;
  border-radius: 4px;
  overflow: hidden;
  margin-top: auto;
}

.stat-progress-bar {
  height: 100%;
  background: linear-gradient(90deg, #0f6b4a 0%, #10b981 100%);
  border-radius: 4px;
  transition: width 0.3s ease;
}

.trend-card {
  background: #ffffff;
  border-radius: 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  transition: box-shadow 0.3s ease;
}

@media (max-width: 639px) {
  .trend-card {
    border-radius: 12px;
  }
}

.trend-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
}

.trend-card :deep(.n-card__header) {
  padding: 24px 28px 20px;
  border-bottom: 1px solid #f3f4f6;
}

@media (max-width: 639px) {
  .trend-card :deep(.n-card__header) {
    padding: 20px 16px 16px;
  }
}

.trend-card :deep(.n-card-header__main) {
  font-size: 18px;
  font-weight: 600;
  color: #1a1a1a;
  letter-spacing: -0.02em;
}

@media (max-width: 639px) {
  .trend-card :deep(.n-card-header__main) {
    font-size: 16px;
  }

  .trend-header {
    flex-wrap: wrap;
  }

  .trend-buttons {
    width: 100%;
    justify-content: flex-start;
  }
}

.trend-chart-container {
  padding: 24px 16px 16px;
  min-height: 400px;
}

@media (max-width: 639px) {
  .trend-chart-container {
    padding: 16px 8px 12px;
    min-height: 300px;
  }
}

.trend-chart {
  width: 100%;
  height: 420px;
}

@media (max-width: 639px) {
  .trend-chart {
    height: 320px;
  }
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

@media (max-width: 639px) {
  .overview-card {
    border-radius: 12px;
  }
}

.overview-card :deep(.n-card__header) {
  padding: 24px 28px;
  border-bottom: 1px solid #f0f0f0;
}

@media (max-width: 639px) {
  .overview-card :deep(.n-card__header) {
    padding: 20px 16px;
  }
}

.overview-card :deep(.n-card-header__main) {
  font-size: 18px;
  font-weight: 600;
  color: #1a1a1a;
  letter-spacing: -0.02em;
}

@media (max-width: 639px) {
  .overview-card :deep(.n-card-header__main) {
    font-size: 16px;
  }
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 24px;
}

@media (max-width: 1023px) {
  .overview-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 20px;
  }
}

@media (max-width: 639px) {
  .overview-grid {
    grid-template-columns: 1fr;
    gap: 16px;
  }
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

@media (max-width: 639px) {
  .overview-value {
    font-size: 16px;
  }
}

@media (max-width: 639px) {
  .overview-label {
    font-size: 12px;
  }
}
</style>


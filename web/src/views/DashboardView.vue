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
          <div class="switchable-card" @click="toggleTokenCard">
            <n-card v-if="!isTokenCardFlipped" class="stat-card stat-card-primary">
              <div class="stat-content">
                <div class="stat-header">
                  {{ t('dashboard.tokenConsumption') }}
                  <n-icon size="14" class="flip-icon"><RefreshOutline /></n-icon>
                </div>
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
            <n-card v-else class="stat-card stat-card-primary">
              <div class="stat-content">
                <div class="stat-header">
                  历史总消耗
                  <n-icon size="14" class="flip-icon"><RefreshOutline /></n-icon>
                </div>
                <div class="stat-main-value">{{ formatTokenNumber(statsAllTime?.totalTokens || 0) }}</div>
                <div class="stat-details">
                  <span class="stat-detail-item">
                    <span class="stat-detail-label">输入:</span>
                    <span class="stat-detail-value">{{ formatTokenNumber(statsAllTime?.promptTokens || 0) }}</span>
                  </span>
                  <span class="stat-detail-item">
                    <span class="stat-detail-label">输出:</span>
                    <span class="stat-detail-value">{{ formatTokenNumber(statsAllTime?.completionTokens || 0) }}</span>
                  </span>
                </div>
              </div>
            </n-card>
          </div>
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
        <n-gi>
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">平均效率</div>
              <div class="stat-main-value">{{ formatNumber(avgTokensPerRequest) }}<span class="stat-unit">Tk/Req</span></div>
              <div class="stat-details">
                <span class="stat-detail-item">
                  <span class="stat-detail-label">输入:</span>
                  <span class="stat-detail-value">{{ formatNumber(avgInputTokens) }}</span>
                </span>
                <span class="stat-detail-item">
                  <span class="stat-detail-label">输出:</span>
                  <span class="stat-detail-value">{{ formatNumber(avgOutputTokens) }}</span>
                </span>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">成本分析</div>
              <div class="stat-main-value">{{ formatCost(costStats?.totalCost || 0) }}<span class="stat-unit">USD</span></div>
              <div class="stat-details">
                <span class="stat-detail-item">
                  <span class="stat-detail-label">计费模型:</span>
                  <span class="stat-detail-value">{{ costStats?.modelCosts?.length || 0 }} 个</span>
                </span>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">数据库状态</div>
              <div class="stat-main-value">{{ stats?.dbSize || 0 }}<span class="stat-unit">MB</span></div>
              <div class="stat-details">
                <span class="stat-detail-item">
                  <span class="stat-detail-label">状态:</span>
                  <span class="stat-detail-value" style="color: #006241">正常</span>
                </span>
                <span class="stat-detail-item">
                  <span class="stat-detail-label">运行时长:</span>
                  <span class="stat-detail-value">{{ formatUptime(stats?.dbUptime || 0) }}</span>
                </span>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">熔断器触发次数</div>
              <div class="stat-main-value" :class="{ 'stat-value-error': (circuitBreakerStats?.totalTriggers || 0) > 0 }">
                {{ formatNumber(circuitBreakerStats?.totalTriggers || 0) }}
              </div>
              <div class="stat-details">
                <span class="stat-detail-item">
                  <span class="stat-detail-label">触发最多:</span>
                  <span class="stat-detail-value" :title="circuitBreakerStats?.maxTriggeredProvider">
                    {{ formatProviderName(circuitBreakerStats?.maxTriggeredProvider) }}
                  </span>
                </span>
              </div>
            </div>
          </n-card>
        </n-gi>
      </n-grid>

      <n-grid cols="1 l:3" responsive="screen" :x-gap="gridGap" :y-gap="gridGap">
        <n-gi span="1 l:2">
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
        </n-gi>
        <n-gi>
          <n-card class="trend-card">
            <template #header>
              <n-space justify="space-between" align="center" class="trend-header">
                <span>模型 Token 占比</span>
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
                    Token
                  </n-button>
                </n-space>
              </n-space>
            </template>
            <div v-if="loading" class="trend-loading">
              <n-spin size="large" />
            </div>
            <div v-else-if="modelStats.length > 0" class="trend-chart-container">
              <v-chart :option="modelDistributionOption" :autoresize="true" class="trend-chart" />
            </div>
            <n-empty v-else description="暂无数据" :show-icon="false" />
          </n-card>
        </n-gi>
      </n-grid>
  
    <n-grid cols="1" responsive="screen">
      <n-gi>
        <n-card class="trend-card" style="margin-bottom: 24px;">
          <template #header>
            <n-space justify="space-between" align="center" class="trend-header">
              <span>响应时间分布</span>
              <span style="font-size: 12px; color: #6b7280; font-weight: normal;">(最近 2000 次请求)</span>
            </n-space>
          </template>
          <div v-if="loading" class="trend-loading">
            <n-spin size="large" />
          </div>
          <div v-else-if="modelResponseTimeStats.length > 0" class="trend-chart-container">
            <v-chart :option="responseTimeDistributionOption" :autoresize="true" class="trend-chart" />
          </div>
          <n-empty v-else description="暂无数据" :show-icon="false" />
        </n-card>
      </n-gi>
    </n-grid>
  
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
import { configApi, type ApiStats, type VirtualKeyTrend, type ExpertRoutingStats, type ModelStat, type CostStats, type ModelResponseTimeStat } from '@/api/config';
import { formatNumber, formatTokenNumber, formatPercentage, formatResponseTime, formatTimestamp, formatUptime } from '@/utils/format';
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { LineChart, PieChart, ScatterChart } from 'echarts/charts';
import {
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  DataZoomComponent
} from 'echarts/components';
import VChart from 'vue-echarts';

use([
  CanvasRenderer,
  LineChart,
  PieChart,
  ScatterChart,
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  DataZoomComponent
]);

const { t } = useI18n();
const message = useMessage();
const providerStore = useProviderStore();
const virtualKeyStore = useVirtualKeyStore();

const stats = ref<ApiStats | null>(null);
const statsAllTime = ref<ApiStats | null>(null);
const isTokenCardFlipped = ref(false);
const trendData = ref<VirtualKeyTrend[]>([]);
const expertRoutingStats = ref<ExpertRoutingStats | null>(null);
const modelStats = ref<ModelStat[]>([]);
const modelResponseTimeStats = ref<ModelResponseTimeStat[]>([]);
const circuitBreakerStats = ref<{
  totalTriggers: number;
  maxTriggeredProvider: string;
  maxTriggerCount: number;
} | null>(null);
const costStats = ref<CostStats | null>(null);
const selectedPeriod = ref<'24h' | '7d' | '30d'>('24h');
const chartMetric = ref<'requests' | 'tokens'>('requests');
const loading = ref(false);
const loadError = ref<string | null>(null);
const windowWidth = ref(window.innerWidth);

async function toggleTokenCard() {
  isTokenCardFlipped.value = !isTokenCardFlipped.value;
  if (isTokenCardFlipped.value && !statsAllTime.value) {
    try {
      const result = await configApi.getStats('all');
      if (result && result.stats) {
        statsAllTime.value = result.stats;
      }
    } catch (e) {
      console.error('Failed to load all-time stats', e);
    }
  }
}

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
  if (!stats.value) return 0;
  const total = Number(stats.value.totalRequests || 0);
  if (total === 0) return 0;
  return (Number(stats.value.successfulRequests || 0) / total) * 100;
});

const errorRate = computed(() => {
  if (!stats.value) return 0;
  const total = Number(stats.value.totalRequests || 0);
  if (total === 0) return 0;
  return (Number(stats.value.failedRequests || 0) / total) * 100;
});

const avgResponseTime = computed(() => {
  return Number(stats.value?.avgResponseTime || 0);
});

const avgTokensPerRequest = computed(() => {
  const reqs = Number(stats.value?.totalRequests || 0);
  if (reqs === 0) return 0;
  return Math.round(Number(stats.value?.totalTokens || 0) / reqs);
});

const avgInputTokens = computed(() => {
  const reqs = Number(stats.value?.totalRequests || 0);
  if (reqs === 0) return 0;
  return Math.round(Number(stats.value?.promptTokens || 0) / reqs);
});

const avgOutputTokens = computed(() => {
  const reqs = Number(stats.value?.totalRequests || 0);
  if (reqs === 0) return 0;
  return Math.round(Number(stats.value?.completionTokens || 0) / reqs);
});

const expertRoutingSpeed = computed(() => {
  return Number(expertRoutingStats.value?.avgClassificationTime || 0);
});

const expertRoutingCount = computed(() => {
  return Number(expertRoutingStats.value?.totalRequests || 0);
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
  return Number(modelStats.value[0].request_count || 0);
});

const topModelTokens = computed(() => {
  if (modelStats.value.length === 0) return 0;
  return Number(modelStats.value[0].total_tokens || 0);
});

const cacheHitRate = computed(() => {
  if (!stats.value) return 0;
  const cached = Number(stats.value.cachedTokens || 0);
  const prompt = Number(stats.value.promptTokens || 0);
  const denom = cached + prompt;
  return denom === 0 ? 0 : (cached / denom) * 100;
});

const promptTokens = computed(() => {
  if (!stats.value) return 0;
  return Number(stats.value.promptTokens || 0);
});

const completionTokens = computed(() => {
  if (!stats.value) return 0;
  return Number(stats.value.completionTokens || 0);
});

// Starbucks & Nature Inspired Palette
const COLOR_PALETTE = [
  { line: '#006241', gradient: ['rgba(0, 98, 65, 0.4)', 'rgba(0, 98, 65, 0.05)'] }, // Starbucks Green
  { line: '#C4996C', gradient: ['rgba(196, 153, 108, 0.4)', 'rgba(196, 153, 108, 0.05)'] }, // Coffee/Gold
  { line: '#1E3932', gradient: ['rgba(30, 57, 50, 0.4)', 'rgba(30, 57, 50, 0.05)'] }, // House Green
  { line: '#2D8A6D', gradient: ['rgba(45, 138, 109, 0.4)', 'rgba(45, 138, 109, 0.05)'] }, // Medium Green
  { line: '#A89F91', gradient: ['rgba(168, 159, 145, 0.4)', 'rgba(168, 159, 145, 0.05)'] }, // Warm Gray
  { line: '#6CA68D', gradient: ['rgba(108, 166, 141, 0.4)', 'rgba(108, 166, 141, 0.05)'] }, // Sage
  { line: '#4A4A4A', gradient: ['rgba(74, 74, 74, 0.4)', 'rgba(74, 74, 74, 0.05)'] }, // Dark Gray
  { line: '#D4E9E2', gradient: ['rgba(212, 233, 226, 0.4)', 'rgba(212, 233, 226, 0.05)'] }, // Mint
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
      top: isMobile ? 55 : 70
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

const responseTimeDistributionOption = computed(() => {
  if (!modelResponseTimeStats.value || modelResponseTimeStats.value.length === 0) {
    return {};
  }

  const isMobile = windowWidth.value < 640;

  const data = modelResponseTimeStats.value.map(item => [
    item.created_at,
    item.response_time,
    item.model
  ]);

  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(255, 255, 255, 0.95)',
      borderColor: '#e5e7eb',
      borderWidth: 1,
      textStyle: {
        color: '#1f2937',
        fontSize: isMobile ? 11 : 13,
      },
      formatter: (params: any) => {
        const [time, duration, model] = params.data;
        const date = new Date(time);
        const timeStr = `${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
        return `<div style="font-weight: 600; color: #111827;">${model}</div>
                <div style="margin-top: 4px; color: #6b7280;">
                  Time: ${timeStr}<br/>
                  Latency: ${formatResponseTime(duration)}ms
                </div>`;
      }
    },
    grid: {
      left: isMobile ? '2%' : '4%',
      right: isMobile ? '4%' : '4%',
      bottom: isMobile ? '3%' : '8%',
      top: isMobile ? 30 : 40,
      containLabel: true
    },
    xAxis: {
      type: 'time',
      boundaryGap: false,
      axisLine: {
        lineStyle: {
          color: '#e5e7eb',
          width: 1,
        }
      },
      axisLabel: {
        color: '#9ca3af',
        fontSize: isMobile ? 10 : 12,
        formatter: (value: number) => {
          const date = new Date(value);
          return `${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}`;
        }
      },
      splitLine: {
        show: false
      }
    },
    yAxis: {
      type: 'value',
      name: 'ms',
      nameTextStyle: {
        color: '#9ca3af',
        align: 'right',
        padding: [0, 0, 0, 6]
      },
      axisLine: {
        show: false,
      },
      axisTick: {
        show: false,
      },
      axisLabel: {
        color: '#9ca3af',
        fontSize: isMobile ? 10 : 12,
      },
      splitLine: {
        lineStyle: {
          color: '#f3f4f6',
          width: 1,
          type: 'dashed',
        }
      }
    },
    series: [
      {
        name: 'Response Time',
        type: 'scatter',
        symbolSize: isMobile ? 5 : 8,
        itemStyle: {
          color: (params: any) => {
             const modelName = params.data[2] as string;
             let hash = 0;
             for (let i = 0; i < modelName.length; i++) {
               hash = modelName.charCodeAt(i) + ((hash << 5) - hash);
             }
             const index = Math.abs(hash) % COLOR_PALETTE.length;
             return COLOR_PALETTE[index].line;
          },
          opacity: 0.6,
          borderColor: '#fff',
          borderWidth: 1
        },
        emphasis: {
            focus: 'series',
            itemStyle: {
                opacity: 1,
                borderWidth: 2
            }
        },
        data: data
      }
    ]
  };
});

const modelDistributionOption = computed(() => {
  if (!modelStats.value || modelStats.value.length === 0) {
    return {};
  }

  const data = modelStats.value
    .map(item => ({
      name: item.model,
      value: chartMetric.value === 'requests' ? Number(item.request_count || 0) : Number(item.total_tokens || 0)
    }))
    .filter(d => d.value > 0);

  if (data.length === 0) return {};
  
  // Sort data
  data.sort((a, b) => b.value - a.value);

  const isMobile = windowWidth.value < 640;

  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(255, 255, 255, 0.95)',
      borderColor: '#e5e7eb',
      borderWidth: 1,
      textStyle: {
        color: '#1f2937',
        fontSize: isMobile ? 11 : 13,
      },
      formatter: (params: any) => {
        const val = chartMetric.value === 'requests'
          ? formatNumber(params.value)
          : formatTokenNumber(params.value);
        return `<div style="font-weight: 600; color: #111827;">${params.name}</div>
                <div style="margin-top: 4px;">${params.marker} ${val} (${params.percent}%)</div>`;
      }
    },
    legend: {
      type: 'scroll',
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      textStyle: {
        color: '#6b7280',
        fontSize: isMobile ? 11 : 12
      },
      formatter: (name: string) => {
        return name.length > 15 ? name.slice(0, 15) + '...' : name;
      }
    },
    series: [
      {
        name: chartMetric.value === 'requests' ? '请求数' : 'Token 消耗',
        type: 'pie',
        radius: ['40%', '60%'],
        center: ['50%', '40%'],
        avoidLabelOverlap: false,
        itemStyle: {
          borderRadius: 4,
          borderColor: '#ffffff',
          borderWidth: 3
        },
        label: {
          show: false,
          position: 'center'
        },
        emphasis: {
          label: {
            show: true,
            fontSize: isMobile ? 14 : 16,
            fontWeight: '600',
            color: '#006241',
            formatter: '{b}\n{d}%'
          },
          scale: true,
          scaleSize: 10
        },
        labelLine: {
          show: false
        },
        data: data,
        color: COLOR_PALETTE.map(c => c.line)
      }
    ]
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
    circuitBreakerStats.value = result.circuitBreakerStats || { totalTriggers: 0, maxTriggeredProvider: '-', maxTriggerCount: 0 };
    costStats.value = result.costStats || null;
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

const formatProviderName = (name: string | undefined) => {
  if (!name || name === '-') return '-';
  return name.length > 15 ? name.slice(0, 15) + '...' : name;
};

const formatCost = (cost: number) => {
  if (cost === 0) return '0.00';
  if (cost < 0.01) return cost.toFixed(4);
  return cost.toFixed(2);
};

onMounted(() => {
  loadData();
  window.addEventListener('resize', handleResize);
  // When cost mapping rules change, refresh dashboard stats so cost analysis updates in real time
  window.addEventListener('cost-mapping-updated', loadStats as any);
});
 
onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
  window.removeEventListener('cost-mapping-updated', loadStats as any);
});
</script>

<style scoped src="@/styles/dashboard.css"></style>


<template>
  <div>
    <n-space vertical :size="24">
      <n-card>
        <template #header>
          <n-space align="center" justify="space-between">
            <n-space align="center">
              <span style="font-size: 16px; font-weight: 600;">{{ t('trafficAnalysis.title') }}</span>
              <n-tag v-if="data?.region" size="small" type="info">
                {{ t('trafficAnalysis.regionLabel') }}: {{ data.region }}
              </n-tag>
              <n-tag v-else size="small">
                {{ t('trafficAnalysis.noRegion') }}
              </n-tag>
            </n-space>
            <n-space align="center">
              <n-checkbox v-model:checked="overlayMode">{{ t('trafficAnalysis.overlayMode') }}</n-checkbox>
              <n-select
                v-if="overlayMode"
                v-model:value="overlayDayOffset"
                :options="overlayDayOptions"
                size="small"
                style="width: 100px;"
                :loading="overlayLoading"
              />
              <n-button size="small" :loading="loading" @click="refresh">
                <template #icon>
                  <n-icon><RefreshOutline /></n-icon>
                </template>
                {{ t('common.refresh') }}
              </n-button>
            </n-space>
          </n-space>
        </template>

        <n-alert
          v-if="data?.dataQuality === 'insufficient'"
          type="warning"
          style="margin-bottom: 16px;"
        >
          {{ t('trafficAnalysis.dataInsufficient') }}
        </n-alert>
        <n-alert
          v-else-if="data?.dataQuality === 'low'"
          type="info"
          style="margin-bottom: 16px;"
        >
          {{ t('trafficAnalysis.dataLow') }}
        </n-alert>

        <n-grid
          v-if="data && !loading"
          :cols="windowWidth < 640 ? 2 : 4"
          :x-gap="12"
          :y-gap="12"
          style="margin-bottom: 16px;"
        >
          <n-gi>
            <n-statistic :value="data.availableDays">
              <template #label>
                <n-tooltip trigger="hover">
                  <template #trigger>
                    <span class="stat-label-hint">{{ t('trafficAnalysis.availableDays') }}</span>
                  </template>
                  {{ t('trafficAnalysis.availableDaysTip') }}
                </n-tooltip>
              </template>
              <template #suffix>{{ t('trafficAnalysis.daysSuffix') }}</template>
            </n-statistic>
          </n-gi>
          <n-gi>
            <n-statistic :value="data.modelInfo.trainingSamples">
              <template #label>
                <n-tooltip trigger="hover">
                  <template #trigger>
                    <span class="stat-label-hint">{{ t('trafficAnalysis.trainingSamples') }}</span>
                  </template>
                  {{ t('trafficAnalysis.trainingSamplesTip') }}
                </n-tooltip>
              </template>
            </n-statistic>
          </n-gi>
          <n-gi>
            <n-statistic>
              <template #label>
                <n-tooltip trigger="hover">
                  <template #trigger>
                    <span class="stat-label-hint">{{ t('trafficAnalysis.predictionAccuracy') }}</span>
                  </template>
                  {{ t('trafficAnalysis.predictionAccuracyTip') }}
                </n-tooltip>
              </template>
              <template #default>
                <span :style="accuracyColor">
                  {{ accuracyText }}
                </span>
              </template>
            </n-statistic>
          </n-gi>
          <n-gi>
            <n-statistic :value="wapeText">
              <template #label>
                <n-tooltip trigger="hover">
                  <template #trigger>
                    <span class="stat-label-hint">{{ t('trafficAnalysis.wape') }}</span>
                  </template>
                  {{ t('trafficAnalysis.wapeTip') }}
                </n-tooltip>
              </template>
            </n-statistic>
          </n-gi>
        </n-grid>

        <n-skeleton v-if="loading" :height="chartHeight" />
        <n-result
          v-else-if="error"
          status="error"
          :title="t('common.error')"
          :description="error"
        />
        <v-chart
          v-else-if="chartOption"
          :option="chartOption"
          :style="{ height: chartHeight + 'px' }"
          autoresize
        />
      </n-card>

      <n-card class="trend-card">
        <template #header>
          <n-space justify="space-between" align="center" class="trend-header">
            <div>
              <span class="chart-header-title">{{ t('trafficAnalysis.latencyDistribution') }}</span>
              <span class="chart-header-note">({{ t('trafficAnalysis.latencyNote') }})</span>
            </div>
            <n-select
              v-model:value="selectedLatencyModel"
              :options="latencyModelOptions"
              clearable
              size="small"
              class="latency-model-select"
              :placeholder="t('trafficAnalysis.selectModel')"
            />
          </n-space>
        </template>
        <div v-if="latencyLoading" class="trend-loading">
          <n-spin size="large" />
        </div>
        <div v-else-if="filteredLatencyData.length > 0" class="trend-chart-container">
          <v-chart :option="latencyDistributionOption" :autoresize="true" class="trend-chart" />
        </div>
        <n-empty v-else :description="t('trafficAnalysis.noLatencyData')" :show-icon="false" />
      </n-card>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NSpace, NCard, NButton, NIcon, NTag, NAlert, NSkeleton, NResult, NEmpty,
  NGrid, NGi, NStatistic, NSelect, NSpin, NTooltip, NCheckbox,
} from 'naive-ui';
import { RefreshOutline } from '@vicons/ionicons5';
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { LineChart, ScatterChart } from 'echarts/charts';
import {
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  MarkLineComponent,
  MarkAreaComponent,
} from 'echarts/components';
import VChart from 'vue-echarts';
import { configApi, type TrafficAnalysisResponse, type TrafficAnalysisHistoryDayResponse, type ModelResponseTimeStat } from '@/api/config';
import { formatResponseTime } from '@/utils/format';

use([
  CanvasRenderer,
  LineChart,
  ScatterChart,
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  MarkLineComponent,
  MarkAreaComponent,
]);

const { t, locale } = useI18n();

const loading = ref(false);
const error = ref<string | null>(null);
const data = ref<TrafficAnalysisResponse | null>(null);
const windowWidth = ref(window.innerWidth);
const overlayMode = ref(false);
const overlayDayOffset = ref(0);
const overlayDayData = ref<TrafficAnalysisHistoryDayResponse | null>(null);
const overlayLoading = ref(false);

const chartHeight = computed(() => (windowWidth.value < 640 ? 260 : 380));

const latencyLoading = ref(false);
const latencyData = ref<ModelResponseTimeStat[]>([]);
const selectedLatencyModel = ref<string | null>(null);

const latencyModelOptions = computed(() => {
  const seen = new Set<string>();
  const options: { label: string; value: string }[] = [];
  for (const item of latencyData.value) {
    if (!item.model) continue;
    if (seen.has(item.model)) continue;
    seen.add(item.model);
    options.push({ label: item.model, value: item.model });
  }
  return options;
});

const filteredLatencyData = computed(() => {
  if (!selectedLatencyModel.value) return latencyData.value;
  return latencyData.value.filter(item => item.model === selectedLatencyModel.value);
});

const LATENCY_COLORS = [
  '#006241', '#C4996C', '#1E3932', '#2D8A6D', '#A89F91',
  '#6CA68D', '#4A4A4A', '#D4E9E2', '#8B5E3C', '#5B8C5A',
];

function formatHour(ts: number): string {
  return new Date(ts).toLocaleTimeString(locale.value, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  });
}

function formatTimestampLocal(ts: number): string {
  return new Date(ts).toLocaleString(locale.value, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  });
}

const accuracyText = computed(() => {
  if (!data.value?.accuracy) return '-';
  return (data.value.accuracy.r2 * 100).toFixed(1) + '%';
});

const wapeText = computed(() => {
  if (!data.value?.accuracy) return '-';
  return data.value.accuracy.wape.toFixed(1) + '%';
});

const accuracyColor = computed(() => {
  if (!data.value?.accuracy) return {};
  const r2 = data.value.accuracy.r2;
  if (r2 >= 0.8) return { color: '#006241' };
  if (r2 >= 0.5) return { color: '#C4996C' };
  return { color: '#d03050' };
});

const overlayDayOptions = computed(() => {
  const opts: { label: string; value: number }[] = [];
  const maxDays = Math.min(6, data.value?.availableDays ?? 0);
  for (let i = 0; i <= maxDays; i++) {
    opts.push({ label: i === 0 ? t('trafficAnalysis.today') : t('trafficAnalysis.daysAgo', { n: i }), value: i });
  }
  return opts;
});

async function fetchOverlayDay() {
  if (!overlayMode.value) return;
  overlayLoading.value = true;
  try {
    overlayDayData.value = await configApi.getTrafficAnalysisHistoryDay(overlayDayOffset.value);
  } catch {
    overlayDayData.value = null;
  } finally {
    overlayLoading.value = false;
  }
}

watch([overlayMode, overlayDayOffset], () => {
  if (overlayMode.value) fetchOverlayDay();
  else overlayDayData.value = null;
});

const chartOption = computed(() => {
  if (!data.value) return null;

  const { actual, prediction, peaks } = data.value;
  const nowMs = Date.now();

  const actualData = actual.map(p => [p.timestamp, p.count]);
  const predData = prediction.map(p => [p.timestamp, p.predictedCount]);

  const markAreas = peaks.map(peak => [
    { xAxis: peak.startTimestamp, itemStyle: { color: 'rgba(196, 153, 108, 0.15)' } },
    { xAxis: peak.endTimestamp + 3600000 },
  ]);

  const isSmall = windowWidth.value < 640;

  const legendData = [t('trafficAnalysis.actualSeries'), t('trafficAnalysis.predictedSeries')];
  const series: any[] = [
    {
      name: t('trafficAnalysis.actualSeries'),
      type: 'line',
      data: actualData,
      smooth: true,
      symbol: 'none',
      lineStyle: { color: '#006241', width: 2, type: 'solid' },
      itemStyle: { color: '#006241' },
      markLine: {
        silent: true,
        symbol: 'none',
        lineStyle: { color: '#999', type: 'dashed', width: 1 },
        data: [{ xAxis: Math.floor(nowMs / 3600000) * 3600000, name: 'now' }],
        label: { show: false },
      },
    },
    {
      name: t('trafficAnalysis.predictedSeries'),
      type: 'line',
      data: predData,
      smooth: true,
      symbol: 'none',
      lineStyle: { color: '#C4996C', width: 2, type: 'dashed' },
      itemStyle: { color: '#C4996C' },
      markArea: markAreas.length > 0 ? {
        silent: true,
        data: markAreas,
      } : undefined,
    },
  ];

  if (overlayMode.value && overlayDayData.value) {
    const histActual = overlayDayData.value.actual.map(p => [p.timestamp, p.count]);
    const histPred = overlayDayData.value.predicted.map(p => [p.timestamp, p.predictedCount]);
    const histActualName = t('trafficAnalysis.overlayActual', { day: overlayDayOffset.value });
    const histPredName = t('trafficAnalysis.overlayPredicted', { day: overlayDayOffset.value });
    legendData.push(histActualName, histPredName);
    series.push(
      {
        name: histActualName,
        type: 'line',
        data: histActual,
        smooth: true,
        symbol: 'none',
        lineStyle: { color: '#2080F0', width: 2, type: 'solid' },
        itemStyle: { color: '#2080F0' },
      },
      {
        name: histPredName,
        type: 'line',
        data: histPred,
        smooth: true,
        symbol: 'none',
        lineStyle: { color: '#E8833A', width: 2, type: 'dashed' },
        itemStyle: { color: '#E8833A' },
      },
    );
  }

  return {
    tooltip: {
      trigger: 'axis',
      formatter: (params: any[]) => {
        const ts = params[0]?.value?.[0];
        if (!ts) return '';
        const lines = params.map((p: any) => {
          const val = Math.round(p.value?.[1] ?? 0);
          return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px;"></span>${p.seriesName}: <strong>${val}</strong>`;
        });
        return `<div style="font-size:13px;">${formatTimestampLocal(ts)}<br>${lines.join('<br>')}</div>`;
      },
    },
    legend: {
      data: legendData,
      bottom: 4,
      itemWidth: isSmall ? 16 : 20,
      textStyle: { fontSize: isSmall ? 11 : 13 },
    },
    grid: { left: 50, right: 20, top: 20, bottom: 48 },
    xAxis: {
      type: 'time',
      axisLabel: {
        fontSize: isSmall ? 10 : 12,
        formatter: (val: number) => formatHour(val),
      },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { fontSize: isSmall ? 10 : 12 },
    },
    series,
  };
});

const latencyDistributionOption = computed(() => {
  if (!filteredLatencyData.value || filteredLatencyData.value.length === 0) {
    return {};
  }

  const isMobile = windowWidth.value < 640;

  const scatterData = filteredLatencyData.value.map(item => [
    item.created_at,
    item.response_time,
    item.model,
  ]);

  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(255, 255, 255, 0.95)',
      borderColor: '#e5e7eb',
      borderWidth: 1,
      extraCssText: 'backdrop-filter: blur(8px);',
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
                  Latency: ${duration >= 1000 ? (duration / 1000).toFixed(2) + 's' : formatResponseTime(duration) + 'ms'}
                </div>`;
      },
    },
    grid: {
      left: isMobile ? '2%' : '4%',
      right: isMobile ? '4%' : '4%',
      bottom: isMobile ? '3%' : '8%',
      top: isMobile ? 30 : 40,
      containLabel: true,
    },
    xAxis: {
      type: 'time',
      boundaryGap: false,
      axisLine: {
        lineStyle: {
          color: '#e5e7eb',
          width: 1,
        },
      },
      axisLabel: {
        color: '#9ca3af',
        fontSize: isMobile ? 10 : 12,
        formatter: (value: number) => {
          const date = new Date(value);
          return `${date.getHours()}:${date.getMinutes().toString().padStart(2, '0')}`;
        },
      },
      splitLine: {
        show: false,
      },
    },
    yAxis: {
      type: 'value',
      name: t('trafficAnalysis.latency'),
      nameTextStyle: {
        color: '#9ca3af',
        align: 'right',
        padding: [0, 0, 0, 6],
      },
      axisLine: {
        show: true,
      },
      axisTick: {
        show: false,
      },
      axisLabel: {
        show: false,
      },
      splitLine: {
        lineStyle: {
          color: '#f3f4f6',
          width: 1,
          type: 'dashed',
        },
      },
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
            const index = Math.abs(hash) % LATENCY_COLORS.length;
            return LATENCY_COLORS[index];
          },
          opacity: 0.6,
          borderColor: '#fff',
          borderWidth: 1,
        },
        emphasis: {
          focus: 'series',
          itemStyle: {
            opacity: 1,
            borderWidth: 2,
          },
        },
        data: scatterData,
      },
    ],
  };
});

async function refresh() {
  loading.value = true;
  latencyLoading.value = true;
  error.value = null;
  try {
    const [trafficResult, statsResult] = await Promise.all([
      configApi.getTrafficAnalysis(),
      configApi.getStats('30d'),
    ]);
    data.value = trafficResult;
    latencyData.value = statsResult.modelResponseTimeStats || [];
  } catch (err: any) {
    error.value = err?.message || t('common.error');
  } finally {
    loading.value = false;
    latencyLoading.value = false;
  }
}

function handleResize() {
  windowWidth.value = window.innerWidth;
}

onMounted(() => {
  window.addEventListener('resize', handleResize);
  refresh();
});

onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
});
</script>

<style scoped>
.stat-label-hint {
  border-bottom: 1px dashed currentColor;
  cursor: help;
}
.trend-card {
  border-radius: 8px;
}
.trend-header {
  width: 100%;
}
.chart-header-title {
  font-size: 16px;
  font-weight: 600;
  color: #1f2937;
}
.chart-header-note {
  font-size: 12px;
  color: #9ca3af;
  margin-left: 8px;
}
.latency-model-select {
  width: 220px;
}
.trend-loading {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 300px;
}
.trend-chart-container {
  width: 100%;
  height: 340px;
}
.trend-chart {
  width: 100%;
  height: 100%;
}
@media (max-width: 640px) {
  .latency-model-select {
    width: 160px;
  }
  .trend-chart-container {
    height: 260px;
  }
}
</style>

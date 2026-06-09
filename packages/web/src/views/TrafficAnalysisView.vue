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
            <n-button size="small" :loading="loading" @click="refresh">
              <template #icon>
                <n-icon><RefreshOutline /></n-icon>
              </template>
              {{ t('common.refresh') }}
            </n-button>
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

      <n-card :title="t('trafficAnalysis.peakWindow')">
        <n-skeleton v-if="loading" :height="80" />
        <template v-else-if="data">
          <n-empty
            v-if="data.peaks.length === 0"
            :description="t('trafficAnalysis.noPeak')"
          />
          <n-grid v-else :cols="windowWidth < 640 ? 1 : 2" :x-gap="16" :y-gap="16">
            <n-gi v-for="(peak, index) in data.peaks" :key="index">
              <n-card size="small" style="border-left: 4px solid #C4996C;">
                <n-space vertical :size="4">
                  <n-text strong>
                    {{ formatHour(peak.startTimestamp) }} – {{ formatHour(peak.endTimestamp + 3600000) }}
                  </n-text>
                  <n-text depth="3" style="font-size: 12px;">
                    {{ t('trafficAnalysis.surgeRatio') }}:
                    <n-text type="warning" strong>+{{ formatPercent(peak.surgeRatio) }}</n-text>
                    &nbsp;|&nbsp; {{ t('trafficAnalysis.peakCount') }}: {{ Math.round(peak.peakCount) }}
                  </n-text>
                </n-space>
              </n-card>
            </n-gi>
          </n-grid>
        </template>
      </n-card>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NSpace, NCard, NButton, NIcon, NTag, NAlert, NSkeleton, NResult, NEmpty,
  NGrid, NGi, NText,
} from 'naive-ui';
import { RefreshOutline } from '@vicons/ionicons5';
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { LineChart } from 'echarts/charts';
import {
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  MarkLineComponent,
  MarkAreaComponent,
} from 'echarts/components';
import VChart from 'vue-echarts';
import { configApi, type TrafficAnalysisResponse } from '@/api/config';

use([
  CanvasRenderer,
  LineChart,
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

const chartHeight = computed(() => (windowWidth.value < 640 ? 260 : 380));

function formatHour(ts: number): string {
  return new Date(ts).toLocaleTimeString(locale.value, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  });
}

function formatPercent(ratio: number): string {
  return (ratio * 100).toFixed(0) + '%';
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(locale.value, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  });
}

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
        return `<div style="font-size:13px;">${formatTimestamp(ts)}<br>${lines.join('<br>')}</div>`;
      },
    },
    legend: {
      data: [t('trafficAnalysis.actualSeries'), t('trafficAnalysis.predictedSeries')],
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
    series: [
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
    ],
  };
});

async function refresh() {
  loading.value = true;
  error.value = null;
  try {
    data.value = await configApi.getTrafficAnalysis();
  } catch (err: any) {
    error.value = err?.message || t('common.error');
  } finally {
    loading.value = false;
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

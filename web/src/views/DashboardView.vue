<template>
  <div class="dashboard-view">
    <n-space vertical :size="24">
      <div class="dashboard-header">
        <div>
          <h2 class="page-title">仪表盘</h2>
          <p class="page-subtitle">这里监控了当前服务的全部数据</p>
        </div>
        <n-space :size="12">
          <n-button secondary round>
            <template #icon>
              <n-icon><CloudDownloadOutline /></n-icon>
            </template>
            导入数据
          </n-button>
          <n-button type="primary" round>
            <template #icon>
              <n-icon><AddOutline /></n-icon>
            </template>
            添加项目
          </n-button>
        </n-space>
      </div>

      <n-grid :cols="4" :x-gap="20" :y-gap="20">
        <n-gi>
          <n-card class="stat-card stat-card-primary">
            <div class="stat-card-content">
              <div class="stat-label">API 请求总数</div>
              <div class="stat-value-large">{{ formatNumber(stats?.totalRequests || 0) }}</div>
              <div class="stat-trend">
                <n-icon size="16" color="#4ade80">
                  <ArrowUpOutline />
                </n-icon>
                <span class="stat-trend-text">较上月增加</span>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <n-statistic label="成功请求">
              <template #default>
                <span class="stat-value stat-value-success">{{ formatNumber(stats?.successfulRequests || 0) }}</span>
              </template>
              <template #suffix>
                <span class="stat-suffix">次</span>
              </template>
            </n-statistic>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <n-statistic label="失败请求">
              <template #default>
                <span class="stat-value stat-value-error">{{ formatNumber(stats?.failedRequests || 0) }}</span>
              </template>
              <template #suffix>
                <span class="stat-suffix">次</span>
              </template>
            </n-statistic>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <n-statistic label="成功率">
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
            <n-statistic label="Token 消耗" :value="formatLargeNumber(stats?.totalTokens || 0)" />
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <n-statistic label="平均响应时间">
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
            <n-statistic label="错误率">
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
            <n-statistic label="最近请求">
              <template #default>
                <span class="stat-value">{{ formatNumber(recentRequestsCount) }}</span>
              </template>
              <template #suffix>
                <span class="stat-suffix stat-suffix-light">/ 小时</span>
              </template>
            </n-statistic>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <n-statistic label="缓存命中">
              <template #default>
                <span class="stat-value stat-value-success">{{ formatNumber(stats?.cacheHits || 0) }}</span>
              </template>
              <template #suffix>
                <span class="stat-suffix">次</span>
              </template>
            </n-statistic>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card">
            <n-statistic label="缓存命中率">
              <template #default>
                <span class="stat-value" :class="{ 'stat-value-success': cacheHitRate > 20 }">{{ formatPercentage(cacheHitRate) }}</span>
              </template>
              <template #suffix>
                <span class="stat-suffix">%</span>
              </template>
            </n-statistic>
          </n-card>
        </n-gi>
      </n-grid>

      <n-card class="trend-card" title="请求趋势">
        <template #header-extra>
          <n-select
            v-model:value="selectedPeriod"
            :options="periodOptions"
            size="small"
            style="width: 140px;"
            @update:value="loadStats"
          />
        </template>
        <div v-if="trendData.length > 0" class="trend-content">
          <div class="trend-scroll-container">
            <n-space vertical :size="12">
              <div v-for="(item, index) in trendData" :key="index" class="trend-item">
                <span class="trend-time">{{ formatTimestamp(item.timestamp) }}</span>
                <n-progress
                  type="line"
                  :percentage="getPercentage(item.requestCount)"
                  :show-indicator="false"
                  class="trend-progress"
                />
                <span class="trend-count">{{ formatNumber(item.requestCount) }} 次</span>
                <span class="trend-tokens">{{ formatLargeNumber(item.tokenCount) }} tokens</span>
              </div>
            </n-space>
          </div>
        </div>
        <n-empty v-else description="暂无数据" />
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
import { useMessage, NSpace, NGrid, NGi, NCard, NStatistic, NSelect, NProgress, NEmpty, NButton, NIcon } from 'naive-ui';
import { AddOutline, CloudDownloadOutline, ArrowUpOutline } from '@vicons/ionicons5';
import { useProviderStore } from '@/stores/provider';
import { useVirtualKeyStore } from '@/stores/virtual-key';
import { configApi, type ApiStats, type TrendData } from '@/api/config';

const message = useMessage();
const providerStore = useProviderStore();
const virtualKeyStore = useVirtualKeyStore();

const stats = ref<ApiStats | null>(null);
const trendData = ref<TrendData[]>([]);
const selectedPeriod = ref<'24h' | '7d' | '30d'>('24h');

const periodOptions = [
  { label: '最近 24 小时', value: '24h' },
  { label: '最近 7 天', value: '7d' },
  { label: '最近 30 天', value: '30d' },
];

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

const recentRequestsCount = computed(() => {
  if (trendData.value.length === 0) return 0;
  const lastHourData = trendData.value.slice(-1)[0];
  return lastHourData?.requestCount || 0;
});

const cacheHitRate = computed(() => {
  if (!stats.value || stats.value.totalRequests === 0) return 0;
  return (stats.value.cacheHits / stats.value.totalRequests) * 100;
});

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}

function formatLargeNumber(num: number): string {
  if (num >= 1000000000) {
    return (num / 1000000000).toFixed(2) + 'B';
  }
  if (num >= 1000000) {
    return (num / 1000000).toFixed(2) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(2) + 'K';
  }
  return num.toString();
}

function formatPercentage(num: number): string {
  if (num === 0) return '0';
  if (num === 100) return '100';
  if (num < 0.01) return '0.00';
  if (num < 1) return num.toFixed(2);
  if (num < 10) return num.toFixed(1);
  return num.toFixed(0);
}

function formatResponseTime(time: number): string {
  if (time >= 1000) {
    return (time / 1000).toFixed(2);
  }
  if (time < 1) {
    return time.toFixed(3);
  }
  if (time < 10) {
    return time.toFixed(2);
  }
  return time.toFixed(1);
}

function formatTimestamp(timestamp: number) {
  const date = new Date(timestamp);
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
    day: '2-digit',
  });

  if (selectedPeriod.value === '24h') {
    return formatter.format(date).split(' ')[1] || date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return formatter.format(date).split(' ')[0] || date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function getPercentage(count: number) {
  if (trendData.value.length === 0) return 0;
  const max = Math.max(...trendData.value.map(d => d.requestCount));
  if (max === 0) return 0;
  return (count / max) * 100;
}

async function loadData() {
  await Promise.all([
    providerStore.fetchProviders(),
    virtualKeyStore.fetchVirtualKeys(),
    loadStats(),
  ]);
}

async function loadStats() {
  try {
    const result = await configApi.getStats(selectedPeriod.value);
    stats.value = result.stats;
    trendData.value = result.trend;
  } catch (error: any) {
    message.error(error.message);
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

.stat-card-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.stat-label {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.85);
  font-weight: 500;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.stat-card-primary .stat-label {
  color: rgba(255, 255, 255, 0.9);
}

.stat-value-large {
  font-size: 42px;
  font-weight: 600;
  color: #ffffff;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.stat-trend {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.stat-trend-text {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.8);
  font-weight: 400;
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

.trend-card {
  background: #ffffff;
  border-radius: 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.trend-card :deep(.n-card__header) {
  padding: 24px 28px;
  border-bottom: 1px solid #f0f0f0;
}

.trend-card :deep(.n-card-header__main) {
  font-size: 18px;
  font-weight: 600;
  color: #1a1a1a;
  letter-spacing: -0.02em;
}

.trend-content {
  padding: 8px 0;
  min-height: 300px;
}

.trend-scroll-container {
  max-height: 400px;
  overflow-y: auto;
  padding-right: 8px;
}

.trend-scroll-container::-webkit-scrollbar {
  width: 6px;
}

.trend-scroll-container::-webkit-scrollbar-track {
  background: #f5f5f5;
  border-radius: 3px;
}

.trend-scroll-container::-webkit-scrollbar-thumb {
  background: #d9d9d9;
  border-radius: 3px;
}

.trend-scroll-container::-webkit-scrollbar-thumb:hover {
  background: #bfbfbf;
}

.trend-item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 4px 0;
}

.trend-time {
  width: 80px;
  font-size: 13px;
  color: #595959;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.trend-progress {
  flex: 1;
  min-width: 0;
}

.trend-count {
  width: 80px;
  font-size: 13px;
  color: #262626;
  font-weight: 400;
  text-align: right;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.trend-tokens {
  width: 100px;
  font-size: 13px;
  color: #8c8c8c;
  text-align: right;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
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
  font-size: 20px;
  font-weight: 500;
  color: #1a1a1a;
  font-variant-numeric: tabular-nums;
}
</style>


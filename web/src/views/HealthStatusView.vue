<template>
  <div class="health-status-view">
    <n-card title="系统健康监控">
      <template #header-extra>
        <n-space>
          <n-tag :type="autoRefresh ? 'success' : 'default'">
            {{ autoRefresh ? '自动刷新' : '手动刷新' }}
          </n-tag>
          <n-button size="small" @click="toggleAutoRefresh">
            {{ autoRefresh ? '停止' : '启动' }}
          </n-button>
          <n-button size="small" @click="refresh" :loading="loading">
            刷新
          </n-button>
        </n-space>
      </template>

      <!-- 全局概览 -->
      <n-spin :show="loading && !globalSummary">
        <div v-if="globalSummary" class="global-summary">
          <n-grid cols="2 s:3 m:4 l:5" responsive="screen" :x-gap="12" :y-gap="12">
            <n-grid-item>
              <n-statistic label="总目标数" :value="globalSummary.totalTargets" />
            </n-grid-item>
            <n-grid-item>
              <n-statistic label="健康目标" :value="globalSummary.healthyTargets">
                <template #suffix>
                  <n-icon color="#18a058" :component="CheckmarkCircle" />
                </template>
              </n-statistic>
            </n-grid-item>
            <n-grid-item>
              <n-statistic label="降级目标" :value="globalSummary.degradedTargets">
                <template #suffix>
                  <n-icon color="#f0a020" :component="WarningOutline" />
                </template>
              </n-statistic>
            </n-grid-item>
            <n-grid-item>
              <n-statistic label="宕机目标" :value="globalSummary.downTargets">
                <template #suffix>
                  <n-icon color="#d03050" :component="CloseCircle" />
                </template>
              </n-statistic>
            </n-grid-item>
            <n-grid-item>
              <n-statistic
                label="24h 总可用率"
                :value="globalSummary.overall24hAvailability.toFixed(2)"
                suffix="%"
              />
            </n-grid-item>
          </n-grid>
        </div>
      </n-spin>

      <n-divider />

      <!-- 筛选区 -->
      <n-space class="filters" :size="12">
        <n-input
          v-model:value="searchKeyword"
          placeholder="搜索目标..."
          clearable
          style="width: 200px"
        >
          <template #prefix>
            <n-icon :component="SearchOutline" />
          </template>
        </n-input>
        <n-select
          v-model:value="statusFilter"
          placeholder="状态筛选"
          :options="statusOptions"
          clearable
          style="width: 150px"
        />
      </n-space>

      <n-divider />

      <!-- 目标列表 -->
      <n-spin :show="loading">
        <div v-if="filteredTargets.length === 0" class="empty-state">
          <n-empty description="暂无监控目标" />
        </div>
        <n-list v-else bordered>
          <n-list-item v-for="target in filteredTargets" :key="target.targetId">
            <template #prefix>
              <n-icon
                size="24"
                :color="getStatusColor(target.currentStatus)"
                :component="getStatusIcon(target.currentStatus)"
              />
            </template>

            <n-thing :title="target.targetName">
              <template #description>
                <n-space :size="8">
                  <n-tag size="small" :type="target.targetType === 'virtual_model' ? 'info' : 'default'">
                    {{ target.targetType === 'virtual_model' ? '虚拟模型' : '模型' }}
                  </n-tag>
                  <n-tag size="small" :type="getStatusTagType(target.currentStatus)">
                    {{ getStatusText(target.currentStatus) }}
                  </n-tag>
                </n-space>
              </template>

              <template #default>
                <div class="compact-stats">
                  <div class="stat-item-compact">
                    <span class="stat-label-compact">1h</span>
                    <span class="stat-value-compact">{{ target.stats1h.availability.toFixed(1) }}%</span>
                  </div>
                  <div class="stat-item-compact">
                    <span class="stat-label-compact">24h</span>
                    <span class="stat-value-compact">{{ target.stats24h.availability.toFixed(1) }}%</span>
                  </div>
                  <div class="stat-item-compact">
                    <span class="stat-label-compact">P50</span>
                    <span class="stat-value-compact">{{ target.stats24h.p50Latency }}ms</span>
                  </div>
                  <div class="stat-item-compact">
                    <span class="stat-label-compact">P95</span>
                    <span class="stat-value-compact">{{ target.stats24h.p95Latency }}ms</span>
                  </div>
                </div>

                <!-- Visual health history timeline -->
                <div v-if="target.healthHistory && target.healthHistory.length > 0" class="health-timeline">
                  <HealthTimeline
                    :history="target.healthHistory"
                    @check-click="handleCheckClick"
                  />
                </div>
              </template>
            </n-thing>

          </n-list-item>
        </n-list>
      </n-spin>
    </n-card>

    <!-- 色块点击详情弹窗 -->
    <HealthCheckDetailModal
      v-model:show="showCheckDetail"
      :check="selectedCheck"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import {
  NCard,
  NSpin,
  NGrid,
  NGridItem,
  NStatistic,
  NDivider,
  NSpace,
  NTag,
  NButton,
  NInput,
  NSelect,
  NList,
  NListItem,
  NThing,
  NEmpty,
  NIcon,
  NText,
  useMessage,
} from 'naive-ui';
import {
  CheckmarkCircle,
  CloseCircle,
  WarningOutline,
  SearchOutline,
  HelpCircleOutline,
} from '@vicons/ionicons5';
import request from '@/utils/request';
import HealthTimeline from '@/components/HealthTimeline.vue';
import HealthCheckDetailModal from '@/components/HealthCheckDetailModal.vue';

interface GlobalSummary {
  totalTargets: number;
  activeTargets: number;
  healthyTargets: number;
  degradedTargets: number;
  downTargets: number;
  overall24hAvailability: number;
  overall24hAvgLatency: number;
}

interface TargetSummary {
  targetId: string;
  targetName: string;
  targetType: 'model' | 'virtual_model';
  currentStatus: 'ok' | 'degraded' | 'down' | 'unknown';
  latestCheck?: {
    status: 'success' | 'error';
    timestamp: number;
    latencyMs: number;
    errorMessage?: string;
  };
  healthHistory?: Array<{
    status: 'success' | 'error';
    timestamp: number;
    latencyMs: number;
    errorMessage?: string;
  }>;
  stats1h: {
    totalChecks: number;
    successCount: number;
    errorCount: number;
    availability: number;
    avgLatency: number;
    p50Latency: number;
    p95Latency: number;
  };
  stats24h: {
    totalChecks: number;
    successCount: number;
    errorCount: number;
    availability: number;
    avgLatency: number;
    p50Latency: number;
    p95Latency: number;
  };
}

const message = useMessage();
const loading = ref(false);
const globalSummary = ref<GlobalSummary | null>(null);
const targets = ref<TargetSummary[]>([]);
const searchKeyword = ref('');
const statusFilter = ref<string | null>(null);
const autoRefresh = ref(true);
const refreshTimer = ref<number | null>(null);

const showCheckDetail = ref(false);
const selectedCheck = ref<{
  status: 'success' | 'error';
  timestamp: number;
  latencyMs: number;
  errorMessage?: string;
} | null>(null);

const statusOptions = [
  { label: '健康', value: 'ok' },
  { label: '降级', value: 'degraded' },
  { label: '宕机', value: 'down' },
  { label: '未知', value: 'unknown' },
];

const filteredTargets = computed(() => {
  let result = targets.value || [];

  if (searchKeyword.value) {
    const keyword = searchKeyword.value.toLowerCase();
    result = result.filter(t => t.targetName.toLowerCase().includes(keyword));
  }

  if (statusFilter.value) {
    result = result.filter(t => t.currentStatus === statusFilter.value);
  }

  return result;
});

function getStatusColor(status: string) {
  switch (status) {
    case 'ok':
      return '#18a058';
    case 'degraded':
      return '#f0a020';
    case 'down':
      return '#d03050';
    default:
      return '#999';
  }
}

function getStatusIcon(status: string) {
  switch (status) {
    case 'ok':
      return CheckmarkCircle;
    case 'degraded':
      return WarningOutline;
    case 'down':
      return CloseCircle;
    default:
      return HelpCircleOutline;
  }
}

function getStatusTagType(status: string): any {
  switch (status) {
    case 'ok':
      return 'success';
    case 'degraded':
      return 'warning';
    case 'down':
      return 'error';
    default:
      return 'default';
  }
}

function getStatusText(status: string) {
  switch (status) {
    case 'ok':
      return '健康';
    case 'degraded':
      return '降级';
    case 'down':
      return '宕机';
    default:
      return '未知';
  }
}


async function refresh() {
  loading.value = true;
  try {
    const { global, targets: targetSummaries } = await request.get('/public/health/summary');
    globalSummary.value = global;
    targets.value = targetSummaries;
  } catch (error: any) {
    message.error('加载失败: ' + (error.response?.data?.error?.message || error.message));
  } finally {
    loading.value = false;
  }
}

function handleCheckClick(check: { status: 'success' | 'error'; timestamp: number; latencyMs: number; errorMessage?: string }) {
  selectedCheck.value = check;
  showCheckDetail.value = true;
}

function toggleAutoRefresh() {
  autoRefresh.value = !autoRefresh.value;

  if (autoRefresh.value) {
    startAutoRefresh();
  } else {
    stopAutoRefresh();
  }
}

function startAutoRefresh() {
  if (refreshTimer.value) return;

  refreshTimer.value = window.setInterval(() => {
    refresh();
  }, 60000); // 每60秒刷新一次
}

function stopAutoRefresh() {
  if (refreshTimer.value) {
    clearInterval(refreshTimer.value);
    refreshTimer.value = null;
  }
}

onMounted(() => {
  refresh();
  if (autoRefresh.value) {
    startAutoRefresh();
  }
});

onUnmounted(() => {
  stopAutoRefresh();
});
</script>

<style scoped>
.health-status-view {
  padding: 24px;
  max-width: 1400px;
  margin: 0 auto;
}

.global-summary {
  margin-bottom: 16px;
}

.filters {
  margin-bottom: 16px;
}

.compact-stats {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.stat-item-compact {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.stat-label-compact {
  font-size: 11px;
  color: #999;
  font-weight: 500;
}

.stat-value-compact {
  font-size: 13px;
  font-weight: 500;
  color: #333;
}

.health-timeline {
  margin-top: 8px;
}

.empty-state {
  padding: 40px 0;
  text-align: center;
}
</style>

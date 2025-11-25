<template>
  <div class="health-status-view">
    <n-card title="系统健康监控" class="header-card">
      <template #header-extra>
        <n-space>
          <n-tag :type="autoRefresh ? 'success' : 'default'" size="small">
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
        <div v-else class="target-grid">
          <n-card
            v-for="target in filteredTargets"
            :key="target.targetId"
            class="target-card"
            size="small"
          >
            <div class="card-content">
              <div class="card-left">
                <div class="target-header">
                  <div class="target-title-row">
                    <span class="target-title">{{ target.displayTitle || target.targetName }}</span>
                  </div>
                  <n-space :size="6" style="margin-top: 4px">
                    <n-tag size="tiny" :type="target.targetType === 'virtual_model' ? 'info' : 'default'">
                      {{ target.targetType === 'virtual_model' ? '虚拟模型' : '模型' }}
                    </n-tag>
                    <n-tag size="tiny" :type="getStatusTagType(target.currentStatus)">
                      {{ getStatusText(target.currentStatus) }}
                    </n-tag>
                    <span class="check-interval">每 {{ target.checkIntervalSeconds }}s</span>
                  </n-space>
                </div>

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
                    :history="target.healthHistory.slice().reverse()"
                    @check-click="handleCheckClick"
                  />
                </div>
              </div>

              <div class="card-right">
                <div
                  class="status-gradient"
                  :class="`status-${target.currentStatus}`"
                ></div>
              </div>
            </div>
          </n-card>
        </div>
      </n-spin>
    </n-card>

    <!-- 色块点击详情弹窗 -->
    <HealthCheckDetailModal
      v-model:show="showCheckDetail"
      :check="selectedCheck"
    />

    <!-- 编辑目标弹窗 -->
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
  NEmpty,
  NIcon,
  useMessage,
} from 'naive-ui';
import {
  CheckmarkCircle,
  CloseCircle,
  WarningOutline,
  SearchOutline,
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
  displayTitle?: string;
  targetType: 'model' | 'virtual_model';
  checkIntervalSeconds: number;
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

.header-card {
  margin-bottom: 20px;
}

.global-summary {
  margin-bottom: 16px;
}

.filters {
  margin-bottom: 16px;
}

.target-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(450px, 1fr));
  gap: 16px;
}

.target-card {
  transition: all 0.2s ease;
  border-radius: 8px;
}

.target-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  transform: translateY(-2px);
}

.card-content {
  display: flex;
  gap: 12px;
}

.card-left {
  flex: 1;
  min-width: 0;
}

.card-right {
  width: 8px;
  display: flex;
  align-items: stretch;
}

.status-gradient {
  width: 100%;
  border-radius: 4px;
  background: linear-gradient(to bottom, var(--status-color-top), var(--status-color-bottom));
  box-shadow: 0 0 8px var(--status-color-glow);
}

.status-gradient.status-ok {
  --status-color-top: #52c41a;
  --status-color-bottom: #237804;
  --status-color-glow: rgba(82, 196, 26, 0.3);
}

.status-gradient.status-degraded {
  --status-color-top: #faad14;
  --status-color-bottom: #d48806;
  --status-color-glow: rgba(250, 173, 20, 0.3);
}

.status-gradient.status-down {
  --status-color-top: #ff4d4f;
  --status-color-bottom: #a8071a;
  --status-color-glow: rgba(255, 77, 79, 0.3);
}

.status-gradient.status-unknown {
  --status-color-top: #d9d9d9;
  --status-color-bottom: #8c8c8c;
  --status-color-glow: rgba(217, 217, 217, 0.3);
}

.target-header {
  margin-bottom: 12px;
}

.target-title-row {
  display: flex;
  align-items: center;
}

.target-title {
  font-size: 15px;
  font-weight: 600;
  color: #262626;
}

.check-interval {
  font-size: 11px;
  color: #8c8c8c;
}

.compact-stats {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 10px;
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
  font-weight: 600;
  color: #262626;
}

.health-timeline {
  margin-top: 10px;
}

.empty-state {
  padding: 40px 0;
  text-align: center;
}

@media (max-width: 768px) {
  .target-grid {
    grid-template-columns: 1fr;
  }
}
</style>

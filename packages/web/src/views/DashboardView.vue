<template>
  <div class="dashboard-view">
    <n-space vertical :size="24">
      <PageHeader
        eyebrow="OVERVIEW"
        :title="t('dashboard.title')"
        :subtitle="t('dashboard.subtitle')"
      >
        <template #actions>
          <n-space :size="12" class="dashboard-controls">
            <n-button secondary round @click="refreshDashboard">
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
              @update:value="() => loadStats()"
            />
          </n-space>
        </template>
      </PageHeader>

      <n-alert v-if="stats?.legacyTokenSemantics || (isTokenCardFlipped && statsAllTime?.legacyTokenSemantics)" type="warning" :show-icon="true">
        历史汇总中存在旧版缓存命中 Token 口径；相关统计可能偏高，已清理的明细无法精确回算。
      </n-alert>

      <n-grid :cols="gridCols" :x-gap="gridGap" :y-gap="gridGap">
        <n-gi class="stagger-item" style="--delay: 0ms">
          <div class="switchable-card" @click="toggleTokenCard">
            <n-card v-if="!isTokenCardFlipped" class="stat-card stat-card-primary">
              <div class="stat-content">
                <div class="stat-header">
                  {{ t('dashboard.tokenConsumption') }}
                  <n-icon size="14" class="flip-icon"><RefreshOutline /></n-icon>
                </div>
                <div class="stat-main-value">
                  <n-skeleton v-if="loading" text style="width: 60%; height: 42px" :sharp="false" />
                  <span v-else>{{ formatTokenNumber(stats?.totalTokens || 0) }}</span>
                </div>
                <div class="stat-details">
                  <span class="stat-detail-item">
                    <span class="stat-detail-label">输入:</span>
                    <span class="stat-detail-value">
                      <n-skeleton v-if="loading" text style="width: 40px" />
                      <span v-else>{{ formatTokenNumber(promptTokens) }}</span>
                    </span>
                  </span>
                  <span class="stat-detail-item">
                    <span class="stat-detail-label">输出:</span>
                    <span class="stat-detail-value">
                      <n-skeleton v-if="loading" text style="width: 40px" />
                      <span v-else>{{ formatTokenNumber(completionTokens) }}</span>
                    </span>
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
                <div class="stat-main-value">
                  {{ formatTokenNumber(statsAllTime?.totalTokens || 0) }}
                </div>
                <div class="stat-details">
                  <span class="stat-detail-item">
                    <span class="stat-detail-label">输入:</span>
                    <span class="stat-detail-value">
                      {{ formatTokenNumber(statsAllTime?.promptTokens || 0) }}
                    </span>
                  </span>
                  <span class="stat-detail-item">
                    <span class="stat-detail-label">输出:</span>
                    <span class="stat-detail-value">
                      {{ formatTokenNumber(statsAllTime?.completionTokens || 0) }}
                    </span>
                  </span>
                </div>
              </div>
            </n-card>
          </div>
        </n-gi>
        <n-gi class="stagger-item" style="--delay: 50ms">
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">{{ t('dashboard.totalRequests') }}</div>
              <div class="stat-main-value">
                <n-skeleton v-if="loading" text style="width: 50%; height: 42px" :sharp="false" />
                <span v-else>{{ formatNumber(stats?.totalRequests || 0) }}</span>
              </div>
              <div class="stat-details">
                <span class="stat-detail-item stat-detail-success">
                  <span class="stat-detail-label">成功:</span>
                  <span class="stat-detail-value">
                    <n-skeleton v-if="loading" text style="width: 30px" />
                    <span v-else>{{ formatNumber(stats?.successfulRequests || 0) }}</span>
                  </span>
                </span>
                <span class="stat-detail-item stat-detail-error">
                  <span class="stat-detail-label">失败:</span>
                  <span class="stat-detail-value">
                    <n-skeleton v-if="loading" text style="width: 30px" />
                    <span v-else>{{ formatNumber(stats?.failedRequests || 0) }}</span>
                  </span>
                </span>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi class="stagger-item" style="--delay: 100ms">
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">{{ t('dashboard.successRate') }}</div>
              <div class="stat-main-value">
                <n-skeleton v-if="loading" text style="width: 50%; height: 42px" :sharp="false" />
                <span v-else>
                  {{ formatPercentage(successRate) }}
                  <span class="stat-unit">%</span>
                </span>
              </div>
              <div class="stat-progress">
                <div
                  class="stat-progress-bar"
                  :style="{ width: (loading ? 0 : successRate) + '%' }"
                ></div>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi class="stagger-item" style="--delay: 150ms">
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">{{ t('dashboard.avgResponseTime') }}</div>
              <div class="stat-main-value">
                <n-skeleton v-if="loading" text style="width: 50%; height: 42px" :sharp="false" />
                <span v-else>
                  {{
                    avgResponseTime >= 1000
                      ? (avgResponseTime / 1000).toFixed(2)
                      : formatResponseTime(avgResponseTime)
                  }}
                  <span class="stat-unit">{{ avgResponseTime >= 1000 ? 's' : 'ms' }}</span>
                </span>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi class="stagger-item" style="--delay: 200ms">
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">缓存 Tokens</div>
              <div class="stat-main-value">
                <n-skeleton v-if="loading" text style="width: 60%; height: 42px" :sharp="false" />
                <span v-else>{{ formatTokenNumber(stats?.cachedTokens || 0) }}</span>
              </div>
              <div class="stat-details">
                <span class="stat-detail-item">
                  <span class="stat-detail-label">缓存命中:</span>
                  <span class="stat-detail-value">
                    <n-skeleton v-if="loading" text style="width: 40px" />
                    <span v-else>{{ formatNumber(stats?.promptCacheHits || 0) }}</span>
                  </span>
                </span>
                <span class="stat-detail-item">
                  <span class="stat-detail-label">命中率:</span>
                  <span class="stat-detail-value">
                    <n-skeleton v-if="loading" text style="width: 30px" />
                    <span v-else>{{ formatPercentage(cacheHitRate) }}%</span>
                  </span>
                </span>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi class="stagger-item" style="--delay: 250ms">
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">平均效率</div>
              <div class="stat-main-value">
                <n-skeleton v-if="loading" text style="width: 50%; height: 42px" :sharp="false" />
                <span v-else>
                  {{ formatNumber(avgTokensPerRequest) }}
                  <span class="stat-unit">Tk/Req</span>
                </span>
              </div>
              <div class="stat-details">
                <span class="stat-detail-item">
                  <span class="stat-detail-label">输入:</span>
                  <span class="stat-detail-value">
                    <n-skeleton v-if="loading" text style="width: 30px" />
                    <span v-else>{{ formatNumber(avgInputTokens) }}</span>
                  </span>
                </span>
                <span class="stat-detail-item">
                  <span class="stat-detail-label">输出:</span>
                  <span class="stat-detail-value">
                    <n-skeleton v-if="loading" text style="width: 30px" />
                    <span v-else>{{ formatNumber(avgOutputTokens) }}</span>
                  </span>
                </span>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi class="stagger-item" style="--delay: 300ms">
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">意图分类速度</div>
              <div class="stat-main-value">
                <n-skeleton v-if="loading" text style="width: 50%; height: 42px" :sharp="false" />
                <span v-else>
                  {{
                    intentClassifySpeed >= 1000
                      ? (intentClassifySpeed / 1000).toFixed(2)
                      : formatResponseTime(intentClassifySpeed)
                  }}
                  <span class="stat-unit">{{ intentClassifySpeed >= 1000 ? 's' : 'ms' }}</span>
                </span>
              </div>
              <div class="stat-details">
                <span class="stat-detail-item">
                  <span class="stat-detail-label">分类次数:</span>
                  <span class="stat-detail-value">
                    <n-skeleton v-if="loading" text style="width: 40px" />
                    <span v-else>{{ formatNumber(intentClassifyCount) }}</span>
                  </span>
                </span>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi class="stagger-item" style="--delay: 350ms">
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">热门模型</div>
              <div class="stat-main-value top-model-name">
                <n-skeleton v-if="loading" text style="width: 70%; height: 24px" :sharp="false" />
                <span v-else>{{ topModel }}</span>
              </div>
              <div class="stat-provider">
                <n-skeleton v-if="loading" text style="width: 40%" />
                <span v-else>{{ topModelProvider }}</span>
              </div>
              <div class="stat-details">
                <span class="stat-detail-item">
                  <span class="stat-detail-label">请求:</span>
                  <span class="stat-detail-value">
                    <n-skeleton v-if="loading" text style="width: 30px" />
                    <span v-else>{{ formatNumber(topModelRequests) }}</span>
                  </span>
                </span>
                <span class="stat-detail-item">
                  <span class="stat-detail-label">Token:</span>
                  <span class="stat-detail-value">
                    <n-skeleton v-if="loading" text style="width: 40px" />
                    <span v-else>{{ formatTokenNumber(topModelTokens) }}</span>
                  </span>
                </span>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi class="stagger-item" style="--delay: 400ms">
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">PII 保护次数</div>
              <div class="stat-main-value">
                <n-skeleton v-if="loading" text style="width: 40%; height: 42px" :sharp="false" />
                <span v-else>
                  {{ formatNumber(piiProtectionCount) }}
                </span>
              </div>
              <div class="stat-details">
                <span class="stat-detail-item">
                  <span class="stat-detail-label">安全拦截次数:</span>
                  <span class="stat-detail-value">
                    <n-skeleton v-if="loading" text style="width: 40px" />
                    <span v-else>{{ formatNumber(ipsumBlockedCount) }}</span>
                  </span>
                </span>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi class="stagger-item" style="--delay: 450ms">
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">成本分析</div>
              <div class="stat-main-value">
                <n-skeleton v-if="loading" text style="width: 60%; height: 42px" :sharp="false" />
                <span v-else>
                  {{ formatCost(costStats?.totalCost || 0) }}
                  <span class="stat-unit">USD</span>
                </span>
              </div>
              <div class="stat-details">
                <span class="stat-detail-item">
                  <span class="stat-detail-label">计费模型:</span>
                  <span class="stat-detail-value">
                    <n-skeleton v-if="loading" text style="width: 30px" />
                    <span v-else>{{ costStats?.modelCosts?.length || 0 }} 个</span>
                  </span>
                </span>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi class="stagger-item" style="--delay: 500ms">
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">数据库状态</div>
              <div class="stat-main-value">
                <n-skeleton v-if="loading" text style="width: 50%; height: 42px" :sharp="false" />
                <span v-else>
                  {{ stats?.dbSize || 0 }}
                  <span class="stat-unit">MB</span>
                </span>
              </div>
              <div class="stat-details">
                <span class="stat-detail-item">
                  <span class="stat-detail-label">状态:</span>
                  <span class="stat-detail-value" style="color: var(--color-primary)">正常</span>
                </span>
                <span class="stat-detail-item">
                  <span class="stat-detail-label">运行时长:</span>
                  <span class="stat-detail-value">
                    <n-skeleton v-if="loading" text style="width: 60px" />
                    <span v-else>{{ formatUptime(stats?.dbUptime || 0) }}</span>
                  </span>
                </span>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi class="stagger-item" style="--delay: 550ms">
          <n-card class="stat-card">
            <div class="stat-content">
              <div class="stat-header">熔断器触发次数</div>
              <div
                class="stat-main-value"
                :class="{ 'stat-value-error': (circuitBreakerStats?.totalTriggers || 0) > 0 }"
              >
                <n-skeleton v-if="loading" text style="width: 40%; height: 42px" :sharp="false" />
                <span v-else>{{ formatNumber(circuitBreakerStats?.totalTriggers || 0) }}</span>
              </div>
              <div class="stat-details">
                <span class="stat-detail-item">
                  <span class="stat-detail-label">触发最多:</span>
                  <span
                    class="stat-detail-value"
                    :title="circuitBreakerStats?.maxTriggeredProvider"
                  >
                    <n-skeleton v-if="loading" text style="width: 60px" />
                    <span v-else>
                      {{ formatProviderName(circuitBreakerStats?.maxTriggeredProvider) }}
                    </span>
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
                  <n-button @click="() => loadStats()">重新加载</n-button>
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
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import {
  useMessage,
  NSpace,
  NGrid,
  NGi,
  NCard,
  NSelect,
  NEmpty,
  NButton,
  NIcon,
  NSpin,
  NResult,
  NSkeleton
} from 'naive-ui'
import { RefreshOutline } from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'
import { useProviderStore } from '@/stores/provider'
import { useVirtualKeyStore } from '@/stores/virtual-key'
import {
  configApi,
  type ApiStats,
  type VirtualKeyTrend,
  type IntentClassifyStats,
  type ModelStat,
  type CostStats,
  type ThreatIpStats
} from '@/api/config'
import {
  formatNumber,
  formatTokenNumber,
  formatPercentage,
  formatResponseTime,
  formatTimestamp,
  formatUptime
} from '@/utils/format'
import { useDebouncedWindowSize } from '@/composables/useDebouncedWindowSize'
import VChart from 'vue-echarts'
import PageHeader from '@/components/PageHeader.vue'

const { t } = useI18n()
const message = useMessage()
const providerStore = useProviderStore()
const virtualKeyStore = useVirtualKeyStore()
const stats = ref<ApiStats | null>(null)
const statsAllTime = ref<ApiStats | null>(null)
const isTokenCardFlipped = ref(false)
const trendData = ref<VirtualKeyTrend[]>([])
const intentClassifyStats = ref<IntentClassifyStats | null>(null)
const modelStats = ref<ModelStat[]>([])
const circuitBreakerStats = ref<{
  totalTriggers: number
  maxTriggeredProvider: string
  maxTriggerCount: number
} | null>(null)
const costStats = ref<CostStats | null>(null)
const threatIpStats = ref<ThreatIpStats | null>(null)
const piiProtectionCount = ref<number>(0)
const selectedPeriod = ref<'24h' | '7d' | '30d'>('24h')
const chartMetric = ref<'requests' | 'tokens'>('requests')
const loading = ref(false)
const loadError = ref<string | null>(null)
const { windowWidth } = useDebouncedWindowSize()

async function toggleTokenCard() {
  isTokenCardFlipped.value = !isTokenCardFlipped.value
  if (isTokenCardFlipped.value && !statsAllTime.value) {
    try {
      const result = await configApi.getStatsSummary('all')
      if (result && result.stats) {
        statsAllTime.value = result.stats
      }
    } catch (e) {
      console.error('Failed to load all-time stats', e)
      message.error('加载历史总消耗失败')
    }
  }
}

const periodOptions = computed(() => [
  { label: t('dashboard.period.last24Hours'), value: '24h' },
  { label: t('dashboard.period.last7Days'), value: '7d' },
  { label: t('dashboard.period.last30Days'), value: '30d' }
])

const gridCols = computed(() => {
  if (windowWidth.value < 640) return 1 // 手机端：1列
  if (windowWidth.value < 1024) return 2 // 平板端：2列
  if (windowWidth.value < 1280) return 3 // 小桌面：3列
  return 4 // 大桌面：4列
})

const gridGap = computed(() => {
  if (windowWidth.value < 640) return 12 // 手机端：较小间距
  return 20 // 桌面端：正常间距
})

const enabledKeysCount = computed(() => {
  return virtualKeyStore.virtualKeys.filter(k => k.enabled).length
})

const successRate = computed(() => {
  if (!stats.value) return 0
  const total = Number(stats.value.totalRequests || 0)
  if (total === 0) return 0
  return (Number(stats.value.successfulRequests || 0) / total) * 100
})

const avgResponseTime = computed(() => {
  return Number(stats.value?.avgResponseTime || 0)
})

const avgTokensPerRequest = computed(() => {
  const reqs = Number(stats.value?.totalRequests || 0)
  if (reqs === 0) return 0
  return Math.round(Number(stats.value?.totalTokens || 0) / reqs)
})

const avgInputTokens = computed(() => {
  const reqs = Number(stats.value?.totalRequests || 0)
  if (reqs === 0) return 0
  return Math.round(Number(stats.value?.promptTokens || 0) / reqs)
})

const avgOutputTokens = computed(() => {
  const reqs = Number(stats.value?.totalRequests || 0)
  if (reqs === 0) return 0
  return Math.round(Number(stats.value?.completionTokens || 0) / reqs)
})

const intentClassifySpeed = computed(() => {
  return Number(intentClassifyStats.value?.avgClassificationTime || 0)
})

const intentClassifyCount = computed(() => {
  return Number(intentClassifyStats.value?.totalRequests || 0)
})

const topModel = computed(() => {
  if (modelStats.value.length === 0 || !modelStats.value[0].model) return '-'
  return modelStats.value[0].model
})

const topModelProvider = computed(() => {
  if (modelStats.value.length === 0 || !modelStats.value[0].provider_name) return '-'
  return modelStats.value[0].provider_name
})

const topModelRequests = computed(() => {
  if (modelStats.value.length === 0) return 0
  return Number(modelStats.value[0].request_count || 0)
})

const topModelTokens = computed(() => {
  if (modelStats.value.length === 0) return 0
  return Number(modelStats.value[0].total_tokens || 0)
})

const cacheHitRate = computed(() => {
  if (!stats.value) return 0
  const cached = Number(stats.value.cachedTokens || 0)
  const prompt = Number(stats.value.promptTokens || 0)
  const denom = cached + prompt
  return denom === 0 ? 0 : (cached / denom) * 100
})

const promptTokens = computed(() => {
  if (!stats.value) return 0
  return Number(stats.value.promptTokens || 0)
})

const completionTokens = computed(() => {
  if (!stats.value) return 0
  return Number(stats.value.completionTokens || 0)
})

const ipsumBlockedCount = computed(() => {
  if (!threatIpStats.value) return 0
  return Number(threatIpStats.value.blockedCount || 0)
})

// Starbucks & Nature Inspired Palette
const COLOR_PALETTE = [
  { line: '#006241', gradient: ['rgba(0, 98, 65, 0.4)', 'rgba(0, 98, 65, 0.05)'] }, // Starbucks Green
  { line: '#C4996C', gradient: ['rgba(196, 153, 108, 0.4)', 'rgba(196, 153, 108, 0.05)'] }, // Coffee/Gold
  { line: '#1E3932', gradient: ['rgba(30, 57, 50, 0.4)', 'rgba(30, 57, 50, 0.05)'] }, // House Green
  { line: '#2D8A6D', gradient: ['rgba(45, 138, 109, 0.4)', 'rgba(45, 138, 109, 0.05)'] }, // Medium Green
  { line: '#A89F91', gradient: ['rgba(168, 159, 145, 0.4)', 'rgba(168, 159, 145, 0.05)'] }, // Warm Gray
  { line: '#6CA68D', gradient: ['rgba(108, 166, 141, 0.4)', 'rgba(108, 166, 141, 0.05)'] }, // Sage
  { line: '#4A4A4A', gradient: ['rgba(74, 74, 74, 0.4)', 'rgba(74, 74, 74, 0.05)'] }, // Dark Gray
  { line: '#D4E9E2', gradient: ['rgba(212, 233, 226, 0.4)', 'rgba(212, 233, 226, 0.05)'] } // Mint
]

const chartOption = computed(() => {
  if (!trendData.value || trendData.value.length === 0) {
    return {}
  }

  const firstKeyData = trendData.value[0]?.data
  if (!firstKeyData || firstKeyData.length === 0) {
    return {}
  }

  const timePoints = firstKeyData.map(d => d.timestamp).filter(t => t && !isNaN(t))

  if (timePoints.length === 0) {
    return {}
  }

  const isMobile = windowWidth.value < 640

  const series = trendData.value.map((keyTrend, index) => {
    const colorScheme = COLOR_PALETTE[index % COLOR_PALETTE.length]

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
        shadowOffsetY: 2
      },
      itemStyle: {
        borderWidth: 2,
        borderColor: '#ffffff'
      },
      emphasis: {
        focus: 'series',
        scale: true,
        itemStyle: {
          borderWidth: 3,
          shadowBlur: 10,
          shadowColor: colorScheme.line
        }
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
          ]
        }
      },
      data: keyTrend.data.map(d =>
        chartMetric.value === 'requests' ? d.requestCount : d.tokenCount
      ),
      color: colorScheme.line
    }
  })

  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(255, 255, 255, 0.95)',
      borderColor: '#e5e7eb',
      borderWidth: 1,
      extraCssText: 'backdrop-filter: blur(8px);',
      textStyle: {
        color: '#1f2937',
        fontSize: isMobile ? 11 : 13
      },
      padding: isMobile ? [8, 12] : [12, 16],
      axisPointer: {
        type: 'line',
        lineStyle: {
          color: '#d1d5db',
          width: 1,
          type: 'solid'
        },
        crossStyle: {
          color: '#d1d5db',
          width: 1,
          type: 'dashed'
        }
      },
      formatter: (params: any) => {
        if (!params || params.length === 0) return ''
        const dataIndex = params[0].dataIndex
        if (dataIndex === undefined || dataIndex >= timePoints.length) return ''
        const timestamp = timePoints[dataIndex]
        if (!timestamp || isNaN(timestamp)) return ''
        const headerFontSize = isMobile ? 12 : 14
        const itemFontSize = isMobile ? 11 : 13
        const marginBottom = isMobile ? 6 : 10
        const itemMargin = isMobile ? 4 : 6
        let result = `<div style="font-weight: 600; margin-bottom: ${marginBottom}px; color: #111827; font-size: ${headerFontSize}px;">${formatTimestamp(timestamp, selectedPeriod.value)}</div>`
        params.forEach((param: any) => {
          const value =
            chartMetric.value === 'requests'
              ? `${formatNumber(param.value)} 次`
              : `${formatTokenNumber(param.value)} tokens`
          result += `<div style="display: flex; align-items: center; margin: ${itemMargin}px 0;">
            <span style="display: inline-block; width: ${isMobile ? 10 : 12}px; height: ${isMobile ? 10 : 12}px; border-radius: 3px; background-color: ${param.color}; margin-right: ${isMobile ? 8 : 10}px;"></span>
            <span style="flex: 1; color: #4b5563; font-size: ${itemFontSize}px;">${param.seriesName}</span>
            <span style="font-weight: 600; margin-left: ${isMobile ? 12 : 16}px; color: #111827; font-size: ${itemFontSize}px;">${value}</span>
          </div>`
        })
        return result
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
        fontWeight: 500
      },
      pageIconColor: '#0f6b4a',
      pageIconInactiveColor: '#d1d5db',
      pageTextStyle: {
        color: '#6b7280'
      }
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
          width: 1
        }
      },
      axisTick: {
        show: false
      },
      axisLabel: {
        rotate: selectedPeriod.value === '24h' ? 0 : 45,
        interval: 'auto',
        color: '#9ca3af',
        fontSize: isMobile ? 10 : 12,
        margin: isMobile ? 8 : 12
      },
      splitLine: {
        show: false
      }
    },
    yAxis: {
      type: 'value',
      axisLine: {
        show: false
      },
      axisTick: {
        show: false
      },
      axisLabel: {
        color: '#9ca3af',
        fontSize: isMobile ? 10 : 12,
        margin: isMobile ? 8 : 12,
        formatter: (value: number) => {
          if (chartMetric.value === 'requests') {
            return formatNumber(value)
          }
          return formatTokenNumber(value)
        }
      },
      splitLine: {
        lineStyle: {
          color: '#f3f4f6',
          width: 1,
          type: 'solid'
        }
      }
    },
    series
  }
})

const modelDistributionOption = computed(() => {
  if (!modelStats.value || modelStats.value.length === 0) {
    return {}
  }

  const data = modelStats.value
    .map(item => ({
      name: item.model,
      value:
        chartMetric.value === 'requests'
          ? Number(item.request_count || 0)
          : Number(item.total_tokens || 0)
    }))
    .filter(d => d.value > 0)

  if (data.length === 0) return {}

  data.sort((a, b) => b.value - a.value)

  const isMobile = windowWidth.value < 640

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
        fontSize: isMobile ? 11 : 13
      },
      formatter: (params: any) => {
        const val =
          chartMetric.value === 'requests'
            ? formatNumber(params.value)
            : formatTokenNumber(params.value)
        return `<div style="font-weight: 600; color: #111827;">${params.name}</div>
                <div style="margin-top: 4px;">${params.marker} ${val} (${params.percent}%)</div>`
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
        return name.length > 15 ? name.slice(0, 15) + '...' : name
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
  }
})

async function loadInitialData() {
  await Promise.all([
    providerStore.fetchProviders(),
    virtualKeyStore.fetchVirtualKeys(),
    loadStatsSummary()
  ])
  // 摘要加载完成后，后台静默加载完整统计（趋势、模型、成本、熔断器、请求来源等）
  await loadStats({ silent: true })
}

async function refreshDashboard() {
  await Promise.all([
    providerStore.fetchProviders(),
    virtualKeyStore.fetchVirtualKeys(),
    loadStats()
  ])
}

async function loadStatsSummary() {
  loading.value = true
  loadError.value = null
  try {
    const result = await configApi.getStatsSummary(selectedPeriod.value)

    if (!result || !result.stats) {
      throw new Error('获取统计概览失败')
    }

    stats.value = result.stats
  } catch (error: any) {
    const errorMsg = error.message || '加载数据失败'
    loadError.value = errorMsg
    message.error(errorMsg)
  } finally {
    loading.value = false
  }
}

async function loadStats(opts: { silent?: boolean } = {}) {
  if (!opts.silent) {
    loading.value = true
  }
  loadError.value = null
  try {
    const result = await configApi.getStats(selectedPeriod.value, chartMetric.value)

    if (!result || !result.stats) {
      throw new Error('获取统计数据失败')
    }

    stats.value = result.stats
    trendData.value = result.trend || []
    intentClassifyStats.value = result.intentClassifyStats || {
      totalRequests: 0,
      avgClassificationTime: 0
    }
    modelStats.value = result.modelStats || []
    circuitBreakerStats.value = result.circuitBreakerStats || {
      totalTriggers: 0,
      maxTriggeredProvider: '-',
      maxTriggerCount: 0
    }
    costStats.value = result.costStats || null
    threatIpStats.value = result.threatIpStats || null
    piiProtectionCount.value = result.piiProtectionCount || 0
  } catch (error: any) {
    const errorMsg = error.message || '加载数据失败'
    loadError.value = errorMsg
    if (!opts.silent) {
      message.error(errorMsg)
    }
  } finally {
    if (!opts.silent) {
      loading.value = false
    }
  }
}

// 饼图/趋势的 Top N 由后端按当前 metric 排序截断，切换指标需重新拉取
watch(chartMetric, () => {
  loadStats({ silent: true })
})

const formatProviderName = (name: string | undefined) => {
  if (!name || name === '-') return '-'
  return name.length > 15 ? name.slice(0, 15) + '...' : name
}

const formatCost = (cost: number) => {
  if (cost === 0) return '0.00'
  if (cost < 0.01) return cost.toFixed(4)
  return cost.toFixed(2)
}

onMounted(async () => {
  loadInitialData()
  // When cost mapping rules change, refresh dashboard stats so cost analysis updates in real time
  window.addEventListener('cost-mapping-updated', loadStats as any)
})

onUnmounted(() => {
  window.removeEventListener('cost-mapping-updated', loadStats as any)
})
</script>

<style scoped src="@/styles/dashboard.css"></style>

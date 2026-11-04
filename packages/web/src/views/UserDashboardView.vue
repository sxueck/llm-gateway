<template>
  <div class="user-dashboard-view">
    <n-space vertical :size="20">
      <PageHeader
        eyebrow="OVERVIEW"
        :title="t('userDashboard.title')"
        :subtitle="t('userDashboard.subtitle')"
      >
        <template #actions>
          <n-button secondary round :loading="loading" @click="load">
            <template #icon>
              <n-icon><RefreshOutline /></n-icon>
            </template>
            {{ t('common.refresh') }}
          </n-button>
        </template>
      </PageHeader>

      <n-alert v-if="loadError" type="error" :show-icon="true">
        <div class="load-error">{{ t('userDashboard.loadFailed') }}</div>
        <div class="load-error-detail">{{ loadError }}</div>
      </n-alert>

      <n-card :title="t('userDashboard.globalSummary')">
        <n-grid cols="1 s:3" responsive="screen" :x-gap="20" :y-gap="12">
          <n-gi><div>{{ t('dashboard.totalRequests') }}</div><strong>{{ formatNumber(globalStats?.totalRequests ?? 0) }}</strong></n-gi>
          <n-gi><div>{{ t('dashboard.tokenConsumption') }}</div><strong>{{ formatNumber(globalStats?.totalTokens ?? 0) }}</strong></n-gi>
          <n-gi><div>{{ t('common.failed') }}</div><strong>{{ formatNumber(globalStats?.failedRequests ?? 0) }}</strong></n-gi>
        </n-grid>
      </n-card>

      <n-grid cols="1 s:2 l:4" responsive="screen" :x-gap="20" :y-gap="20">
        <n-gi>
          <n-card class="stat-card" @click="router.push('/me/virtual-keys')">
            <div class="stat-content">
              <div class="stat-header">{{ t('userDashboard.keyCount') }}</div>
              <div class="stat-main-value">
                <n-skeleton v-if="loading" text style="width: 50%; height: 38px" :sharp="false" />
                <span v-else>{{ formatNumber(keyTotal) }}</span>
              </div>
              <div class="stat-details">
                <span class="stat-detail-item">
                  <span class="stat-detail-label">{{ t('common.enabledKeys') }}:</span>
                  <span class="stat-detail-value">
                    <n-skeleton v-if="loading" text style="width: 30px" />
                    <span v-else>{{ formatNumber(enabledKeyTotal) }}</span>
                  </span>
                </span>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card" @click="router.push('/me/api-requests')">
            <div class="stat-content">
              <div class="stat-header">{{ t('userDashboard.requests24h') }}</div>
              <div class="stat-main-value">
                <n-skeleton v-if="loading" text style="width: 50%; height: 38px" :sharp="false" />
                <span v-else>{{ formatNumber(requests24h ?? 0) }}</span>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card" @click="router.push('/me/api-requests')">
            <div class="stat-content">
              <div class="stat-header">{{ t('userDashboard.requests7d') }}</div>
              <div class="stat-main-value">
                <n-skeleton v-if="loading" text style="width: 50%; height: 38px" :sharp="false" />
                <span v-else>{{ formatNumber(requests7d ?? 0) }}</span>
              </div>
            </div>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card class="stat-card" @click="router.push('/me/api-requests')">
            <div class="stat-content">
              <div class="stat-header">{{ t('userDashboard.lastRequest') }}</div>
              <div class="stat-main-value stat-value-text">
                <n-skeleton v-if="loading" text style="width: 70%; height: 24px" :sharp="false" />
                <span v-else>{{ lastRequestLabel }}</span>
              </div>
            </div>
          </n-card>
        </n-gi>
      </n-grid>

      <n-card class="recent-card">
        <template #header>
          <div class="recent-header">
            <span>{{ t('userDashboard.recentRequests') }}</span>
            <n-button size="small" @click="router.push('/me/api-requests')">
              {{ t('userDashboard.viewAll') }}
            </n-button>
          </div>
        </template>
        <n-data-table
          :columns="columns"
          :data="recentRequests"
          :loading="loading"
          :row-key="(row: ApiRequest) => row.id"
          :bordered="false"
          size="small"
        />
      </n-card>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NGi,
  NGrid,
  NIcon,
  NSkeleton,
  NSpace,
  NTag,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { RefreshOutline } from '@vicons/ionicons5'
import { meApi } from '@/api/me'
import request from '@/utils/request'
import type { ApiStats } from '@/api/config'
import type { ApiRequest } from '@/api/api-request'
import { formatNumber } from '@/utils/format'
import { formatTimestamp } from '@/utils/common'
import { getRequestTokens } from '@/utils/api-request-display'
import PageHeader from '@/components/PageHeader.vue'

const DAY_MS = 24 * 60 * 60 * 1000
// 近况列表固定取第一页，翻页/过滤请去「API 请求日志」页
const RECENT_PAGE_SIZE = 10

const { t } = useI18n()
const router = useRouter()

const loading = ref(true)
const loadError = ref<string | null>(null)
const keyTotal = ref(0)
const enabledKeyTotal = ref(0)
const requests24h = ref<number | null>(null)
const requests7d = ref<number | null>(null)
const recentRequests = ref<ApiRequest[]>([])
const globalStats = ref<ApiStats | null>(null)

// 请求总数来自列表接口在时间窗过滤后的 total 字段，是服务端口径而不是本页抽样。
async function loadRequestTotals() {
  const now = Date.now()
  const [last24h, last7d] = await Promise.all([
    meApi.getApiRequests({ page: 1, pageSize: 1, startTime: now - DAY_MS, endTime: now }),
    meApi.getApiRequests({ page: 1, pageSize: 1, startTime: now - 7 * DAY_MS, endTime: now }),
  ])
  requests24h.value = last24h.total
  requests7d.value = last7d.total
}

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const [keysRes, recentRes, globalRes] = await Promise.all([
      meApi.getVirtualKeys(),
      meApi.getApiRequests({ page: 1, pageSize: RECENT_PAGE_SIZE }),
      request.get<{ stats: ApiStats }>('/dashboard/stats', { params: { period: '24h' } }),
    ])
    globalStats.value = globalRes.stats
    keyTotal.value = keysRes.virtualKeys.length
    enabledKeyTotal.value = keysRes.virtualKeys.filter((key) => key.enabled).length
    recentRequests.value = recentRes.data
    await loadRequestTotals()
  } catch (error: any) {
    loadError.value = error?.message || String(error ?? 'unknown')
  } finally {
    loading.value = false
  }
}

const lastRequestLabel = computed(() => {
  const latest = recentRequests.value[0]
  return latest ? formatTimestamp(latest.created_at) : t('userDashboard.never')
})

const columns = computed<DataTableColumns<ApiRequest>>(() => [
  {
    title: t('apiRequests.requestTime'),
    key: 'created_at',
    width: 160,
    render: (row) => h('span', { class: 'table-time' }, formatTimestamp(row.created_at)),
  },
  {
    title: t('apiRequests.model'),
    key: 'model',
    width: 200,
    ellipsis: { tooltip: true },
    render: (row) => h('span', { class: 'table-model' }, row.model || '-'),
  },
  {
    title: t('apiRequests.colVirtualKey'),
    key: 'virtual_key_name',
    width: 150,
    ellipsis: { tooltip: true },
    render: (row) =>
      h(
        'span',
        { class: row.virtual_key_name ? 'table-key' : 'table-placeholder' },
        row.virtual_key_name || row.virtual_key_id || '-',
      ),
  },
  {
    title: t('apiRequests.status'),
    key: 'status',
    width: 80,
    render: (row) =>
      h(
        NTag,
        { type: row.status === 'success' ? 'success' : 'error', size: 'small' },
        { default: () => (row.status === 'success' ? t('common.success') : t('common.failed')) },
      ),
  },
  {
    title: t('apiRequests.responseTime'),
    key: 'response_time',
    width: 90,
    render: (row) =>
      h(
        'span',
        { class: row.response_time ? 'table-latency' : 'table-placeholder' },
        row.response_time ? `${row.response_time}ms` : '-',
      ),
  },
  {
    title: t('apiRequests.tokens'),
    key: 'tokens',
    width: 170,
    render: (row) =>
      h('div', { class: 'token-lines' }, [
        h('div', { class: 'token-line' }, `${t('apiRequests.input')}: ${getRequestTokens(row, 'input')}`),
        h('div', { class: 'token-line' }, `${t('apiRequests.output')}: ${getRequestTokens(row, 'output')}`),
      ]),
  },
])

onMounted(load)
</script>

<style scoped>
.user-dashboard-view {
  max-width: 1400px;
  margin: 0 auto;
}

.load-error {
  font-weight: 500;
}

.load-error-detail {
  margin-top: 4px;
  font-size: 12px;
  word-break: break-all;
}

.stat-card {
  cursor: pointer;
  transition: box-shadow 0.2s ease;
}

.stat-card:hover {
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
}

.stat-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 108px;
}

.stat-header {
  font-size: 13px;
  color: #66756f;
}

.stat-main-value {
  font-size: 30px;
  font-weight: 600;
  color: var(--color-title, #1a1a1a);
  line-height: 1.2;
}

.stat-value-text {
  font-size: 16px;
  line-height: 38px;
}

.stat-details {
  display: flex;
  gap: 16px;
}

.stat-detail-item {
  display: inline-flex;
  gap: 6px;
  font-size: 12px;
}

.stat-detail-label {
  color: #999;
}

.stat-detail-value {
  color: #42514b;
}

.recent-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.table-time {
  color: #374151;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}

.table-model {
  color: #111827;
  font-weight: 500;
}

.table-latency {
  color: #1f2937;
  font-weight: 600;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}

.table-placeholder {
  color: #9ca3af;
}

.table-key {
  color: #1f2937;
  font-size: 12.5px;
  font-weight: 500;
}

.token-lines {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.token-line {
  font-size: 12px;
  color: #4b5563;
  font-variant-numeric: tabular-nums;
}
</style>

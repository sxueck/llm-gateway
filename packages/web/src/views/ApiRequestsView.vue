<template>
  <div class="api-requests-view">
    <n-space vertical :size="24">
      <PageHeader eyebrow="TOOLS" :title="t('apiRequests.title')" />
      <n-card>
        <n-space vertical :size="16">
          <n-space class="filter-toolbar">
            <n-date-picker
              v-model:value="timeRange"
              type="datetimerange"
              clearable
              class="filter-control filter-date-picker"
              @update:value="handleTimeRangeChange"
            />
            <n-select
              v-model:value="filterVirtualKeyId"
              :options="virtualKeyOptions"
              class="filter-control filter-key-select"
              :placeholder="t('apiRequests.colVirtualKey')"
              clearable
              filterable
              @update:value="resetPageAndLoad"
            />
            <n-select
              v-model:value="filterProviderId"
              :options="providerOptions"
              class="filter-control filter-provider-select"
              :placeholder="t('apiRequests.colProvider')"
              clearable
              filterable
              @update:value="resetPageAndLoad"
            />
            <n-select
              v-model:value="filterModel"
              :options="modelOptions"
              class="filter-control filter-model-select"
              :placeholder="t('apiRequests.model')"
              clearable
              filterable
              tag
              @update:value="resetPageAndLoad"
            />
            <n-input
              v-model:value="filterIp"
              class="filter-control filter-ip-input"
              :placeholder="t('apiRequests.filterIp')"
              clearable
              @keyup.enter="resetPageAndLoad"
              @clear="resetPageAndLoad"
            />
            <n-input
              v-model:value="filterSessionId"
              class="filter-control filter-session-input"
              :placeholder="t('apiRequests.filterSessionId')"
              clearable
              @keyup.enter="resetPageAndLoad"
              @clear="resetPageAndLoad"
            />
            <n-select
              v-model:value="filterStatus"
              :options="statusOptions"
              class="filter-control filter-status-select"
              :placeholder="t('apiRequests.status')"
              clearable
              @update:value="resetPageAndLoad"
            />
            <n-button class="filter-action-btn" :disabled="!hasActiveFilters" @click="clearFilters">
              {{ t('apiRequests.clearFilters') }}
            </n-button>
            <n-button class="filter-action-btn" @click="loadRequests" :loading="loading">
              {{ t('common.refresh') }}
            </n-button>
            <n-button class="filter-action-btn" @click="showCleanDialog = true" type="warning">
              {{ t('apiRequests.cleanOldLogs') }}
            </n-button>
          </n-space>
          <n-data-table
            :columns="columns"
            :data="requests"
            :loading="loading"
            :pagination="pagination"
            :row-key="(row: ApiRequest) => row.id"
            :row-props="rowProps"
            :row-class-name="rowClassName"
            :scroll-x="1290"
            remote
            striped
          />
        </n-space>
      </n-card>
    </n-space>

    <n-drawer v-model:show="showDetail" :width="drawerWidth" placement="right">
      <n-drawer-content :title="t('apiRequests.requestDetail')" closable class="request-detail-drawer">
        <n-space vertical :size="20" v-if="selectedRequest">
          <n-card size="small" :bordered="false" class="detail-meta-card">
            <n-descriptions :column="2" bordered size="medium" label-placement="left">
              <n-descriptions-item :label="t('apiRequests.requestId')" :span="2">
                <n-text code class="detail-code-id">{{ selectedRequest.id }}</n-text>
              </n-descriptions-item>
              <n-descriptions-item :label="t('apiRequests.requestTime')">
                {{ formatTimestamp(selectedRequest.created_at) }}
              </n-descriptions-item>
              <n-descriptions-item :label="t('apiRequests.responseTime')">
                <n-tag v-if="selectedRequest.response_time" type="info" size="small">
                  {{ selectedRequest.response_time }}ms
                </n-tag>
                <span v-else>-</span>
              </n-descriptions-item>
              <n-descriptions-item :label="t('apiRequests.tffb')">
                <n-tag v-if="selectedRequest.tffb_ms !== null" type="warning" size="small">
                  {{ selectedRequest.tffb_ms }}ms
                </n-tag>
                <span v-else>-</span>
              </n-descriptions-item>
              <n-descriptions-item :label="t('apiRequests.model')">
                <n-text strong>{{ selectedRequest.model || '-' }}</n-text>
              </n-descriptions-item>
              <n-descriptions-item :label="t('apiRequests.status')">
                <n-tag
                  :type="selectedRequest.status === 'success' ? 'success' : 'error'"
                  size="medium"
                >
                  {{
                    selectedRequest.status === 'success'
                      ? t('common.success')
                      : t('common.failed')
                  }}
                </n-tag>
              </n-descriptions-item>
              <n-descriptions-item
                :label="t('apiRequests.streamResume')"
                v-if="getRequestParams(selectedRequest!)?.stream_resumed"
              >
                <n-tag type="warning" size="small">
                  {{
                    t('apiRequests.streamResumedChars', {
                      chars: getRequestParams(selectedRequest!)?.stream_resume_chars ?? 0
                    })
                  }}
                </n-tag>
              </n-descriptions-item>
              <n-descriptions-item :label="t('apiRequests.inputTokens')">
                <n-tag type="default" size="small">
                  {{ getTokens(selectedRequest!, 'input') }}
                </n-tag>
              </n-descriptions-item>
              <n-descriptions-item :label="t('apiRequests.outputTokens')">
                <n-tag type="default" size="small">
                  {{ getTokens(selectedRequest!, 'output') }}
                </n-tag>
              </n-descriptions-item>
              <n-descriptions-item
                :label="t('apiRequests.cachedTokens')"
                v-if="selectedRequest.cached_tokens"
              >
                <n-tag type="warning" size="small">{{ selectedRequest.cached_tokens }}</n-tag>
              </n-descriptions-item>
              <n-descriptions-item
                :label="t('apiRequests.compressionOriginalTokens')"
                v-if="selectedRequest.compression_original_tokens"
              >
                <n-tag type="info" size="small">
                  {{ selectedRequest.compression_original_tokens }}
                </n-tag>
              </n-descriptions-item>
              <n-descriptions-item
                :label="t('apiRequests.compressionSavedTokens')"
                v-if="selectedRequest.compression_saved_tokens"
              >
                <n-tag type="success" size="small">
                  {{ selectedRequest.compression_saved_tokens }}
                </n-tag>
              </n-descriptions-item>
              <n-descriptions-item :label="t('apiRequests.colVirtualKey')" v-if="selectedRequest.virtual_key_id">
                <div class="detail-named-id">
                  <n-text strong>{{ selectedRequest.virtual_key_name || t('apiRequests.unnamedKey') }}</n-text>
                  <n-text code class="detail-code-id">{{ selectedRequest.virtual_key_id }}</n-text>
                </div>
              </n-descriptions-item>
              <n-descriptions-item :label="t('apiRequests.colProvider')" v-if="selectedRequest.provider_id">
                <div class="detail-named-id">
                  <n-text strong>{{ selectedRequest.provider_name || t('apiRequests.unknownProvider') }}</n-text>
                  <n-text code class="detail-code-id">{{ selectedRequest.provider_id }}</n-text>
                </div>
              </n-descriptions-item>
              <n-descriptions-item :label="t('apiRequests.filterIp')" v-if="selectedRequest.ip">
                <n-text code class="detail-code-id">{{ selectedRequest.ip }}</n-text>
              </n-descriptions-item>
              <n-descriptions-item :label="t('apiRequests.detailClient')" v-if="selectedRequest.user_agent" :span="2">
                <n-text class="detail-user-agent">{{ selectedRequest.user_agent }}</n-text>
              </n-descriptions-item>
            </n-descriptions>
          </n-card>

          <n-card size="small" :bordered="false" class="session-nav-card">
            <template #header>
              <n-space align="center" :size="8">
                <span>{{ t('apiRequests.sessionNav') }}</span>
                <n-tag
                  v-if="session"
                  size="tiny"
                  :bordered="false"
                  :type="session.strategy === 'explicit' ? 'success' : 'warning'"
                >
                  {{ session.strategy === 'explicit' ? t('apiRequests.sessionExplicit') : t('apiRequests.sessionInferred') }}
                </n-tag>
              </n-space>
            </template>
            <n-spin :show="sessionLoading">
              <n-space vertical :size="12">
                <n-space align="center" :size="8">
                  <n-button
                    size="small"
                    :disabled="!session || !session.requests.length"
                    @click="gotoSessionRequest(0)"
                  >
                    {{ t('apiRequests.sessionFirst') }}
                  </n-button>
                  <n-button
                    size="small"
                    :disabled="!session || sessionIndex <= 0"
                    @click="gotoSessionRequest(sessionIndex - 1)"
                  >
                    {{ t('apiRequests.sessionPrev') }}
                  </n-button>
                  <n-button
                    size="small"
                    :disabled="!session || sessionIndex < 0 || sessionIndex >= (session?.requests.length ?? 0) - 1"
                    @click="gotoSessionRequest(sessionIndex + 1)"
                  >
                    {{ t('apiRequests.sessionNext') }}
                  </n-button>
                  <n-button
                    size="small"
                    :disabled="!session || sessionIndex < 0 || sessionIndex >= (session?.requests.length ?? 0) - 1"
                    @click="gotoSessionRequest((session?.requests.length ?? 1) - 1)"
                  >
                    {{ t('apiRequests.sessionLatest') }}
                  </n-button>
                  <n-text depth="3" class="session-position">
                    {{ session && sessionIndex >= 0 ? t('apiRequests.sessionPosition', { index: sessionIndex + 1, total: session.requests.length }) : '' }}
                  </n-text>
                </n-space>
                <n-space align="center" :size="8" wrap>
                  <n-text v-if="session?.sessionId" code class="detail-code-id">
                    {{ session.sessionId }}
                  </n-text>
                  <n-button size="tiny" :disabled="!session" @click="filterOnlySession">
                    {{ t('apiRequests.sessionOnly') }}
                  </n-button>
                </n-space>
                <n-text v-if="session?.truncated" depth="3" class="session-hint">
                  {{ t('apiRequests.sessionTruncatedHint', { count: session.requests.length }) }}
                </n-text>
                <n-text v-else-if="session && session.strategy === 'heuristic'" depth="3" class="session-hint">
                  {{ t('apiRequests.sessionHeuristicHint') }}
                </n-text>
              </n-space>
            </n-spin>
          </n-card>

          <n-card
            v-if="selectedRequest.request_body"
            :title="t('apiRequests.requestBody')"
            size="small"
            hoverable
          >
            <n-code
              :code="formatJson(selectedRequest.request_body)"
              language="json"
              word-wrap
              class="json-code-block"
            />
          </n-card>

          <n-card
            v-if="selectedRequest.response_body"
            :title="t('apiRequests.responseBody')"
            size="small"
            hoverable
          >
            <n-code
              :code="formatJson(selectedRequest.response_body)"
              language="json"
              word-wrap
              class="json-code-block"
            />
          </n-card>

          <n-card
            v-if="selectedRequest.error_message"
            :title="t('apiRequests.errorMessage')"
            size="small"
            hoverable
          >
            <n-alert type="error" class="error-message-alert">
              {{ selectedRequest.error_message }}
            </n-alert>
          </n-card>
        </n-space>
      </n-drawer-content>
    </n-drawer>

    <n-modal
      v-model:show="showCleanDialog"
      preset="dialog"
      :title="t('apiRequests.cleanOldLogs')"
      class="clean-dialog-modal"
      :style="{ maxHeight: '85vh' }"
    >
      <template #default>
        <div class="modal-content-wrapper">
          <n-space vertical :size="16">
            <n-text>{{ t('apiRequests.cleanDialogDesc') }}</n-text>
            <n-input-number
              v-model:value="cleanDays"
              :min="1"
              :max="365"
              :placeholder="t('apiRequests.daysToKeep')"
              class="clean-days-input"
            >
              <template #suffix>{{ t('apiRequests.days') }}</template>
            </n-input-number>
          </n-space>
        </div>
      </template>
      <template #action>
        <n-space>
          <n-button @click="showCleanDialog = false">{{ t('common.cancel') }}</n-button>
          <n-button type="warning" @click="handleCleanLogs" :loading="cleanLoading">
            {{ t('apiRequests.confirmClean') }}
          </n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, h, onMounted, reactive, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  useMessage,
  NSpace,
  NCard,
  NButton,
  NDataTable,
  NTag,
  NDrawer,
  NDrawerContent,
  NDescriptions,
  NDescriptionsItem,
  NDatePicker,
  NSelect,
  NCode,
  NModal,
  NText,
  NInputNumber,
  NInput,
  NSpin,
  NAlert
} from 'naive-ui'
import { apiRequestApi, type ApiRequest, type ApiRequestSession } from '@/api/api-request'
import { virtualKeyApi } from '@/api/virtual-key'
import { providerApi } from '@/api/provider'
import { modelApi } from '@/api/model'
import type { DataTableColumns, PaginationProps } from 'naive-ui'
import { formatJson, formatTimestamp } from '@/utils/common'
import { isSessionStartBody } from '@/utils/session-start'
import { extractRequestPreview } from '@/utils/content-truncator'
import { useDebouncedWindowSize } from '@/composables/useDebouncedWindowSize'
import PageHeader from '@/components/PageHeader.vue'

const message = useMessage()
const { t } = useI18n()
const loading = ref(false)
const requests = ref<ApiRequest[]>([])
const showDetail = ref(false)
const selectedRequest = ref<ApiRequest | null>(null)
const timeRange = ref<[number, number] | null>(null)
const filterStatus = ref<string | undefined>(undefined)
const filterVirtualKeyId = ref<string | undefined>(undefined)
const filterProviderId = ref<string | undefined>(undefined)
const filterModel = ref<string | undefined>(undefined)
const filterIp = ref<string>('')
const filterSessionId = ref<string>('')
const virtualKeyOptions = ref<Array<{ label: string; value: string }>>([])
const providerOptions = ref<Array<{ label: string; value: string }>>([])
const modelOptions = ref<Array<{ label: string; value: string }>>([])

const route = useRoute()
const router = useRouter()

const hasActiveFilters = computed(
  () =>
    !!timeRange.value ||
    !!filterStatus.value ||
    !!filterVirtualKeyId.value ||
    !!filterProviderId.value ||
    !!filterModel.value ||
    !!filterIp.value.trim() ||
    !!filterSessionId.value.trim()
)

// Drill-down entry: ops monitoring pushes startTime/endTime/virtualKeyId/
// providerId/model/status as query params; the controls must reflect them,
// not just forward them to the API.
const applyRouteQuery = () => {
  const q = route.query
  const start = Number(q.startTime)
  const end = Number(q.endTime)
  if (Number.isFinite(start) && start > 0 && Number.isFinite(end) && end > start) {
    timeRange.value = [start, end]
  }
  if (typeof q.virtualKeyId === 'string' && q.virtualKeyId) {
    filterVirtualKeyId.value = q.virtualKeyId
  }
  if (typeof q.providerId === 'string' && q.providerId) {
    filterProviderId.value = q.providerId
  }
  if (typeof q.model === 'string' && q.model) {
    filterModel.value = q.model
  }
  if (q.status === 'success' || q.status === 'error') {
    filterStatus.value = q.status
  }
  if (typeof q.ip === 'string' && q.ip) {
    filterIp.value = q.ip
  }
}

const clearFilters = () => {
  timeRange.value = null
  filterStatus.value = undefined
  filterVirtualKeyId.value = undefined
  filterProviderId.value = undefined
  filterModel.value = undefined
  filterIp.value = ''
  filterSessionId.value = ''
  // 清除过滤后重置分页；同时移除携带的 URL 参数
  pagination.page = 1
  if (Object.keys(route.query).length > 0) {
    router.replace({ path: route.path })
  }
  loadRequests()
}

const resetPageAndLoad = () => {
  pagination.page = 1
  loadRequests()
}
const showCleanDialog = ref(false)
const cleanDays = ref(30)
const cleanLoading = ref(false)

type JsonLike = Record<string, any> | string | null | undefined

const parseJsonLike = (value: JsonLike): Record<string, any> | null => {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const getRequestParams = (row: ApiRequest): Record<string, any> | null => {
  return parseJsonLike(row.request_params_json)
}

const previewFromJson = (value: JsonLike): string => {
  const parsed = parseJsonLike(value)
  if (!parsed) return '-'

  const text = JSON.stringify(parsed)
  if (!text) return '-'
  return text.length > 80 ? `${text.slice(0, 80)}...` : text
}

const getTokens = (row: ApiRequest, type: 'input' | 'output') => {
  const isInput = type === 'input'
  const direct = isInput ? row.prompt_tokens : row.completion_tokens
  if (direct) return direct
  try {
    const usage = JSON.parse(row.response_body || '{}')?.usage
    if (!usage) return 0
    const base = isInput
      ? (usage.input_tokens ?? usage.prompt_tokens ?? 0)
      : (usage.output_tokens ?? usage.completion_tokens ?? 0)
    return isInput && base === 0
      ? base +
          (usage.input_tokens_details?.cached_tokens ??
            usage.prompt_tokens_details?.cached_tokens ??
            0)
      : base
  } catch {
    return 0
  }
}

const toDisplayDepth = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  // 保留模型自定义深度值；仅在全小写时做首字母大写，便于展示
  if (trimmed === trimmed.toLowerCase()) {
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
  }

  return trimmed
}

const extractThinkingDepth = (requestBody: string | null): string | null => {
  if (!requestBody) return null

  try {
    const parsed = JSON.parse(requestBody)

    const directDepth = toDisplayDepth(parsed.reasoning?.effort)

    return directDepth
  } catch {
    return null
  }
}

const extractThinkingDepthFromRow = (row: ApiRequest): string | null => {
  const depthFromSummary = toDisplayDepth(getRequestParams(row)?.reasoning_effort)
  if (depthFromSummary) return depthFromSummary
  return extractThinkingDepth(row.request_body)
}

const getRequestPreview = (row: ApiRequest): string => {
  if (row.request_body) {
    return extractRequestPreview(row.request_body)
  }
  return previewFromJson(row.request_params_json)
}

const getModelDisplay = (row: ApiRequest): string => {
  const modelName = row.model || '-'
  if (!row.model) return modelName

  const depth = extractThinkingDepthFromRow(row)
  return depth ? `${row.model} (${depth})` : modelName
}

const handlePageChange = (page: number) => {
  pagination.page = page
  loadRequests()
}

const handlePageSizeChange = (pageSize: number) => {
  pagination.pageSize = pageSize
  pagination.page = 1
  loadRequests()
}

const { windowWidth } = useDebouncedWindowSize(200)

const drawerWidth = computed(() =>
  Math.min(800, Math.max(320, Math.floor(windowWidth.value * 0.65)))
)

const pagination = reactive<PaginationProps>({
  page: 1,
  pageSize: 20,
  itemCount: 0,
  pageCount: 0,
  pageSizes: [10, 20, 50, 100],
  showSizePicker: true,
  prefix: info => t('apiRequests.totalCount', { count: info.itemCount }),
  onChange: handlePageChange,
  onUpdatePageSize: handlePageSizeChange
})

const statusOptions = computed(() => [
  { label: t('common.success'), value: 'success' },
  { label: t('common.failed'), value: 'error' }
])

const columns = computed<DataTableColumns<ApiRequest>>(() => [
  {
    title: t('apiRequests.requestTime'),
    key: 'created_at',
    width: 160,
    render: row => h('span', { class: 'table-time' }, formatTimestamp(row.created_at))
  },
  {
    title: t('apiRequests.model'),
    key: 'model',
    width: 190,
    ellipsis: {
      tooltip: true
    },
    render: row => h('span', { class: 'table-model' }, getModelDisplay(row))
  },
  {
    title: t('apiRequests.colVirtualKey'),
    key: 'virtual_key_name',
    width: 150,
    ellipsis: {
      tooltip: true
    },
    render: row =>
      h(
        'span',
        { class: row.virtual_key_name ? 'table-key' : 'table-placeholder' },
        row.virtual_key_name || row.virtual_key_id || '-'
      )
  },
  {
    title: t('apiRequests.colProvider'),
    key: 'provider_name',
    width: 120,
    ellipsis: {
      tooltip: true
    },
    render: row =>
      h(
        'span',
        { class: row.provider_name ? 'table-key' : 'table-placeholder' },
        row.provider_name || row.provider_id || '-'
      )
  },
  {
    title: t('apiRequests.status'),
    key: 'status',
    width: 70,
    render: row => {
      return h(
        NTag,
        {
          type: row.status === 'success' ? 'success' : 'error',
          size: 'small'
        },
        {
          default: () => (row.status === 'success' ? t('common.success') : t('common.failed'))
        }
      )
    }
  },
  {
    title: t('apiRequests.responseTime'),
    key: 'response_time',
    width: 90,
    render: row =>
      h(
        'span',
        { class: row.response_time ? 'table-latency' : 'table-placeholder' },
        row.response_time ? `${row.response_time}ms` : '-'
      )
  },
  {
    title: t('apiRequests.tffb'),
    key: 'tffb_ms',
    width: 90,
    render: row =>
      h(
        'span',
        { class: row.tffb_ms !== null ? 'table-latency' : 'table-placeholder' },
        row.tffb_ms !== null ? `${row.tffb_ms}ms` : '-'
      )
  },
  {
    title: t('apiRequests.colSession'),
    key: 'session_id',
    width: 90,
    render: row => {
      if (row.session_id) {
        return h(
          NTag,
          { size: 'small', type: 'success', bordered: false, title: row.session_id },
          { default: () => t('apiRequests.tagExplicit') }
        )
      }
      // 无显式标识时只能靠“本轮无 assistant 回合”推断首条，口径仅供导航参考。
      if (isSessionStartBody(row.request_body)) {
        return h(
          NTag,
          { size: 'small', type: 'warning', bordered: false },
          { default: () => t('apiRequests.tagSessionStart') }
        )
      }
      return h('span', { class: 'table-placeholder' }, '-')
    }
  },
  {
    title: t('apiRequests.tokens'),
    key: 'tokens',
    width: 180,
    render: row => {
      const items = [
        h('div', { class: 'token-line' }, `${t('apiRequests.input')}: ${getTokens(row, 'input')}`),
        h('div', { class: 'token-line' }, `${t('apiRequests.output')}: ${getTokens(row, 'output')}`)
      ]

      if (row.compression_saved_tokens && row.compression_saved_tokens > 0) {
        items.push(
          h(
            'div',
            { class: 'token-line token-line-saving' },
            `${t('apiRequests.saved')}: ${row.compression_saved_tokens}`
          )
        )
      }

      return h(NSpace, { vertical: true, size: 2 }, { default: () => items })
    }
  },
  {
    title: t('apiRequests.requestPreview'),
    key: 'request_body',
    width: 140,
    ellipsis: {
      tooltip: true
    },
    render: row => h('span', { class: 'table-preview' }, getRequestPreview(row))
  }
])

const loadRequests = async () => {
  loading.value = true
  try {
    const params: any = {
      page: pagination.page,
      pageSize: pagination.pageSize
    }

    if (timeRange.value) {
      params.startTime = timeRange.value[0]
      params.endTime = timeRange.value[1]
    }

    if (filterStatus.value) {
      params.status = filterStatus.value
    }

    if (filterVirtualKeyId.value) {
      params.virtualKeyId = filterVirtualKeyId.value
    }

    if (filterProviderId.value) {
      params.providerId = filterProviderId.value
    }

    if (filterModel.value) {
      params.model = filterModel.value
    }

    const ip = filterIp.value.trim()
    if (ip) {
      params.ip = ip
    }

    const sessionId = filterSessionId.value.trim()
    if (sessionId) {
      params.sessionId = sessionId
    }

    const response = await apiRequestApi.getAll(params)
    requests.value = response.data
    pagination.itemCount = response.total
    pagination.pageCount = response.totalPages
  } catch (error: any) {
    message.error(error.message || t('apiRequests.loadFailed'))
  } finally {
    loading.value = false
  }
}

const handleTimeRangeChange = () => {
  pagination.page = 1
  loadRequests()
}

const session = ref<ApiRequestSession | null>(null)
const sessionLoading = ref(false)
const sessionIndex = computed(() => session.value?.anchorIndex ?? -1)

const loadSession = async (id: string) => {
  sessionLoading.value = true
  try {
    session.value = await apiRequestApi.getSession(id)
  } catch (error: any) {
    session.value = null
  } finally {
    sessionLoading.value = false
  }
}

const gotoSessionRequest = async (index: number) => {
  const target = session.value?.requests[index]
  if (!target) return
  await openRequestById(target.id)
}

// 只看此会话：显式会话直接按 session_id 筛；推断会话没有唯一键，
// 退到同密钥 + 同 IP + 该段起止时间窗，与抽屉里看到的结果一致。
const filterOnlySession = () => {
  const rows = session.value?.requests ?? []
  if (rows.length === 0) return
  const first = rows[0].created_at
  const last = rows[rows.length - 1].created_at
  timeRange.value = [first, last + 1]

  if (session.value?.sessionId) {
    filterSessionId.value = session.value.sessionId
  } else {
    filterVirtualKeyId.value = selectedRequest.value?.virtual_key_id || undefined
    filterIp.value = selectedRequest.value?.ip || ''
  }
  showDetail.value = false
  resetPageAndLoad()
}

const openRequestById = async (id: string) => {
  loading.value = true
  try {
    selectedRequest.value = await apiRequestApi.getById(id)
    showDetail.value = true
    await loadSession(id)
  } catch (error: any) {
    message.error(error.message || t('apiRequests.loadDetailFailed'))
  } finally {
    loading.value = false
  }
}

const handleViewDetail = async (request: ApiRequest) => {
  await openRequestById(request.id)
}

watch(showDetail, open => {
  if (!open) session.value = null
})

const rowProps = (row: ApiRequest) => {
  return {
    style: 'cursor: pointer;',
    onClick: () => handleViewDetail(row)
  }
}

const rowClassName = (row: ApiRequest) =>
  isSessionStartBody(row.request_body) ? 'session-start-row' : ''

const handleCleanLogs = async () => {
  cleanLoading.value = true
  try {
    const result = await apiRequestApi.clean(cleanDays.value)
    message.success(result.message)
    showCleanDialog.value = false
    loadRequests()
  } catch (error: any) {
    message.error(error.message || t('apiRequests.cleanFailed'))
  } finally {
    cleanLoading.value = false
  }
}

const loadVirtualKeys = async () => {
  try {
    const response = await virtualKeyApi.getAll()
    virtualKeyOptions.value = response.virtualKeys.map(vk => ({
      label: `${vk.name} (${vk.keyValue.substring(0, 20)}...)`,
      value: vk.id
    }))
  } catch (error: any) {
    message.error(error.message || t('apiRequests.loadVirtualKeysFailed'))
  }
}
const loadProviderAndModelOptions = async () => {
  try {
    const [providerRes, modelRes] = await Promise.all([
      providerApi.getAll(),
      modelApi.getAll()
    ])
    providerOptions.value = providerRes.providers.map(p => ({
      label: p.name,
      value: p.id
    }))
    modelOptions.value = modelRes.models.map(m => ({
      label: m.name,
      value: m.name
    }))
    ensureDrilledOptionPresent()
  } catch (error: any) {
    message.error(error.message || t('apiRequests.loadFilterOptionsFailed'))
  }
}

// 携带的模型/供应商可能不在已配置列表（实际模型、已删除供应商），
// 保留为选项以保证控件能回显参数值
const ensureDrilledOptionPresent = () => {
  if (filterProviderId.value && !providerOptions.value.some(o => o.value === filterProviderId.value)) {
    providerOptions.value = [
      { label: filterProviderId.value, value: filterProviderId.value },
      ...providerOptions.value
    ]
  }
  if (filterModel.value && !modelOptions.value.some(o => o.value === filterModel.value)) {
    modelOptions.value = [
      { label: filterModel.value, value: filterModel.value },
      ...modelOptions.value
    ]
  }
}

onMounted(() => {
  applyRouteQuery()
  const now = Date.now()
  const oneDayAgo = now - 24 * 60 * 60 * 1000
  if (!timeRange.value) {
    timeRange.value = [oneDayAgo, now]
  }
  loadVirtualKeys()
  loadProviderAndModelOptions()
  loadRequests()
})
</script>

<style scoped>
.filter-toolbar {
  align-items: center;
  justify-content: flex-start;
  flex-wrap: wrap;
  gap: 12px;
  width: 100%;
}

.filter-control {
  font-size: 13px;
}

.filter-date-picker {
  width: 360px;
}

.filter-key-select {
  width: 200px;
}

.filter-provider-select {
  width: 170px;
}

.filter-model-select {
  width: 180px;
}

.filter-status-select {
  width: 120px;
}

.filter-ip-input {
  width: 150px;
}

.filter-session-input {
  width: 180px;
}

.filter-action-btn {
  font-weight: 500;
  letter-spacing: 0.01em;
}

.clean-days-input {
  width: 100%;
}

.detail-meta-card {
  background: #fafafa;
  border-radius: 12px;
}

.detail-code-id {
  word-break: break-all;
  font-size: 12px;
  line-height: 1.5;
}

.json-code-block {
  max-height: 400px;
  overflow-y: auto;
}

.error-message-alert {
  word-break: break-word;
  white-space: pre-wrap;
  line-height: 1.6;
}

.table-time {
  color: #374151;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}

.table-model {
  color: #111827;
  font-weight: 500;
  line-height: 1.45;
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

.table-preview {
  color: #475569;
  font-size: 12.5px;
  line-height: 1.5;
}

.table-key {
  color: #1f2937;
  font-size: 12.5px;
  font-weight: 500;
}

.detail-named-id {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.detail-user-agent {
  font-size: 12px;
  word-break: break-all;
}

.session-nav-card {
  background: #f8fafc;
  border-radius: 12px;
}

.session-position {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.session-hint {
  font-size: 12px;
  line-height: 1.5;
}

.token-line {
  font-size: 12px;
  color: #4b5563;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
}

.token-line-saving {
  color: var(--color-primary);
  font-weight: 600;
}

.api-requests-view :deep(.session-start-row .table-time),
.api-requests-view :deep(.session-start-row .table-model),
.api-requests-view :deep(.session-start-row .table-latency),
.api-requests-view :deep(.session-start-row .table-placeholder),
.api-requests-view :deep(.session-start-row .table-preview),
.api-requests-view :deep(.session-start-row .token-line) {
  color: #ea580c;
}

.clean-dialog-modal .modal-content-wrapper {
  max-height: calc(85vh - 200px);
}

.api-requests-view :deep(.n-data-table-th) {
  font-size: 13px;
  padding: 11px 12px;
  font-weight: 600;
  color: #334155;
  letter-spacing: 0.01em;
}

.api-requests-view :deep(.n-data-table-td) {
  font-size: 13px;
  padding: 11px 12px;
  line-height: 1.55;
  color: #1f2937;
}

.api-requests-view :deep(.n-data-table-tr) {
  min-height: 44px;
  transition: background-color 0.2s ease;
}

.api-requests-view :deep(.n-data-table-tr:hover) {
  background-color: rgba(15, 107, 74, 0.035);
}

.api-requests-view :deep(.n-button--small-type) {
  font-size: 12px;
  padding: 4px 10px;
  height: 28px;
}

.api-requests-view :deep(.n-tag--small-size) {
  font-size: 12px;
  padding: 2px 8px;
  height: 24px;
  line-height: 20px;
}

.api-requests-view :deep(.n-code) {
  word-break: break-word;
  white-space: pre-wrap;
  font-size: 12.5px;
  line-height: 1.65;
}

.api-requests-view :deep(.n-descriptions-table-content__label) {
  font-weight: 500;
  color: #475569;
  font-size: 13px;
}

.api-requests-view :deep(.n-descriptions-table-content__content) {
  color: #1f2937;
  font-size: 13px;
  line-height: 1.5;
}

.api-requests-view :deep(.n-card.n-card--hoverable:hover) {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.api-requests-view :deep(.n-card-header__main) {
  color: var(--color-title);
  font-weight: 600;
  letter-spacing: -0.01em;
}

.request-detail-drawer :deep(.n-drawer-header__main) {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.015em;
}

@media (max-width: 1024px) {
  .filter-date-picker {
    width: 320px;
  }

  .filter-key-select {
    width: 180px;
  }

  .filter-provider-select,
  .filter-model-select {
    width: 150px;
  }
}

@media (max-width: 768px) {
  .filter-toolbar {
    justify-content: flex-start;
  }

  .filter-date-picker,
  .filter-key-select,
  .filter-provider-select,
  .filter-model-select,
  .filter-status-select {
    width: 100%;
  }

  .api-requests-view :deep(.n-data-table-th),
  .api-requests-view :deep(.n-data-table-td) {
    font-size: 12px;
    padding: 9px 10px;
  }

  .token-line {
    font-size: 11px;
  }

  .table-preview {
    font-size: 12px;
  }
}
</style>

<template>
  <div class="my-requests-view">
    <n-space vertical :size="24">
      <PageHeader
        eyebrow="WORKSPACE"
        :title="t('myRequests.title')"
        :subtitle="t('myRequests.subtitle')"
      />
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
              v-model:value="filterModel"
              :options="modelOptions"
              class="filter-control filter-model-select"
              :placeholder="t('apiRequests.model')"
              clearable
              filterable
              tag
              @update:value="resetPageAndLoad"
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
          </n-space>
          <n-data-table
            :columns="columns"
            :data="requests"
            :loading="loading"
            :pagination="pagination"
            :row-key="(row: ApiRequest) => row.id"
            :row-props="rowProps"
            :scroll-x="960"
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
              <n-descriptions-item :label="t('apiRequests.inputTokens')">
                <n-tag type="default" size="small">
                  {{ getRequestTokens(selectedRequest, 'input') }}
                </n-tag>
              </n-descriptions-item>
              <n-descriptions-item :label="t('apiRequests.outputTokens')">
                <n-tag type="default" size="small">
                  {{ getRequestTokens(selectedRequest, 'output') }}
                </n-tag>
              </n-descriptions-item>
              <n-descriptions-item
                :label="t('apiRequests.cachedTokens')"
                v-if="selectedRequest.cached_tokens"
              >
                <n-tag type="warning" size="small">{{ selectedRequest.cached_tokens }}</n-tag>
              </n-descriptions-item>
              <n-descriptions-item :label="t('apiRequests.colVirtualKey')" v-if="selectedRequest.virtual_key_id">
                <div class="detail-named-id">
                  <n-text strong>{{ selectedRequest.virtual_key_name || t('apiRequests.unnamedKey') }}</n-text>
                  <n-text code class="detail-code-id">{{ selectedRequest.virtual_key_id }}</n-text>
                </div>
              </n-descriptions-item>
            </n-descriptions>
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
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  NAlert,
  NButton,
  NCard,
  NCode,
  NDataTable,
  NDatePicker,
  NDescriptions,
  NDescriptionsItem,
  NDrawer,
  NDrawerContent,
  NSelect,
  NSpace,
  NTag,
  NText,
  useMessage,
} from 'naive-ui'
import type { DataTableColumns, PaginationProps } from 'naive-ui'
import { meApi } from '@/api/me'
import type { MyApiRequestQueryParams } from '@/api/me'
import type { ApiRequest } from '@/api/api-request'
import { formatJson, formatTimestamp } from '@/utils/common'
import { getRequestPreview, getRequestTokens } from '@/utils/api-request-display'
import { useDebouncedWindowSize } from '@/composables/useDebouncedWindowSize'
import PageHeader from '@/components/PageHeader.vue'

const DAY_MS = 24 * 60 * 60 * 1000

const message = useMessage()
const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const loading = ref(false)
const requests = ref<ApiRequest[]>([])
const showDetail = ref(false)
const selectedRequest = ref<ApiRequest | null>(null)
const timeRange = ref<[number, number] | null>(null)
const filterStatus = ref<string | undefined>(undefined)
const filterVirtualKeyId = ref<string | undefined>(undefined)
const filterModel = ref<string | undefined>(undefined)
const virtualKeyOptions = ref<Array<{ label: string; value: string }>>([])
// 模型选项没有管理端模型表可查，用已加载行里出现过的模型就地累积，也支持手输任意值
const modelOptions = ref<Array<{ label: string; value: string }>>([])

const { windowWidth } = useDebouncedWindowSize(200)

const drawerWidth = computed(() =>
  Math.min(800, Math.max(320, Math.floor(windowWidth.value * 0.65))),
)

const hasActiveFilters = computed(
  () => !!timeRange.value || !!filterStatus.value || !!filterVirtualKeyId.value || !!filterModel.value,
)

const statusOptions = computed(() => [
  { label: t('common.success'), value: 'success' },
  { label: t('common.failed'), value: 'error' },
])

const pagination = reactive<PaginationProps>({
  page: 1,
  pageSize: 20,
  itemCount: 0,
  pageCount: 0,
  pageSizes: [10, 20, 50, 100],
  showSizePicker: true,
  prefix: (info) => t('apiRequests.totalCount', { count: info.itemCount ?? 0 }),
  onUpdatePage: handlePageChange,
  onUpdatePageSize: handlePageSizeChange,
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
    width: 190,
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
        {
          default: () => (row.status === 'success' ? t('common.success') : t('common.failed')),
        },
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
  {
    title: t('apiRequests.requestPreview'),
    key: 'request_body',
    width: 140,
    ellipsis: { tooltip: true },
    render: (row) => h('span', { class: 'table-preview' }, getRequestPreview(row)),
  },
])

function buildQueryParams(): MyApiRequestQueryParams {
  const params: MyApiRequestQueryParams = {
    page: pagination.page ?? 1,
    pageSize: pagination.pageSize ?? 20,
  }
  if (timeRange.value) {
    params.startTime = timeRange.value[0]
    params.endTime = timeRange.value[1]
  }
  if (filterStatus.value) params.status = filterStatus.value
  if (filterVirtualKeyId.value) params.virtualKeyId = filterVirtualKeyId.value
  if (filterModel.value) params.model = filterModel.value
  return params
}

async function loadRequests() {
  loading.value = true
  try {
    const response = await meApi.getApiRequests(buildQueryParams())
    requests.value = response.data
    accumulateModelOptions(response.data)
    pagination.itemCount = response.total
    pagination.pageCount = response.totalPages
  } catch (error: any) {
    message.error(error?.message || t('apiRequests.loadFailed'))
  } finally {
    loading.value = false
  }
}

// 就地累积模型选项：翻页/过滤后新出现的模型补进下拉，不必预拉全量模型表
function accumulateModelOptions(rows: ApiRequest[]) {
  const known = new Set(modelOptions.value.map((option) => option.value))
  for (const model of rows.map((row) => row.model)) {
    if (model && !known.has(model)) {
      known.add(model)
      modelOptions.value.push({ label: model, value: model })
    }
  }
}

async function loadVirtualKeyOptions() {
  try {
    const response = await meApi.getVirtualKeys()
    virtualKeyOptions.value = response.virtualKeys.map((key) => ({
      label: `${key.name} (${key.keyValue.substring(0, 20)}...)`,
      value: key.id,
    }))
  } catch {
    // 过滤选项拉不到不影响主列表；下拉保持为空即可
  }
}

function handlePageChange(page: number) {
  pagination.page = page
  loadRequests()
}

function handlePageSizeChange(pageSize: number) {
  pagination.pageSize = pageSize
  pagination.page = 1
  loadRequests()
}

function handleTimeRangeChange() {
  pagination.page = 1
  loadRequests()
}

function resetPageAndLoad() {
  pagination.page = 1
  loadRequests()
}

function clearFilters() {
  timeRange.value = null
  filterStatus.value = undefined
  filterVirtualKeyId.value = undefined
  filterModel.value = undefined
  pagination.page = 1
  if (Object.keys(route.query).length > 0) {
    router.replace({ path: route.path })
  }
  loadRequests()
}

async function openRequestById(id: string) {
  loading.value = true
  try {
    selectedRequest.value = await meApi.getApiRequestById(id)
    showDetail.value = true
  } catch (error: any) {
    message.error(error?.message || t('apiRequests.loadDetailFailed'))
  } finally {
    loading.value = false
  }
}

const rowProps = (row: ApiRequest) => ({
  style: 'cursor: pointer;',
  onClick: () => openRequestById(row.id),
})

onMounted(() => {
  // 从「我的密钥」抽屉带着 ?virtualKeyId= 跳进来时直接应用过滤
  const virtualKeyId = route.query.virtualKeyId
  if (typeof virtualKeyId === 'string' && virtualKeyId) {
    filterVirtualKeyId.value = virtualKeyId
  }
  const now = Date.now()
  timeRange.value = [now - DAY_MS, now]
  void loadVirtualKeyOptions()
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

.filter-model-select {
  width: 180px;
}

.filter-status-select {
  width: 120px;
}

.filter-action-btn {
  font-weight: 500;
  letter-spacing: 0.01em;
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

.detail-named-id {
  display: flex;
  flex-direction: column;
  gap: 2px;
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

.token-lines {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.token-line {
  font-size: 12px;
  color: #4b5563;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 1024px) {
  .filter-date-picker {
    width: 320px;
  }

  .filter-key-select {
    width: 180px;
  }

  .filter-model-select {
    width: 150px;
  }
}

@media (max-width: 768px) {
  .filter-date-picker,
  .filter-key-select,
  .filter-model-select,
  .filter-status-select {
    width: 100%;
  }
}
</style>

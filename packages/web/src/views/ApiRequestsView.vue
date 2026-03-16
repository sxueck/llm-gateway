<template>
  <div class="api-requests-view">
    <n-space vertical :size="24">
      <n-card>
        <template #header>
          <span class="card-title">API 请求日志</span>
        </template>
        <template #header-extra>
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
              placeholder="虚拟密钥"
              clearable
              filterable
              @update:value="loadRequests"
            />
            <n-select
              v-model:value="filterStatus"
              :options="statusOptions"
              class="filter-control filter-status-select"
              placeholder="状态"
              clearable
              @update:value="loadRequests"
            />
            <n-button class="filter-action-btn" @click="loadRequests" :loading="loading">
              刷新
            </n-button>
            <n-button class="filter-action-btn" @click="showCleanDialog = true" type="warning">
              清理旧日志
            </n-button>
          </n-space>
        </template>

        <n-space vertical :size="16">
          <n-data-table
            :columns="columns"
            :data="requests"
            :loading="loading"
            :pagination="pagination"
            :row-key="(row: ApiRequest) => row.id"
            :row-props="rowProps"
            remote
            striped
          />
        </n-space>
      </n-card>
    </n-space>

    <n-drawer v-model:show="showDetail" :width="'65%'" placement="right">
      <n-drawer-content title="请求详情" closable class="request-detail-drawer">
        <n-space vertical :size="20" v-if="selectedRequest">
          <n-card size="small" :bordered="false" class="detail-meta-card">
            <n-descriptions :column="2" bordered size="medium" label-placement="left">
              <n-descriptions-item label="请求 ID" :span="2">
                <n-text code class="detail-code-id">{{ selectedRequest.id }}</n-text>
              </n-descriptions-item>
              <n-descriptions-item label="请求时间">
                {{ formatTimestamp(selectedRequest.created_at) }}
              </n-descriptions-item>
              <n-descriptions-item label="响应时间">
                <n-tag v-if="selectedRequest.response_time" type="info" size="small">
                  {{ selectedRequest.response_time }}ms
                </n-tag>
                <span v-else>-</span>
              </n-descriptions-item>
              <n-descriptions-item label="TFFB">
                <n-tag v-if="selectedRequest.tffb_ms !== null" type="warning" size="small">
                  {{ selectedRequest.tffb_ms }}ms
                </n-tag>
                <span v-else>-</span>
              </n-descriptions-item>
              <n-descriptions-item label="模型">
                <n-text strong>{{ selectedRequest.model || '-' }}</n-text>
              </n-descriptions-item>
              <n-descriptions-item label="状态">
                <n-tag :type="selectedRequest.status === 'success' ? 'success' : 'error'" size="medium">
                  {{ selectedRequest.status === 'success' ? '成功' : '失败' }}
                </n-tag>
              </n-descriptions-item>
              <n-descriptions-item label="输入 Tokens">
                <n-tag type="default" size="small">{{ getTokens(selectedRequest!, 'input') }}</n-tag>
              </n-descriptions-item>
              <n-descriptions-item label="输出 Tokens">
                <n-tag type="default" size="small">{{ getTokens(selectedRequest!, 'output') }}</n-tag>
              </n-descriptions-item>
              <n-descriptions-item label="缓存 Tokens" v-if="selectedRequest.cached_tokens">
                <n-tag type="warning" size="small">{{ selectedRequest.cached_tokens }}</n-tag>
              </n-descriptions-item>
              <n-descriptions-item label="压缩前 Tokens" v-if="selectedRequest.compression_original_tokens">
                <n-tag type="info" size="small">{{ selectedRequest.compression_original_tokens }}</n-tag>
              </n-descriptions-item>
              <n-descriptions-item label="压缩节省 Tokens" v-if="selectedRequest.compression_saved_tokens">
                <n-tag type="success" size="small">{{ selectedRequest.compression_saved_tokens }}</n-tag>
              </n-descriptions-item>
              <n-descriptions-item label="虚拟密钥 ID" v-if="selectedRequest.virtual_key_id">
                <n-text code class="detail-code-id">{{ selectedRequest.virtual_key_id }}</n-text>
              </n-descriptions-item>
              <n-descriptions-item label="提供商 ID" v-if="selectedRequest.provider_id">
                <n-text code class="detail-code-id">{{ selectedRequest.provider_id }}</n-text>
              </n-descriptions-item>
            </n-descriptions>
          </n-card>

          <n-card v-if="selectedRequest.request_body" title="请求体" size="small" hoverable>
            <n-code
              :code="formatJson(selectedRequest.request_body)"
              language="json"
              word-wrap
              class="json-code-block"
            />
          </n-card>

          <n-card v-if="selectedRequest.response_body" title="响应体" size="small" hoverable>
            <n-code
              :code="formatJson(selectedRequest.response_body)"
              language="json"
              word-wrap
              class="json-code-block"
            />
          </n-card>

          <n-card v-if="selectedRequest.error_message" title="错误信息" size="small" hoverable>
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
      title="清理旧日志"
      class="clean-dialog-modal"
      :style="{ maxHeight: '85vh' }"
    >
      <template #default>
        <div class="modal-content-wrapper">
          <n-space vertical :size="16">
            <n-text>删除超过指定天数的请求日志记录</n-text>
            <n-input-number
              v-model:value="cleanDays"
              :min="1"
              :max="365"
              placeholder="保留天数"
              class="clean-days-input"
            >
              <template #suffix>天</template>
            </n-input-number>
          </n-space>
        </div>
      </template>
      <template #action>
        <n-space>
          <n-button @click="showCleanDialog = false">取消</n-button>
          <n-button type="warning" @click="handleCleanLogs" :loading="cleanLoading">
            确认清理
          </n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, h, onMounted, reactive } from 'vue';
import { useMessage, NSpace, NCard, NButton, NDataTable, NTag, NDrawer, NDrawerContent, NDescriptions, NDescriptionsItem, NDatePicker, NSelect, NCode, NModal, NText, NInputNumber, NAlert } from 'naive-ui';
import { apiRequestApi, type ApiRequest } from '@/api/api-request';
import { virtualKeyApi } from '@/api/virtual-key';
import type { DataTableColumns, PaginationProps } from 'naive-ui';
import { formatJson, formatTimestamp } from '@/utils/common';
import { extractRequestPreview, extractResponsePreview } from '@/utils/content-truncator';

const message = useMessage();
const loading = ref(false);
const requests = ref<ApiRequest[]>([]);
const showDetail = ref(false);
const selectedRequest = ref<ApiRequest | null>(null);
const timeRange = ref<[number, number] | null>(null);
const filterStatus = ref<string | undefined>(undefined);
const filterVirtualKeyId = ref<string | undefined>(undefined);
const virtualKeyOptions = ref<Array<{ label: string; value: string }>>([]);
const showCleanDialog = ref(false);
const cleanDays = ref(30);
const cleanLoading = ref(false);

type JsonLike = Record<string, any> | string | null | undefined;

const parseJsonLike = (value: JsonLike): Record<string, any> | null => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const getRequestParams = (row: ApiRequest): Record<string, any> | null => {
  return parseJsonLike(row.request_params_json);
};

const getResponseMeta = (row: ApiRequest): Record<string, any> | null => {
  return parseJsonLike(row.response_meta_json);
};

const previewFromJson = (value: JsonLike): string => {
  const parsed = parseJsonLike(value);
  if (!parsed) return '-';

  const text = JSON.stringify(parsed);
  if (!text) return '-';
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
};

// Token helpers - inline for zero net line change
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
      ? base + (usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0)
      : base
  } catch { return 0 }
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

const getResponsePreview = (row: ApiRequest): string => {
  if (row.response_body) {
    return extractResponsePreview(row.response_body)
  }
  return previewFromJson(getResponseMeta(row))
}

const getModelDisplay = (row: ApiRequest): string => {
  const modelName = row.model || '-'
  if (!row.model) return modelName

  const depth = extractThinkingDepthFromRow(row)
  return depth ? `${row.model} (${depth})` : modelName
}

const handlePageChange = (page: number) => {
  pagination.page = page;
  loadRequests();
};

const handlePageSizeChange = (pageSize: number) => {
  pagination.pageSize = pageSize;
  pagination.page = 1;
  loadRequests();
};

const pagination = reactive<PaginationProps>({
  page: 1,
  pageSize: 20,
  itemCount: 0,
  pageCount: 0,
  pageSizes: [10, 20, 50, 100],
  showSizePicker: true,
  prefix: (info) => `共 ${info.itemCount} 条`,
  onChange: handlePageChange,
  onUpdatePageSize: handlePageSizeChange,
});

const statusOptions = [
  { label: '成功', value: 'success' },
  { label: '失败', value: 'error' },
];

const columns: DataTableColumns<ApiRequest> = [
  {
    title: '请求时间',
    key: 'created_at',
    width: 160,
    render: (row) => h('span', { class: 'table-time' }, formatTimestamp(row.created_at)),
  },
  {
    title: '模型',
    key: 'model',
    width: 190,
    ellipsis: {
      tooltip: true,
    },
    render: (row) => h('span', { class: 'table-model' }, getModelDisplay(row)),
  },
  {
    title: '状态',
    key: 'status',
    width: 70,
    render: (row) => {
      return h(
        NTag,
        {
          type: row.status === 'success' ? 'success' : 'error',
          size: 'small',
        },
        { default: () => (row.status === 'success' ? '成功' : '失败') }
      );
    },
  },
  {
    title: '响应时间',
    key: 'response_time',
    width: 90,
    render: (row) => h('span', { class: row.response_time ? 'table-latency' : 'table-placeholder' }, row.response_time ? `${row.response_time}ms` : '-'),
  },
  {
    title: 'TFFB',
    key: 'tffb_ms',
    width: 90,
    render: (row) => h('span', { class: row.tffb_ms !== null ? 'table-latency' : 'table-placeholder' }, row.tffb_ms !== null ? `${row.tffb_ms}ms` : '-'),
  },
  {
    title: 'Tokens',
    key: 'tokens',
    width: 180,
    render: (row) => {
      const items = [
        h('div', { class: 'token-line' }, `输入: ${getTokens(row, 'input')}`),
        h('div', { class: 'token-line' }, `输出: ${getTokens(row, 'output')}`),
      ];

      if (row.compression_saved_tokens && row.compression_saved_tokens > 0) {
        items.push(
          h('div', { class: 'token-line token-line-saving' }, `节省: ${row.compression_saved_tokens}`)
        );
      }

      return h(
        NSpace,
        { vertical: true, size: 2 },
        { default: () => items }
      );
    },
  },
  {
    title: '请求预览',
    key: 'request_body',
    width: 200,
    ellipsis: {
      tooltip: true,
    },
    render: (row) => h('span', { class: 'table-preview' }, getRequestPreview(row)),
  },
  {
    title: '响应预览',
    key: 'response_body',
    width: 200,
    ellipsis: {
      tooltip: true,
    },
    render: (row) => h('span', { class: 'table-preview' }, getResponsePreview(row)),
  },
];


const loadRequests = async () => {
  loading.value = true;
  try {
    const params: any = {
      page: pagination.page,
      pageSize: pagination.pageSize,
    };

    if (timeRange.value) {
      params.startTime = timeRange.value[0];
      params.endTime = timeRange.value[1];
    }

    if (filterStatus.value) {
      params.status = filterStatus.value;
    }

    if (filterVirtualKeyId.value) {
      params.virtualKeyId = filterVirtualKeyId.value;
    }

    const response = await apiRequestApi.getAll(params);
    requests.value = response.data;
    pagination.itemCount = response.total;
    pagination.pageCount = response.totalPages;
  } catch (error: any) {
    message.error(error.message || '加载请求日志失败');
  } finally {
    loading.value = false;
  }
};

const handleTimeRangeChange = () => {
  pagination.page = 1;
  loadRequests();
};

const handleViewDetail = async (request: ApiRequest) => {
  loading.value = true;
  try {
    selectedRequest.value = await apiRequestApi.getById(request.id);
    showDetail.value = true;
  } catch (error: any) {
    message.error(error.message || '加载请求详情失败');
  } finally {
    loading.value = false;
  }
};

const rowProps = (row: ApiRequest) => {
  return {
    style: 'cursor: pointer;',
    onClick: () => handleViewDetail(row),
  };
};

const handleCleanLogs = async () => {
  cleanLoading.value = true;
  try {
    const result = await apiRequestApi.clean(cleanDays.value);
    message.success(result.message);
    showCleanDialog.value = false;
    loadRequests();
  } catch (error: any) {
    message.error(error.message || '清理日志失败');
  } finally {
    cleanLoading.value = false;
  }
};

const loadVirtualKeys = async () => {
  try {
    const response = await virtualKeyApi.getAll();
    virtualKeyOptions.value = response.virtualKeys.map(vk => ({
      label: `${vk.name} (${vk.keyValue.substring(0, 20)}...)`,
      value: vk.id,
    }));
  } catch (error: any) {
    message.error(error.message || '加载虚拟密钥列表失败');
  }
};
onMounted(() => {
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  timeRange.value = [oneDayAgo, now];
  loadVirtualKeys();
  loadRequests();
});
</script>

<style scoped>
.card-title {
  font-size: 20px;
  font-weight: 600;
  color: #1e3932;
  letter-spacing: -0.015em;
  line-height: 1.3;
  white-space: nowrap;
  display: inline-block;
}

.filter-toolbar {
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px;
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

.filter-status-select {
  width: 120px;
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

.token-line {
  font-size: 12px;
  color: #4b5563;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
}

.token-line-saving {
  color: #0f6b4a;
  font-weight: 600;
}

.clean-dialog-modal .modal-content-wrapper {
  max-height: calc(85vh - 200px);
  overflow-y: auto;
  overflow-x: hidden;
}

.modal-content-wrapper::-webkit-scrollbar {
  width: 6px;
}

.modal-content-wrapper::-webkit-scrollbar-track {
  background: #f0f0f0;
  border-radius: 3px;
}

.modal-content-wrapper::-webkit-scrollbar-thumb {
  background: #d0d0d0;
  border-radius: 3px;
}

.modal-content-wrapper::-webkit-scrollbar-thumb:hover {
  background: #b0b0b0;
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
  color: #1e3932;
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
}

@media (max-width: 768px) {
  .card-title {
    font-size: 18px;
  }

  .filter-toolbar {
    justify-content: flex-start;
  }

  .filter-date-picker,
  .filter-key-select,
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

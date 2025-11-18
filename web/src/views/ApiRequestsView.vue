<template>
  <div>
    <n-space vertical :size="24">
      <n-card title="API 请求日志">
        <template #header-extra>
          <n-space>
            <n-date-picker
              v-model:value="timeRange"
              type="datetimerange"
              clearable
              style="width: 360px;"
              @update:value="handleTimeRangeChange"
            />
            <n-select
              v-model:value="filterVirtualKeyId"
              :options="virtualKeyOptions"
              style="width: 200px;"
              placeholder="虚拟密钥"
              clearable
              filterable
              @update:value="loadRequests"
            />
            <n-select
              v-model:value="filterStatus"
              :options="statusOptions"
              style="width: 120px;"
              placeholder="状态"
              clearable
              @update:value="loadRequests"
            />
            <n-button @click="loadRequests" :loading="loading">
              刷新
            </n-button>
            <n-button @click="showCleanDialog = true" type="warning">
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
      <n-drawer-content title="请求详情" closable>
        <n-space vertical :size="20" v-if="selectedRequest">
          <n-card size="small" :bordered="false" style="background: #fafafa;">
            <n-descriptions :column="2" bordered size="medium" label-placement="left">
              <n-descriptions-item label="请求 ID" :span="2">
                <n-text code style="word-break: break-all;">{{ selectedRequest.id }}</n-text>
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
              <n-descriptions-item label="模型">
                <n-text strong>{{ selectedRequest.model || '-' }}</n-text>
              </n-descriptions-item>
              <n-descriptions-item label="状态">
                <n-tag :type="selectedRequest.status === 'success' ? 'success' : 'error'" size="medium">
                  {{ selectedRequest.status === 'success' ? '成功' : '失败' }}
                </n-tag>
              </n-descriptions-item>
              <n-descriptions-item label="输入 Tokens">
                <n-tag type="default" size="small">{{ getInputTokens(selectedRequest as ApiRequest) }}</n-tag>
              </n-descriptions-item>
              <n-descriptions-item label="输出 Tokens">
                <n-tag type="default" size="small">{{ getOutputTokens(selectedRequest as ApiRequest) }}</n-tag>
              </n-descriptions-item>
              <n-descriptions-item label="压缩前 Tokens" v-if="selectedRequest.compression_original_tokens">
                <n-tag type="info" size="small">{{ selectedRequest.compression_original_tokens }}</n-tag>
              </n-descriptions-item>
              <n-descriptions-item label="压缩节省 Tokens" v-if="selectedRequest.compression_saved_tokens">
                <n-tag type="success" size="small">{{ selectedRequest.compression_saved_tokens }}</n-tag>
              </n-descriptions-item>
              <n-descriptions-item label="虚拟密钥 ID" v-if="selectedRequest.virtual_key_id">
                <n-text code style="word-break: break-all;">{{ selectedRequest.virtual_key_id }}</n-text>
              </n-descriptions-item>
              <n-descriptions-item label="提供商 ID" v-if="selectedRequest.provider_id">
                <n-text code style="word-break: break-all;">{{ selectedRequest.provider_id }}</n-text>
              </n-descriptions-item>
            </n-descriptions>
          </n-card>

          <n-card v-if="selectedRequest.request_body" title="请求体" size="small" hoverable>
            <n-code
              :code="formatJson(selectedRequest.request_body)"
              language="json"
              word-wrap
              style="max-height: 400px; overflow-y: auto;"
            />
          </n-card>

          <n-card v-if="selectedRequest.response_body" title="响应体" size="small" hoverable>
            <n-code
              :code="formatJson(selectedRequest.response_body)"
              language="json"
              word-wrap
              style="max-height: 400px; overflow-y: auto;"
            />
          </n-card>

          <n-card v-if="selectedRequest.error_message" title="错误信息" size="small" hoverable>
            <n-alert type="error" style="word-break: break-word; white-space: pre-wrap;">
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
              style="width: 100%;"
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

// ---- Token display helpers (fallback to response_body.usage when DB columns are 0) ----
function parseUsageFromBody(body: string | null): any | null {
  if (!body) return null;
  try {
    return JSON.parse(body)?.usage ?? null;
  } catch {
    return null;
  }
}

function getInputTokensFromUsage(usage: any): number {
  const base = (usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
  const cached =
    (usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0);
  return base === 0 ? base + cached : base;
}

function getOutputTokensFromUsage(usage: any): number {
  return usage?.output_tokens ?? usage?.completion_tokens ?? 0;
}

function getInputTokens(row: ApiRequest): number {
  if (row?.prompt_tokens && row.prompt_tokens > 0) return row.prompt_tokens;
  const usage = parseUsageFromBody(row?.response_body || null);
  return usage ? getInputTokensFromUsage(usage) : 0;
}

function getOutputTokens(row: ApiRequest): number {
  if (row?.completion_tokens && row.completion_tokens > 0) return row.completion_tokens;
  const usage = parseUsageFromBody(row?.response_body || null);
  return usage ? getOutputTokensFromUsage(usage) : 0;
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
    render: (row) => formatTimestamp(row.created_at),
  },
  {
    title: '模型',
    key: 'model',
    width: 140,
    ellipsis: {
      tooltip: true,
    },
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
    render: (row) => (row.response_time ? `${row.response_time}ms` : '-'),
  },
  {
    title: 'Tokens',
    key: 'tokens',
    width: 180,
    render: (row) => {
      const items = [
        h('div', { style: 'font-size: 12px; color: #666;' }, `输入: ${getInputTokens(row)}`),
        h('div', { style: 'font-size: 12px; color: #666;' }, `输出: ${getOutputTokens(row)}`),
      ];

      if (row.compression_saved_tokens && row.compression_saved_tokens > 0) {
        items.push(
          h('div', { style: 'font-size: 12px; color: #18a058; font-weight: 500;' }, `节省: ${row.compression_saved_tokens}`)
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
    render: (row) => extractRequestPreview(row.request_body),
  },
  {
    title: '响应预览',
    key: 'response_body',
    width: 200,
    ellipsis: {
      tooltip: true,
    },
    render: (row) => extractResponsePreview(row.response_body),
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

const handleViewDetail = (request: ApiRequest) => {
  selectedRequest.value = request;
  showDetail.value = true;
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

:deep(.n-data-table-th) {
  font-size: 13px;
  padding: 10px 12px;
  font-weight: 600;
}

:deep(.n-data-table-td) {
  font-size: 13px;
  padding: 10px 12px;
}

:deep(.n-data-table-tr) {
  height: 40px;
  transition: background-color 0.2s;
}

:deep(.n-data-table-tr:hover) {
  background-color: rgba(0, 0, 0, 0.02);
}

:deep(.n-button--small-type) {
  font-size: 12px;
  padding: 4px 10px;
  height: 28px;
}

:deep(.n-tag--small-size) {
  font-size: 12px;
  padding: 2px 8px;
  height: 24px;
  line-height: 20px;
}

:deep(.n-code) {
  word-break: break-word;
  white-space: pre-wrap;
}

:deep(.n-descriptions-table-content__label) {
  font-weight: 500;
}

:deep(.n-card.n-card--hoverable:hover) {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}
</style>


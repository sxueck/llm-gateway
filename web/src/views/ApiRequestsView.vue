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
            @update:page="handlePageChange"
            @update:page-size="handlePageSizeChange"
          />
        </n-space>
      </n-card>
    </n-space>

    <n-drawer v-model:show="showDetail" :width="'60%'" placement="right">
      <n-drawer-content title="请求详情" closable>
        <n-space vertical :size="16" v-if="selectedRequest">
          <n-descriptions :column="1" bordered size="small">
            <n-descriptions-item label="请求 ID">
              {{ selectedRequest.id }}
            </n-descriptions-item>
            <n-descriptions-item label="请求时间">
              {{ formatTimestamp(selectedRequest.created_at) }}
            </n-descriptions-item>
            <n-descriptions-item label="模型">
              {{ selectedRequest.model || '-' }}
            </n-descriptions-item>
            <n-descriptions-item label="状态">
              <n-tag :type="selectedRequest.status === 'success' ? 'success' : 'error'" size="small">
                {{ selectedRequest.status === 'success' ? '成功' : '失败' }}
              </n-tag>
            </n-descriptions-item>
            <n-descriptions-item label="响应时间">
              {{ selectedRequest.response_time ? `${selectedRequest.response_time}ms` : '-' }}
            </n-descriptions-item>
            <n-descriptions-item label="提示词 Tokens">
              {{ selectedRequest.prompt_tokens }}
            </n-descriptions-item>
            <n-descriptions-item label="完成 Tokens">
              {{ selectedRequest.completion_tokens }}
            </n-descriptions-item>
            <n-descriptions-item label="总 Tokens">
              {{ selectedRequest.total_tokens }}
            </n-descriptions-item>
            <n-descriptions-item label="虚拟密钥 ID">
              {{ selectedRequest.virtual_key_id || '-' }}
            </n-descriptions-item>
            <n-descriptions-item label="提供商 ID">
              {{ selectedRequest.provider_id || '-' }}
            </n-descriptions-item>
          </n-descriptions>

          <n-card v-if="selectedRequest.request_body" title="请求体" size="small">
            <n-code :code="formatJson(selectedRequest.request_body)" language="json" />
          </n-card>

          <n-card v-if="selectedRequest.response_body" title="响应体" size="small">
            <n-code :code="formatJson(selectedRequest.response_body)" language="json" />
          </n-card>

          <n-card v-if="selectedRequest.error_message" title="错误信息" size="small">
            <n-code :code="formatJson(selectedRequest.error_message)" language="json" />
          </n-card>
        </n-space>
      </n-drawer-content>
    </n-drawer>

    <n-modal v-model:show="showCleanDialog" preset="dialog" title="清理旧日志">
      <template #default>
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
import { useMessage, NSpace, NCard, NButton, NDataTable, NTag, NDrawer, NDrawerContent, NDescriptions, NDescriptionsItem, NDatePicker, NSelect, NCode, NModal, NText, NInputNumber } from 'naive-ui';
import { apiRequestApi, type ApiRequest } from '@/api/api-request';
import type { DataTableColumns, PaginationProps } from 'naive-ui';
import { formatJson, formatTimestamp } from '@/utils/common';

const message = useMessage();
const loading = ref(false);
const requests = ref<ApiRequest[]>([]);
const showDetail = ref(false);
const selectedRequest = ref<ApiRequest | null>(null);
const timeRange = ref<[number, number] | null>(null);
const filterStatus = ref<string | undefined>(undefined);
const showCleanDialog = ref(false);
const cleanDays = ref(30);
const cleanLoading = ref(false);

const pagination = reactive<PaginationProps>({
  page: 1,
  pageSize: 20,
  itemCount: 0,
  pageSizes: [10, 20, 50, 100],
  showSizePicker: true,
  prefix: (info) => `共 ${info.itemCount} 条`,
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
    key: 'total_tokens',
    width: 80,
    render: (row) => row.total_tokens || 0,
  },
  {
    title: '请求预览',
    key: 'request_body',
    width: 200,
    ellipsis: {
      tooltip: true,
    },
    render: (row) => {
      if (!row.request_body) return '-';
      try {
        const parsed = JSON.parse(row.request_body);
        const preview = parsed.model || parsed.messages?.[0]?.content?.substring(0, 50) || '...';
        return preview.length > 50 ? preview.substring(0, 50) + '...' : preview;
      } catch {
        return row.request_body.substring(0, 50) + '...';
      }
    },
  },
  {
    title: '响应预览',
    key: 'response_body',
    width: 200,
    ellipsis: {
      tooltip: true,
    },
    render: (row) => {
      if (!row.response_body) return '-';
      try {
        const parsed = JSON.parse(row.response_body);
        const content = parsed.choices?.[0]?.message?.content || parsed.error?.message || '...';
        return content.length > 50 ? content.substring(0, 50) + '...' : content;
      } catch {
        return row.response_body.substring(0, 50) + '...';
      }
    },
  },
  {
    title: '操作',
    key: 'actions',
    width: 80,
    fixed: 'right',
    render: (row) => {
      return h(
        NButton,
        {
          size: 'small',
          onClick: () => handleViewDetail(row),
        },
        { default: () => '详情' }
      );
    },
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

    const response = await apiRequestApi.getAll(params);
    requests.value = response.data;
    pagination.itemCount = response.total;
  } catch (error: any) {
    message.error(error.message || '加载请求日志失败');
  } finally {
    loading.value = false;
  }
};

const handlePageChange = (page: number) => {
  pagination.page = page;
  loadRequests();
};

const handlePageSizeChange = (pageSize: number) => {
  pagination.pageSize = pageSize;
  pagination.page = 1;
  loadRequests();
};

const handleTimeRangeChange = () => {
  pagination.page = 1;
  loadRequests();
};

const handleViewDetail = (request: ApiRequest) => {
  selectedRequest.value = request;
  showDetail.value = true;
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

onMounted(() => {
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  timeRange.value = [oneDayAgo, now];
  loadRequests();
});
</script>

<style scoped>
</style>


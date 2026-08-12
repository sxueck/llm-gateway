<script setup lang="ts">
import { h, onMounted, reactive, ref } from 'vue';
import type { DataTableColumns, PaginationProps } from 'naive-ui';
import { NButton, NDataTable, NPopconfirm, NTag, NText, useMessage } from 'naive-ui';
import { promptSampleApi, type PromptSample } from '@/api/prompt-sample';
import { virtualKeyApi } from '@/api/virtual-key';
import { formatTimestamp } from '@/utils/common';

const message = useMessage();
const loading = ref(false);
const downloading = ref<'' | 'csv' | 'json'>('');
const cleaning = ref(false);
const samples = ref<PromptSample[]>([]);
const timeRange = ref<[number, number] | null>(null);
const virtualKeyId = ref<string | undefined>();
const virtualKeyOptions = ref<Array<{ label: string; value: string }>>([]);

const pagination = reactive<PaginationProps>({
  page: 1,
  pageSize: 20,
  itemCount: 0,
  pageSizes: [10, 20, 50, 100],
  showSizePicker: true,
  prefix: info => `共 ${info.itemCount} 条`,
  onChange: page => {
    pagination.page = page;
    void loadSamples();
  },
  onUpdatePageSize: pageSize => {
    pagination.pageSize = pageSize;
    pagination.page = 1;
    void loadSamples();
  },
});

function queryParams() {
  return {
    virtualKeyId: virtualKeyId.value,
    startTime: timeRange.value?.[0],
    endTime: timeRange.value?.[1],
    page: pagination.page,
    pageSize: pagination.pageSize,
  };
}

async function loadSamples() {
  loading.value = true;
  try {
    const result = await promptSampleApi.getAll(queryParams());
    samples.value = result.data;
    pagination.itemCount = result.total;
  } catch (error: any) {
    message.error(error.message);
  } finally {
    loading.value = false;
  }
}

function refreshFromFilter() {
  pagination.page = 1;
  void loadSamples();
}

async function deleteSample(id: string) {
  try {
    await promptSampleApi.delete(id);
    message.success('已删除样本');
    await loadSamples();
  } catch (error: any) {
    message.error(error.message);
  }
}

async function cleanSamples() {
  cleaning.value = true;
  try {
    const result = await promptSampleApi.clean();
    message.success(result.message);
    await loadSamples();
  } catch (error: any) {
    message.error(error.message);
  } finally {
    cleaning.value = false;
  }
}

async function downloadSamples(format: 'csv' | 'json') {
  if ((pagination.itemCount || 0) > 10_000) {
    message.warning(`${format.toUpperCase()} 最多导出最新 10000 条匹配样本`);
  }
  downloading.value = format;
  try {
    const { page: _page, pageSize: _pageSize, ...filters } = queryParams();
    const blob = format === 'json'
      ? await promptSampleApi.exportJson(filters)
      : await promptSampleApi.exportCsv(filters);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `prompt-samples.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (error: any) {
    message.error(error.message);
  } finally {
    downloading.value = '';
  }
}

const columns: DataTableColumns<PromptSample> = [
  {
    title: '捕获时间',
    key: 'created_at',
    width: 165,
    render: row => formatTimestamp(row.created_at),
  },
  {
    title: '虚拟密钥',
    key: 'virtual_key_id',
    width: 180,
    ellipsis: { tooltip: true },
    render: row => virtualKeyOptions.value.find(option => option.value === row.virtual_key_id)?.label || row.virtual_key_id,
  },
  { title: '模型', key: 'model', width: 160, ellipsis: { tooltip: true } },
  { title: '协议', key: 'protocol', width: 90, render: row => h(NTag, { size: 'small' }, { default: () => row.protocol }) },
  { title: 'Tokens', key: 'prompt_tokens', width: 85 },
  {
    title: 'Prompt',
    key: 'intent_text',
    ellipsis: { tooltip: true },
    render: row => h(NText, { depth: 2 }, { default: () => row.intent_text }),
  },
  {
    title: '操作',
    key: 'actions',
    width: 80,
    render: row => h(NPopconfirm, { onPositiveClick: () => deleteSample(row.id) }, {
      trigger: () => h(NButton, { size: 'small', type: 'error', tertiary: true }, { default: () => '删除' }),
      default: () => '确定删除此 Prompt 样本吗？',
    }),
  },
];

onMounted(async () => {
  try {
    const result = await virtualKeyApi.getAll();
    virtualKeyOptions.value = result.virtualKeys.map(key => ({ label: key.name, value: key.id }));
  } catch (error: any) {
    message.error(error.message);
  }
  await loadSamples();
});
</script>

<template>
  <div class="prompt-samples-view">
    <n-card>
      <template #header>Prompt 样本</template>
      <template #header-extra>
        <n-space class="filter-toolbar">
          <n-date-picker v-model:value="timeRange" type="datetimerange" clearable @update:value="refreshFromFilter" />
          <n-select
            v-model:value="virtualKeyId"
            :options="virtualKeyOptions"
            placeholder="虚拟密钥"
            clearable
            filterable
            class="key-filter"
            @update:value="refreshFromFilter"
          />
          <n-button :loading="loading" @click="loadSamples">刷新</n-button>
          <n-popconfirm @positive-click="cleanSamples">
            <template #trigger>
              <n-button type="warning" :loading="cleaning">清理 30 天前</n-button>
            </template>
            确定删除超过 30 天的 Prompt 样本吗？
          </n-popconfirm>
          <n-button type="primary" :loading="downloading === 'csv'" @click="downloadSamples('csv')">下载 CSV</n-button>
          <n-button type="primary" :loading="downloading === 'json'" @click="downloadSamples('json')">下载 JSON</n-button>
        </n-space>
      </template>
      <n-alert type="info" :bordered="false" class="notice">
        仅捕获在虚拟密钥中明确开启此功能后的请求；已启用 PII 保护的密钥会存储脱敏后的文本。CSV / JSON 最多导出最新 10000 条匹配样本，仅包含提问意图（不含模型回复）。
      </n-alert>
      <n-data-table
        :columns="columns"
        :data="samples"
        :loading="loading"
        :pagination="pagination"
        :row-key="row => row.id"
        remote
        striped
      />
    </n-card>
  </div>
</template>

<style scoped>
.prompt-samples-view {
  max-width: 1440px;
  margin: 0 auto;
}

.filter-toolbar {
  flex-wrap: wrap;
}

.key-filter {
  width: 180px;
}

.notice {
  margin-bottom: 16px;
}
</style>

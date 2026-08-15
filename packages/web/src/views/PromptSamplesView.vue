<script setup lang="ts">
import { h, onMounted, reactive, ref } from 'vue'
import type { DataTableColumns, PaginationProps } from 'naive-ui'
import {
  NButton,
  NDataTable,
  NDropdown,
  NIcon,
  NPopconfirm,
  NTag,
  NText,
  useMessage
} from 'naive-ui'
import { DownloadOutline } from '@vicons/ionicons5'
import { promptSampleApi, type PromptSample } from '@/api/prompt-sample'
import { virtualKeyApi } from '@/api/virtual-key'
import { formatTimestamp } from '@/utils/common'

const message = useMessage()
const loading = ref(false)
const downloading = ref<'' | 'csv' | 'json' | 'all'>('')
const cleaning = ref(false)
const samples = ref<PromptSample[]>([])
const timeRange = ref<[number, number] | null>(null)
const virtualKeyId = ref<string | undefined>()
const virtualKeyOptions = ref<Array<{ label: string; value: string }>>([])

const EXPORT_LIMIT = 10_000

const downloadOptions = [
  { label: '下载 CSV', key: 'csv' as const },
  { label: '下载 JSON', key: 'json' as const },
  { label: '全部下载（CSV + JSON）', key: 'all' as const }
]

const pagination = reactive<PaginationProps>({
  page: 1,
  pageSize: 20,
  itemCount: 0,
  pageSizes: [10, 20, 50, 100],
  showSizePicker: true,
  prefix: info => `共 ${info.itemCount} 条`,
  onChange: page => {
    pagination.page = page
    void loadSamples()
  },
  onUpdatePageSize: pageSize => {
    pagination.pageSize = pageSize
    pagination.page = 1
    void loadSamples()
  }
})

function queryParams() {
  return {
    virtualKeyId: virtualKeyId.value,
    startTime: timeRange.value?.[0],
    endTime: timeRange.value?.[1],
    page: pagination.page,
    pageSize: pagination.pageSize
  }
}

// Monotonic request id + pending counter: drop stale responses and keep the
// spinner on until the latest load settles.
let loadSeq = 0
let pendingLoads = 0

async function loadSamples() {
  const seq = ++loadSeq
  pendingLoads++
  loading.value = true
  try {
    const result = await promptSampleApi.getAll(queryParams())
    if (seq !== loadSeq) return
    // After delete/clean the stored page may exceed the last page; re-fetch once.
    const maxPage = Math.max(1, Math.ceil(result.total / (pagination.pageSize ?? 10)))
    if ((pagination.page ?? 1) > maxPage) {
      pagination.page = maxPage
      void loadSamples()
      return
    }
    samples.value = result.data
    pagination.itemCount = result.total
  } catch (error: any) {
    if (seq === loadSeq) message.error(error.message)
  } finally {
    pendingLoads--
    if (pendingLoads === 0) loading.value = false
  }
}

function refreshFromFilter() {
  pagination.page = 1
  void loadSamples()
}

async function deleteSample(id: string) {
  try {
    await promptSampleApi.delete(id)
    message.success('已删除样本')
    await loadSamples()
  } catch (error: any) {
    message.error(error.message)
  }
}

async function cleanSamples() {
  cleaning.value = true
  try {
    const result = await promptSampleApi.clean()
    message.success(result.message)
    await loadSamples()
  } catch (error: any) {
    message.error(error.message)
  } finally {
    cleaning.value = false
  }
}

function handleDownloadSelect(key: string | number) {
  void downloadSamples(key as 'csv' | 'json' | 'all')
}

function saveBlob(blob: Blob, format: 'csv' | 'json') {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `prompt-samples.${format}`
  anchor.click()
  URL.revokeObjectURL(url)
}

async function downloadSamples(format: 'csv' | 'json' | 'all') {
  if ((pagination.itemCount || 0) > EXPORT_LIMIT) {
    message.warning(`每种格式最多导出最新 ${EXPORT_LIMIT} 条匹配样本`)
  }
  downloading.value = format
  try {
    const { virtualKeyId: key, startTime, endTime } = queryParams()
    const filters = { virtualKeyId: key, startTime, endTime }
    const formats = format === 'all' ? (['csv', 'json'] as const) : ([format] as const)
    for (const item of formats) {
      const blob =
        item === 'json'
          ? await promptSampleApi.exportJson(filters)
          : await promptSampleApi.exportCsv(filters)
      saveBlob(blob, item)
    }
  } catch (error: any) {
    message.error(error.message)
  } finally {
    downloading.value = ''
  }
}

const columns: DataTableColumns<PromptSample> = [
  {
    title: '捕获时间',
    key: 'created_at',
    width: 165,
    render: row => formatTimestamp(row.created_at)
  },
  {
    title: '虚拟密钥',
    key: 'virtual_key_id',
    width: 180,
    ellipsis: { tooltip: true },
    render: row =>
      virtualKeyOptions.value.find(option => option.value === row.virtual_key_id)?.label ||
      row.virtual_key_id
  },
  { title: '模型', key: 'model', width: 160, ellipsis: { tooltip: true } },
  {
    title: '协议',
    key: 'protocol',
    width: 90,
    render: row => h(NTag, { size: 'small' }, { default: () => row.protocol })
  },
  { title: 'Tokens', key: 'prompt_tokens', width: 85 },
  {
    title: 'Prompt',
    key: 'intent_text',
    ellipsis: { tooltip: true },
    render: row => h(NText, { depth: 2 }, { default: () => row.intent_text })
  },
  {
    title: '操作',
    key: 'actions',
    width: 80,
    render: row =>
      h(
        NPopconfirm,
        { onPositiveClick: () => deleteSample(row.id) },
        {
          trigger: () =>
            h(NButton, { size: 'small', type: 'error', tertiary: true }, { default: () => '删除' }),
          default: () => '确定删除此 Prompt 样本吗？'
        }
      )
  }
]

onMounted(async () => {
  try {
    const result = await virtualKeyApi.getAll()
    virtualKeyOptions.value = result.virtualKeys.map(key => ({ label: key.name, value: key.id }))
  } catch (error: any) {
    message.error(error.message)
  }
  await loadSamples()
})
</script>

<template>
  <div class="prompt-samples-view">
    <n-card>
      <template #header>
        <span class="card-title">Prompt 样本</span>
      </template>
      <template #header-extra>
        <n-space class="filter-toolbar">
          <n-date-picker
            v-model:value="timeRange"
            type="datetimerange"
            clearable
            class="filter-control filter-date-picker"
            @update:value="refreshFromFilter"
          />
          <n-select
            v-model:value="virtualKeyId"
            :options="virtualKeyOptions"
            placeholder="虚拟密钥"
            clearable
            filterable
            class="filter-control filter-key-select"
            @update:value="refreshFromFilter"
          />
          <n-button class="filter-action-btn" :loading="loading" @click="loadSamples">
            刷新
          </n-button>
          <n-popconfirm @positive-click="cleanSamples">
            <template #trigger>
              <n-button class="filter-action-btn" type="warning" :loading="cleaning">
                清理 30 天前
              </n-button>
            </template>
            确定删除超过 30 天的 Prompt 样本吗？
          </n-popconfirm>
          <n-dropdown :options="downloadOptions" trigger="click" @select="handleDownloadSelect">
            <n-button class="filter-action-btn" type="primary" :loading="downloading !== ''">
              <template #icon>
                <n-icon><DownloadOutline /></n-icon>
              </template>
              批量下载样本
            </n-button>
          </n-dropdown>
        </n-space>
      </template>
      <n-alert type="info" :bordered="false" class="notice">
        仅捕获在虚拟密钥中明确开启此功能后的请求；已启用 PII
        保护的密钥会存储脱敏后的文本。批量下载每种格式最多导出最新 10000
        条匹配样本，仅包含提问意图（不含模型回复）。
      </n-alert>
      <n-data-table
        :columns="columns"
        :data="samples"
        :loading="loading"
        :pagination="pagination"
        :row-key="row => row.id"
        :scroll-x="1100"
        remote
        striped
      />
    </n-card>
  </div>
</template>

<style scoped>
.prompt-samples-view {
  max-width: 1400px;
  margin: 0 auto;
}

.card-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--color-title);
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
  width: 180px;
}

.filter-action-btn {
  font-weight: 500;
  letter-spacing: 0.01em;
}

.notice {
  margin-bottom: 16px;
}

@media (max-width: 1024px) {
  .filter-date-picker {
    width: 320px;
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
  .filter-key-select {
    width: 100%;
  }
}
</style>

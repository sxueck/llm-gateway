<template>
  <div class="my-virtual-keys-view">
    <n-space vertical :size="12">
      <PageHeader
        eyebrow="ACCESS"
        :title="t('myKeys.title')"
        :subtitle="t('myKeys.subtitle')"
      >
        <template #actions>
          <n-button secondary round :loading="loading" @click="load">
            <template #icon>
              <n-icon><RefreshOutlined /></n-icon>
            </template>
            {{ t('common.refresh') }}
          </n-button>
        </template>
      </PageHeader>

      <n-card class="table-card">
        <div class="table-toolbar">
          <n-input
            v-model:value="searchText"
            :placeholder="t('common.searchPlaceholder')"
            clearable
            size="small"
            style="width: 260px"
          >
            <template #prefix>
              <n-icon :component="SearchOutlined" />
            </template>
          </n-input>
          <n-select
            v-model:value="enabledFilter"
            :options="enabledOptions"
            size="small"
            style="width: 140px"
          />
        </div>

        <n-data-table
          :columns="columns"
          :data="filteredKeys"
          :loading="loading"
          :pagination="pagination"
          :row-key="rowKeyOf"
          :bordered="false"
          size="small"
        />
      </n-card>
    </n-space>

    <n-drawer v-model:show="showDrawer" :width="480" placement="right">
      <n-drawer-content :title="t('virtualKeys.drawerTitle')" closable>
        <div v-if="drawerKey" class="drawer-body">
          <n-divider title-placement="left" class="form-section">
            {{ t('virtualKeys.sectionBasic') }}
          </n-divider>
          <div class="detail-row">
            <span class="detail-label">{{ t('virtualKeys.keyName') }}</span>
            <span class="detail-value">{{ drawerKey.name }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ t('virtualKeys.fieldKeyValue') }}</span>
            <span class="detail-value key-mono">{{ drawerKey.keyValue }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ t('virtualKeys.colStatus') }}</span>
            <span class="detail-value">
              {{ drawerKey.enabled ? t('virtualKeys.filterEnabled') : t('virtualKeys.filterDisabled') }}
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ t('virtualKeys.fieldRateLimit') }}</span>
            <span class="detail-value">
              {{
                drawerKey.rateLimit
                  ? t('virtualKeys.rateLimitPerMin', { n: drawerKey.rateLimit })
                  : '-'
              }}
            </span>
          </div>

          <n-divider title-placement="left" class="form-section">
            {{ t('virtualKeys.sectionModels') }}
          </n-divider>
          <n-space :size="4" wrap>
            <n-tag v-for="modelId in collectBoundModelIds(drawerKey)" :key="modelId" size="small">
              {{ modelId }}
            </n-tag>
            <span v-if="collectBoundModelIds(drawerKey).length === 0">-</span>
          </n-space>

          <n-divider title-placement="left" class="form-section">
            {{ t('virtualKeys.sectionMeta') }}
          </n-divider>
          <div class="detail-row">
            <span class="detail-label">{{ t('virtualKeys.fieldCreatedAt') }}</span>
            <span class="detail-value">{{ formatDateTime(drawerKey.createdAt) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ t('virtualKeys.fieldUpdatedAt') }}</span>
            <span class="detail-value">{{ formatDateTime(drawerKey.updatedAt) }}</span>
          </div>

          <n-button size="small" @click="goToRequests(drawerKey.id)">
            <template #icon>
              <n-icon :component="OpenInNewOutlined" />
            </template>
            {{ t('virtualKeys.viewRequests') }}
          </n-button>
        </div>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import type { DataTableColumns, PaginationProps } from 'naive-ui'
import {
  NButton,
  NCard,
  NDataTable,
  NDrawer,
  NDrawerContent,
  NDivider,
  NIcon,
  NInput,
  NSelect,
  NSpace,
  NTag,
} from 'naive-ui'
import { ExternalLink as OpenInNewOutlined } from 'lucide-vue-next'
import { RefreshCw as RefreshOutlined, Search as SearchOutlined } from 'lucide-vue-next'
import { meApi } from '@/api/me'
import type { VirtualKey } from '@/types'
import { formatDateTime } from '@/utils/date'
import { collectBoundModelIds, filterVirtualKeys } from '@/utils/virtual-key-helpers'
import type { VirtualKeyEnabledFilter } from '@/utils/virtual-key-helpers'
import PageHeader from '@/components/PageHeader.vue'

const message = useMessage()
const router = useRouter()
const { t } = useI18n()

const loading = ref(false)
const virtualKeys = ref<VirtualKey[]>([])
const searchText = ref('')
const enabledFilter = ref<VirtualKeyEnabledFilter>('all')

// 只读视图：/api/me 只规划了 GET，签发/轮换/启停都属于管理员操作
async function load() {
  loading.value = true
  try {
    const response = await meApi.getVirtualKeys()
    virtualKeys.value = response.virtualKeys
  } catch (error: any) {
    message.error(error?.message || t('myKeys.loadFailed'))
  } finally {
    loading.value = false
  }
}

const enabledOptions = computed(() => [
  { label: t('virtualKeys.filterAll'), value: 'all' },
  { label: t('virtualKeys.filterEnabled'), value: 'enabled' },
  { label: t('virtualKeys.filterDisabled'), value: 'disabled' },
])

watch([searchText, enabledFilter], () => {
  // 过滤后保留旧页码可能落在空页上
  pagination.page = 1
})

const filteredKeys = computed(() =>
  filterVirtualKeys(virtualKeys.value, {
    search: searchText.value,
    enabled: enabledFilter.value,
  }),
)

const pagination = reactive<PaginationProps>({
  page: 1,
  pageSize: 10,
  pageSizes: [10, 20, 50],
  showSizePicker: true,
  prefix: (info) => t('common.totalCount', { count: info.itemCount ?? 0 }),
  onUpdatePage: (page: number) => {
    pagination.page = page
  },
  onUpdatePageSize: (pageSize: number) => {
    pagination.pageSize = pageSize
    pagination.page = 1
  },
})

const showDrawer = ref(false)
// 抽屉实时解析 store 数据：并发刷新/外部删除会同步反映，而不是展示过期快照
const drawerKeyId = ref<string | null>(null)
const drawerKey = computed(
  () => virtualKeys.value.find((key) => key.id === drawerKeyId.value) ?? null,
)

function openDrawer(row: VirtualKey) {
  drawerKeyId.value = row.id
  showDrawer.value = true
}

watch(drawerKey, (key) => {
  if (!key && showDrawer.value) showDrawer.value = false
})

function goToRequests(virtualKeyId: string) {
  router.push({ path: '/me/api-requests', query: { virtualKeyId } })
}

const columns = computed<DataTableColumns<VirtualKey>>(() => [
  {
    title: t('virtualKeys.colName'),
    key: 'name',
    width: 160,
    ellipsis: { tooltip: true },
    sorter: (a, b) => a.name.localeCompare(b.name),
    render: (row) =>
      h(
        NButton,
        {
          text: true,
          type: 'primary',
          onClick: () => openDrawer(row),
          'aria-label': t('virtualKeys.viewDetail'),
        },
        { default: () => row.name },
      ),
  },
  {
    title: t('virtualKeys.colKeyValue'),
    key: 'keyValue',
    width: 180,
    ellipsis: { tooltip: true },
    render: (row) => h('span', { class: 'key-mono' }, row.keyValue),
  },
  {
    title: t('virtualKeys.colModels'),
    key: 'modelIds',
    width: 220,
    render: (row) => {
      // 自助视角拿不到模型表（/api/models 属管理端），只展示原始 id
      const ids = collectBoundModelIds(row)
      if (ids.length === 0) return '-'
      const chips = ids.slice(0, 2).map((id) =>
        h(NTag, { size: 'small', round: true }, { default: () => id }),
      )
      if (ids.length > 2) {
        chips.push(h(NTag, { size: 'small' }, { default: () => t('virtualKeys.modelsMore', { n: ids.length - 2 }) }))
      }
      return h('div', { class: 'model-cell' }, chips)
    },
  },
  {
    title: t('virtualKeys.colStatus'),
    key: 'enabled',
    width: 90,
    render: (row) =>
      h(
        NTag,
        { size: 'small', type: row.enabled ? 'success' : 'default' },
        {
          default: () =>
            row.enabled ? t('virtualKeys.filterEnabled') : t('virtualKeys.filterDisabled'),
        },
      ),
  },
  {
    title: t('virtualKeys.fieldCreatedAt'),
    key: 'createdAt',
    width: 170,
    sorter: (a, b) => a.createdAt - b.createdAt,
    render: (row) => formatDateTime(row.createdAt),
  },
])

function rowKeyOf(row: VirtualKey) {
  return row.id
}

onMounted(load)
</script>

<style scoped>
.my-virtual-keys-view {
  max-width: 1400px;
  margin: 0 auto;
}

.table-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.table-card {
  background: #ffffff;
  border-radius: 16px;
  border: none;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.table-card :deep(.n-data-table-th) {
  background: #fafafa;
  font-weight: 600;
  font-size: 12px;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  border-bottom: 1px solid #e8e8e8;
  padding: 10px 12px;
}

.table-card :deep(.n-data-table-td) {
  padding: 10px 12px;
  border-bottom: 1px solid #f0f0f0;
  font-size: 13px;
  color: #333;
}

.model-cell {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  height: 24px;
  white-space: nowrap;
}

.model-cell :deep(.n-tag) {
  flex-shrink: 0;
}

.key-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
}

.detail-row {
  display: flex;
  gap: 12px;
  padding: 4px 0;
  font-size: 13px;
}

.detail-label {
  width: 120px;
  flex-shrink: 0;
  color: #999;
}

.detail-value {
  color: #333;
  word-break: break-all;
}

.form-section {
  margin-top: 4px;
}

.drawer-hint {
  margin-bottom: 12px;
}
</style>

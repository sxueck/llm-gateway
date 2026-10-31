<template>
  <div class="virtual-keys-view">
    <n-space vertical :size="12">
      <PageHeader eyebrow="ACCESS" :title="t('virtualKeys.title')" :subtitle="t('virtualKeys.subtitle')">
        <template #actions>
          <n-button type="primary" @click="openCreate">{{ t('virtualKeys.addKey') }}</n-button>
        </template>
      </PageHeader>

      <n-card class="table-card">
        <div class="table-toolbar">
          <n-input
            v-model:value="searchText"
            :placeholder="t('virtualKeys.searchPlaceholder')"
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
          <n-radio-group v-model:value="metricsPeriod" size="small">
            <n-radio-button value="24h">{{ t('virtualKeys.period24h') }}</n-radio-button>
            <n-radio-button value="7d">{{ t('virtualKeys.period7d') }}</n-radio-button>
            <n-radio-button value="30d">{{ t('virtualKeys.period30d') }}</n-radio-button>
          </n-radio-group>
          <n-button
            size="small"
            :disabled="virtualKeyStore.virtualKeys.length === 0"
            @click="openBatchQuotaModal"
          >
            <template #icon>
              <n-icon :component="SpeedometerOutline" />
            </template>
            {{ t('virtualKeys.quotaSettings') }}
          </n-button>
          <n-button
            size="small"
            :loading="virtualKeyStore.loading"
            @click="refreshAll"
          >
            <template #icon>
              <n-icon :component="RefreshOutlined" />
            </template>
            {{ t('virtualKeys.refresh') }}
          </n-button>
        </div>

        <n-alert v-if="metricsError" type="warning" closable style="margin-bottom: 8px">
          <div class="metrics-alert">
            <span>{{ t('virtualKeys.metricsLoadError', { message: metricsError }) }}</span>
            <n-button size="tiny" :loading="metricsLoading" @click="refreshMetrics">
              {{ t('virtualKeys.metricsRetry') }}
            </n-button>
          </div>
        </n-alert>

        <div v-if="metricsNotes.length" class="metrics-notes">
          <span v-for="note in metricsNotes" :key="note" class="metrics-note">{{ note }}</span>
        </div>

        <n-data-table
          :columns="columns"
          :data="filteredKeys"
          :loading="virtualKeyStore.loading"
          :pagination="pagination"
          :row-key="rowKeyOf"
          :checked-row-keys="checkedRowKeys"
          :scroll-x="1140"
          :bordered="false"
          size="small"
          @update:checked-row-keys="handleCheckedRowKeysUpdate"
        />
      </n-card>
    </n-space>

    <n-modal
      v-model:show="showModal"
      preset="card"
      :title="editingId ? t('virtualKeys.editKey') : t('virtualKeys.addKey')"
      class="key-modal"
      :style="{ width: '760px', maxWidth: '92vw', maxHeight: '85vh' }"
      :segmented="{
        content: 'soft',
        footer: 'soft'
      }"
    >
      <div class="modal-form-wrapper">
        <n-form
          ref="formRef"
          :model="formValue"
          :rules="rules"
          label-placement="left"
          label-width="110"
          size="small"
        >
          <n-divider title-placement="left" class="form-section">{{ t('virtualKeys.formBasic') }}</n-divider>
          <n-form-item :label="t('virtualKeys.keyName')" path="name">
            <n-input v-model:value="formValue.name" :placeholder="t('virtualKeys.keyNamePlaceholder')" size="small" />
          </n-form-item>
          <n-form-item :label="t('virtualKeys.models')" path="modelIds">
            <n-select
              v-model:value="formValue.modelIds"
              :options="modelOptions"
              :placeholder="t('virtualKeys.modelsPlaceholder')"
              filterable
              multiple
              clearable
              size="small"
            />
          </n-form-item>
          <n-form-item :label="t('virtualKeys.enabled')">
            <n-switch v-model:value="formValue.enabled" size="small" />
          </n-form-item>

          <template v-if="!editingId">
            <n-divider title-placement="left" class="form-section">{{ t('virtualKeys.formAccess') }}</n-divider>
            <n-form-item :label="t('virtualKeys.generateMode')" path="keyType">
              <n-radio-group v-model:value="formValue.keyType" size="small">
                <n-space :size="12">
                  <n-radio value="auto">{{ t('virtualKeys.generateAuto') }}</n-radio>
                  <n-radio value="custom">{{ t('virtualKeys.generateCustom') }}</n-radio>
                </n-space>
              </n-radio-group>
            </n-form-item>
            <n-form-item
              v-if="formValue.keyType === 'custom'"
              :label="t('virtualKeys.customKey')"
              path="customKey"
            >
              <n-input
                v-model:value="formValue.customKey"
                :placeholder="t('virtualKeys.customKeyPlaceholder')"
                size="small"
              />
            </n-form-item>
          </template>

          <n-divider title-placement="left" class="form-section">{{ t('virtualKeys.formAdvanced') }}</n-divider>
          <n-form-item :label="t('virtualKeys.rateLimit')" path="rateLimit">
            <n-input-number
              v-model:value="formValue.rateLimit"
              :placeholder="t('virtualKeys.rateLimitPlaceholder')"
              :min="1"
              style="width: 100%"
              size="small"
            />
          </n-form-item>
          <n-form-item :label="t('virtualKeys.enableCache')">
            <n-switch v-model:value="formValue.cacheEnabled" size="small" />
          </n-form-item>
          <n-form-item :label="t('virtualKeys.disableLogging')">
            <n-switch v-model:value="formValue.disableLogging" size="small" />
          </n-form-item>
          <n-form-item :label="t('virtualKeys.contextBudget')">
            <n-space vertical :size="4">
              <n-select
                v-model:value="formValue.contextBudgetTokens"
                :options="contextBudgetOptions"
                clearable
                :placeholder="t('virtualKeys.contextBudgetOff')"
                style="width: 160px"
                size="small"
              />
              <span class="form-hint">{{ t('virtualKeys.contextBudgetHint') }}</span>
            </n-space>
          </n-form-item>
          <n-form-item :label="t('virtualKeys.imageCompression')">
            <n-space vertical :size="4">
              <n-switch v-model:value="formValue.imageCompressionEnabled" size="small" />
              <span class="form-hint">{{ t('virtualKeys.imageCompressionHint') }}</span>
            </n-space>
          </n-form-item>
          <n-form-item :label="t('virtualKeys.interceptZeroTemp')">
            <n-space vertical :size="4">
              <n-space :size="12" align="center">
                <n-switch v-model:value="formValue.interceptZeroTemperature" size="small" />
                <n-input-number
                  v-model:value="formValue.zeroTemperatureReplacement"
                  :disabled="!formValue.interceptZeroTemperature"
                  :min="0"
                  :max="2"
                  :step="0.1"
                  style="width: 150px"
                  size="small"
                />
              </n-space>
              <span class="form-hint">{{ t('virtualKeys.interceptZeroTempHint') }}</span>
            </n-space>
          </n-form-item>
          <n-form-item :label="t('virtualKeys.piiProtection')">
            <n-space vertical :size="4">
              <n-switch v-model:value="formValue.piiProtectionEnabled" size="small" />
              <span class="form-hint">{{ t('virtualKeys.piiProtectionHint') }}</span>
            </n-space>
          </n-form-item>
        </n-form>
      </div>
      <template #footer>
        <n-space justify="end" :size="8">
          <n-button @click="showModal = false" size="small">{{ t('virtualKeys.cancel') }}</n-button>
          <n-button type="primary" :loading="submitting" @click="handleSubmit" size="small">
            {{ editingId ? t('virtualKeys.update') : t('virtualKeys.create') }}
          </n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal
      v-model:show="showKeyModal"
      preset="card"
      :title="resultTitle"
      style="width: 640px; max-width: 92vw"
    >
      <n-space vertical :size="12">
        <n-alert type="success">{{ resultMessage }}</n-alert>
        <n-input-group>
          <n-input :value="createdKeyValue" readonly />
          <n-button @click="copyKey">{{ t('virtualKeys.copy') }}</n-button>
        </n-input-group>

        <template v-if="curlSnippets">
          <n-divider style="margin: 4px 0">{{ t('virtualKeys.curlTitle') }}</n-divider>
          <span class="curl-base">{{ t('virtualKeys.curlBase', { base: curlBaseUrl }) }}</span>
          <span v-if="curlOriginAssumed" class="curl-base curl-origin-note">{{ t('virtualKeys.curlOriginAssumed') }}</span>
          <div v-for="entry in curlEntries" :key="entry.label" class="curl-block">
            <div class="curl-block-head">
              <span>{{ entry.label }}</span>
              <n-button size="tiny" @click="copyText(entry.command, 'virtualKeys.copyCurl')">
                {{ t('virtualKeys.copyCurl') }}
              </n-button>
            </div>
            <pre class="curl-pre">{{ entry.command }}</pre>
          </div>
        </template>
        <n-alert v-else-if="resultVirtualKey" type="warning">
          {{ t('virtualKeys.curlNoModel') }}
        </n-alert>
      </n-space>
      <template #footer>
        <n-space justify="end">
          <n-button type="primary" @click="showKeyModal = false">{{ t('virtualKeys.confirm') }}</n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal
      v-model:show="showRotateModal"
      preset="card"
      :title="t('virtualKeys.rotateTitle')"
      style="width: 480px; max-width: 92vw"
    >
      <n-space vertical>
        <n-alert type="warning">{{ t('virtualKeys.rotateWarning') }}</n-alert>
        <n-form label-placement="left" label-width="110" size="small">
          <n-form-item :label="t('virtualKeys.generateMode')">
            <n-radio-group v-model:value="rotateForm.keyType" size="small">
              <n-space :size="12">
                <n-radio value="auto">{{ t('virtualKeys.generateAuto') }}</n-radio>
                <n-radio value="custom">{{ t('virtualKeys.generateCustom') }}</n-radio>
              </n-space>
            </n-radio-group>
          </n-form-item>
          <n-form-item v-if="rotateForm.keyType === 'custom'" :label="t('virtualKeys.customKey')">
            <n-input
              v-model:value="rotateForm.customKey"
              :placeholder="t('virtualKeys.customKeyPlaceholder')"
              size="small"
            />
          </n-form-item>
        </n-form>
      </n-space>
      <template #footer>
        <n-space justify="end" :size="8">
          <n-button @click="showRotateModal = false" size="small">{{ t('virtualKeys.cancel') }}</n-button>
          <n-button type="primary" :loading="rotating" @click="handleRotate" size="small">
            {{ t('virtualKeys.rotateConfirm') }}
          </n-button>
        </n-space>
      </template>
    </n-modal>

    <VirtualKeyQuotaModal
      v-model:show="showQuotaModal"
      :virtual-keys="virtualKeyStore.virtualKeys"
      :selected-ids="checkedRowKeys"
      :single-key-id="quotaSingleKeyId"
    />

    <n-drawer v-model:show="showDrawer" :width="480" placement="right">
      <n-drawer-content :title="t('virtualKeys.drawerTitle')" closable>
        <div v-if="drawerKey" class="drawer-body">
          <n-divider title-placement="left" class="form-section">{{ t('virtualKeys.sectionBasic') }}</n-divider>
          <div class="detail-row">
            <span class="detail-label">{{ t('virtualKeys.keyName') }}</span>
            <span class="detail-value">{{ drawerKey.name }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ t('virtualKeys.fieldKeyValue') }}</span>
            <span class="detail-value key-mono">
              {{ drawerKey.keyValue }}
            </span>
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
              {{ drawerKey.rateLimit ? t('virtualKeys.rateLimitPerMin', { n: drawerKey.rateLimit }) : '-' }}
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ t('virtualKeys.fieldRoutingStrategy') }}</span>
            <span class="detail-value">{{ drawerKey.routingStrategy || '-' }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ t('virtualKeys.fieldProvider') }}</span>
            <span class="detail-value">{{ drawerKey.providerId || '-' }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ t('virtualKeys.fieldSingleModel') }}</span>
            <span class="detail-value">{{ drawerKey.modelId || '-' }}</span>
          </div>
          <div v-if="drawerKey.routingConfig" class="detail-row">
            <span class="detail-label">{{ t('virtualKeys.fieldRoutingConfig') }}</span>
            <span class="detail-value key-mono">{{ JSON.stringify(drawerKey.routingConfig) }}</span>
          </div>

          <n-divider title-placement="left" class="form-section">{{ t('virtualKeys.sectionModels') }}</n-divider>
          <n-space :size="4" wrap>
            <n-tag
              v-for="entry in drawerModelEntries"
              :key="entry.id"
              :type="entry.resolved ? (entry.virtual ? 'info' : 'default') : 'warning'"
              size="small"
              :round="entry.resolved && entry.virtual"
            >
              {{ entry.label }}
            </n-tag>
            <span v-if="drawerModelEntries.length === 0">-</span>
          </n-space>

          <n-divider title-placement="left" class="form-section">{{ t('virtualKeys.sectionPolicy') }}</n-divider>
          <div class="detail-row">
            <span class="detail-label">{{ t('virtualKeys.policyCache') }}</span>
            <span class="detail-value">{{ onOff(drawerKey.cacheEnabled) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ t('virtualKeys.policyLogging') }}</span>
            <span class="detail-value">
              {{ drawerKey.disableLogging ? t('virtualKeys.valueOff') : t('virtualKeys.valueOn') }}
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ t('virtualKeys.policyBudget') }}</span>
            <span class="detail-value">
              {{
                drawerKey.contextBudgetTokens
                  ? `${drawerKey.contextBudgetTokens / 1000}K`
                  : t('virtualKeys.budgetOff')
              }}
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ t('virtualKeys.policyImage') }}</span>
            <span class="detail-value">{{ onOff(drawerKey.imageCompressionEnabled) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ t('virtualKeys.policyZeroTemp') }}</span>
            <span class="detail-value">
              {{
                drawerKey.interceptZeroTemperature
                  ? `${t('virtualKeys.valueOn')} · ${t('virtualKeys.policyZeroTempValue')} ${
                      drawerKey.zeroTemperatureReplacement ?? '-'
                    }`
                  : t('virtualKeys.valueOff')
              }}
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ t('virtualKeys.policyPii') }}</span>
            <span class="detail-value">{{ onOff(drawerKey.piiProtectionEnabled) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">{{ t('virtualKeys.policyNormalization') }}</span>
            <span class="detail-value">
              {{ drawerKey.contextNormalizationEnabled === undefined ? t('virtualKeys.valueUnknown') : onOff(drawerKey.contextNormalizationEnabled) }}
            </span>
          </div>

          <n-divider title-placement="left" class="form-section">{{ t('virtualKeys.sectionMeta') }}</n-divider>
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
  NSpace,
  NButton,
  NDataTable,
  NCard,
  NModal,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NInputGroup,
  NSwitch,
  NTag,
  NPopconfirm,
  NSelect,
  NRadioGroup,
  NRadio,
  NRadioButton,
  NAlert,
  NIcon,
  NDrawer,
  NDrawerContent,
  NDivider,
  NTooltip
} from 'naive-ui'
import {
  EditOutlined,
  DeleteOutlined,
  AutorenewOutlined,
  SearchOutlined,
  RefreshOutlined,
  OpenInNewOutlined
} from '@vicons/material'
import { SpeedometerOutline } from '@vicons/ionicons5'
import { useVirtualKeyStore } from '@/stores/virtual-key'
import { useModelStore } from '@/stores/model'
import { useModelOptions } from '@/composables/useModelOptions'
import { virtualKeyApi } from '@/api/virtual-key'
import { configApi } from '@/api/config'
import type { OpsPeriod } from '@/api/ops-metrics'
import type { VirtualKey } from '@/types'
import { copyToClipboard } from '@/utils/common'
import { formatDateTime } from '@/utils/date'
import { formatTokenNumber } from '@/utils/format'
import { buildVirtualKeyCurlSnippets } from '@/utils/curl-snippet'
import {
  VK_METRICS_BACKEND_DIMENSION_LIMIT,
  VK_METRICS_MAX_PAGES,
  VK_METRICS_PAGE_SIZE,
  collectBoundModelIds,
  createVirtualKeyMetricsLoader,
  filterVirtualKeys,
  resolveFirstModelIdentifier,
  type VirtualKeyEnabledFilter,
  type VirtualKeyMetricsData
} from '@/utils/virtual-key-helpers'
import { createDefaultVirtualKeyForm } from '@/types/virtual-key'
import { CONTEXT_BUDGET_TIERS } from '@llm-gateway/shared'
import PageHeader from '@/components/PageHeader.vue'
import VirtualKeyQuotaModal from '@/components/VirtualKeyQuotaModal.vue'

const message = useMessage()
const router = useRouter()
const { t } = useI18n()
const virtualKeyStore = useVirtualKeyStore()
const modelStore = useModelStore()

const searchText = ref('')
const enabledFilter = ref<VirtualKeyEnabledFilter>('all')
const metricsPeriod = ref<OpsPeriod>('24h')

// Checked rows are the quota dialog's "selected keys" batch scope.
const checkedRowKeys = ref<string[]>([])
const showQuotaModal = ref(false)
// null = batch scope (selected/all); a key id = single-key quota view with usage.
const quotaSingleKeyId = ref<string | null>(null)

function handleCheckedRowKeysUpdate(keys: Array<string | number>) {
  checkedRowKeys.value = keys.map(String)
}

function openSingleQuotaModal(row: VirtualKey) {
  quotaSingleKeyId.value = row.id
  showQuotaModal.value = true
}

function openBatchQuotaModal() {
  quotaSingleKeyId.value = null
  showQuotaModal.value = true
}

const enabledOptions = computed(() => [
  { label: t('virtualKeys.filterAll'), value: 'all' },
  { label: t('virtualKeys.filterEnabled'), value: 'enabled' },
  { label: t('virtualKeys.filterDisabled'), value: 'disabled' }
])

watch([searchText, enabledFilter], () => {
  // Keeping the old page number after filtering can land on an empty page.
  pagination.page = 1
})

const metrics = ref<VirtualKeyMetricsData | null>(null)
const metricsLoading = ref(false)
const metricsError = ref('')
const loadMetrics = createVirtualKeyMetricsLoader()
// The loader is the single source of truth for staleness; this counter only keeps the
// spinner up while any request is in flight, which a newest-request id cannot express.
let metricsInFlight = 0

async function refreshMetrics() {
  metricsInFlight += 1
  metricsLoading.value = true
  // Drop the previous window immediately: showing old-period numbers under a
  // new period (while pending or after a failure) would be misleading.
  metrics.value = null
  metricsError.value = ''
  try {
    const outcome = await loadMetrics(metricsPeriod.value)
    if (outcome.stale) return
    metrics.value = outcome
  } catch (error: any) {
    // The loader only rejects for the newest request, so this error is current.
    metricsError.value = error?.message || String(error)
  } finally {
    metricsInFlight -= 1
    if (metricsInFlight === 0) metricsLoading.value = false
  }
}

watch(metricsPeriod, () => {
  void refreshMetrics()
})

const metricsById = computed(() => metrics.value?.byId ?? {})

// A missing dimension may be read as "no calls" only when the fetch covered
// the whole window: no client-side page cap, no backend dimension cap, and
// backend coverage reported as exact without gaps.
const metricsComplete = computed(
  () =>
    Boolean(metrics.value) &&
    !metrics.value!.truncated &&
    !metrics.value!.backendCapHit &&
    !metrics.value!.hasCoverageGaps
)

const metricsNotes = computed(() => {
  const notes: string[] = []
  if (!metrics.value) return notes
  if (metrics.value.truncated) {
    notes.push(t('virtualKeys.metricsTruncated', { limit: VK_METRICS_PAGE_SIZE * VK_METRICS_MAX_PAGES }))
  }
  if (metrics.value.backendCapHit) {
    notes.push(t('virtualKeys.metricsBackendCap', { limit: VK_METRICS_BACKEND_DIMENSION_LIMIT }))
  }
  if (metrics.value.hasCoverageGaps) {
    notes.push(t('virtualKeys.metricsCoverageGaps'))
  }
  return notes
})

// One shared lookup map instead of repeated Array.find over the model list.
const modelById = computed(() => new Map(modelStore.models.map((m) => [m.id, m])))

const filteredKeys = computed(() =>
  filterVirtualKeys(
    virtualKeyStore.virtualKeys,
    {
      search: searchText.value,
      enabled: enabledFilter.value
    },
    (modelId) => modelById.value.get(modelId)?.name
  )
)

const pagination = reactive<PaginationProps>({
  page: 1,
  pageSize: 10,
  pageSizes: [10, 20, 50],
  showSizePicker: true,
  prefix: (info) => t('virtualKeys.totalCount', { n: info.itemCount ?? 0 }),
  onUpdatePage: (page: number) => {
    pagination.page = page
  },
  onUpdatePageSize: (pageSize: number) => {
    pagination.pageSize = pageSize
    pagination.page = 1
  }
})

const { modelOptions } = useModelOptions({
  uniqueByIdentifier: false,
  labelStyle: 'nameWithProvider',
  valueField: 'id'
})

const contextBudgetOptions = CONTEXT_BUDGET_TIERS.map((tokens) => ({
  label: `${tokens / 1000}K`,
  value: tokens
}))

// Set once the first model fetch settles; until then a cache miss is a pending
// lookup, not evidence that a model was deleted.
const modelsLoaded = ref(false)

async function loadModels() {
  try {
    await modelStore.fetchModels()
  } finally {
    modelsLoaded.value = true
  }
}

function modelChipState(id: string): { label: string; resolved: boolean } {
  const model = modelById.value.get(id)
  if (model) return { label: model.name, resolved: true }
  if (!modelsLoaded.value) return { label: id, resolved: true }
  return { label: t('virtualKeys.modelsUnresolved', { id }), resolved: false }
}

// The table shows at most 2 model chips; the full list (including unresolved
// ids) stays reachable through the hover tooltip and the drawer.
function renderModelChips(row: VirtualKey) {
  const ids = collectBoundModelIds(row)
  if (ids.length === 0) return '-'
  const max = 2
  const states = ids.map((id) => modelChipState(id))
  const chips = states.slice(0, max).map((state) =>
    h(
      NTag,
      {
        size: 'small',
        round: true,
        type: state.resolved ? 'default' : 'warning'
      },
      { default: () => state.label }
    )
  )
  const remaining = ids.length - max
  if (remaining > 0) {
    chips.push(
      h(
        NTooltip,
        {},
        {
          trigger: () =>
            h(
              'span',
              {
                tabindex: 0,
                role: 'button',
                'aria-label': states.map((state) => state.label).join(', ')
              },
              [h(NTag, { size: 'small' }, { default: () => t('virtualKeys.modelsMore', { n: remaining }) })]
            ),
          default: () =>
            h('div', { style: 'max-width: 280px' }, states.map((state) => h('div', {}, state.label)))
        }
      )
    )
  }
  return h('div', { class: 'model-cell' }, chips)
}

const drawerModelEntries = computed(() => {
  if (!drawerKey.value) return []
  return collectBoundModelIds(drawerKey.value).map((id) => ({
    id,
    ...modelChipState(id),
    virtual: Boolean(modelById.value.get(id)?.isVirtual)
  }))
})

const pendingToggleIds = reactive(new Set<string>())

function metricOf(row: VirtualKey) {
  return metricsById.value[row.id]
}

function formatLastUsedAgo(ts: number | null): string {
  if (!ts) return '-'
  const minutes = Math.floor(Math.max(0, Date.now() - ts) / 60_000)
  if (minutes < 1) return t('agentMetrics.relative.justNow')
  if (minutes < 60) return t('agentMetrics.relative.minutesAgo', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('agentMetrics.relative.hoursAgo', { n: hours })
  return t('agentMetrics.relative.daysAgo', { n: Math.floor(hours / 24) })
}

function sortNumber(read: (row: VirtualKey) => number | null | undefined) {
  return (a: VirtualKey, b: VirtualKey) => {
    const av = read(a) ?? null
    const bv = read(b) ?? null
    if (av === null && bv === null) return 0
    if (av === null) return 1
    if (bv === null) return -1
    return av - bv
  }
}

const columns = computed<DataTableColumns<VirtualKey>>(() => [
  {
    type: 'selection'
  },
  {
    title: t('virtualKeys.colName'),
    key: 'name',
    minWidth: 160,
    ellipsis: { tooltip: true },
    sorter: (a, b) => a.name.localeCompare(b.name),
    render: (row) =>
      h(
        NButton,
        {
          text: true,
          type: 'primary',
          onClick: () => openDrawer(row),
          'aria-label': t('virtualKeys.viewDetail')
        },
        { default: () => row.name }
      )
  },
  {
    title: t('virtualKeys.colModels'),
    key: 'modelIds',
    width: 210,
    render: renderModelChips
  },
  {
    title: t('virtualKeys.colStatus'),
    key: 'enabled',
    width: 80,
    render: (row) =>
      h(NSwitch, {
        size: 'small',
        value: row.enabled,
        loading: pendingToggleIds.has(row.id),
        disabled: pendingToggleIds.has(row.id),
        onUpdateValue: (value: boolean) => handleToggleEnabled(row, value)
      })
  },
  {
    title: t('virtualKeys.colRequests'),
    key: 'requestCount',
    width: 90,
    sorter: sortNumber((row) => metricOf(row)?.requestCount ?? null),
    render: (row) => {
      const metric = metricOf(row)
      // A missing dimension only means "no calls" when the fetch was complete;
      // otherwise never fabricate a 0.
      if (!metric) return metricsComplete.value ? '0' : '-'
      return String(metric.requestCount)
    }
  },
  {
    title: t('virtualKeys.colTokens'),
    key: 'totalTokens',
    width: 110,
    sorter: sortNumber((row) => metricOf(row)?.totalTokens ?? null),
    render: (row) => {
      const metric = metricOf(row)
      if (!metric) return metricsComplete.value ? '0' : '-'
      return formatTokenNumber(metric.totalTokens)
    }
  },
  {
    title: t('virtualKeys.colLastUsed'),
    key: 'lastUsedAt',
    width: 120,
    sorter: sortNumber((row) => metricOf(row)?.lastUsedAt ?? null),
    render: (row) => formatLastUsedAgo(metricOf(row)?.lastUsedAt ?? null)
  },
  {
    title: t('virtualKeys.colActions'),
    key: 'actions',
    width: 190,
    fixed: 'right',
    render: (row) =>
      h(
        NSpace,
        { size: 4, wrap: false },
        {
          default: () => [
            actionButton(SpeedometerOutline, t('virtualKeys.quota'), () => openSingleQuotaModal(row)),
            actionButton(AutorenewOutlined, t('virtualKeys.rotate'), () => handleRotateClick(row)),
            actionButton(EditOutlined, t('virtualKeys.edit'), () => handleEdit(row)),
            h(
              NPopconfirm,
              { onPositiveClick: () => handleDelete(row.id) },
              {
                trigger: () => actionButton(DeleteOutlined, t('virtualKeys.remove'), () => {}),
                default: () => t('virtualKeys.deleteConfirm')
              }
            )
          ]
        }
      )
  }
])

function actionButton(icon: typeof EditOutlined, tooltip: string, onClick: () => void) {
  return h(
    NTooltip,
    {},
    {
      trigger: () =>
        h(
          NButton,
          {
            size: 'small',
            quaternary: true,
            circle: true,
            'aria-label': tooltip,
            onClick
          },
          { icon: () => h(NIcon, null, { default: () => h(icon) }) }
        ),
      default: () => tooltip
    }
  )
}

function rowKeyOf(row: VirtualKey) {
  return row.id
}

const showDrawer = ref(false)
// The drawer resolves its id against the current store data on every render:
// concurrent refreshes/toggles are reflected live, and a key deleted from the
// store closes the drawer instead of showing a stale snapshot.
const drawerKeyId = ref<string | null>(null)
const drawerKey = computed(
  () => virtualKeyStore.virtualKeys.find((key) => key.id === drawerKeyId.value) ?? null
)

function openDrawer(row: VirtualKey) {
  drawerKeyId.value = row.id
  showDrawer.value = true
}

watch(drawerKey, (key) => {
  if (!key && showDrawer.value) showDrawer.value = false
})

function onOff(value: boolean) {
  return value ? t('virtualKeys.valueOn') : t('virtualKeys.valueOff')
}

function goToRequests(virtualKeyId: string) {
  router.push({ path: '/api-requests', query: { virtualKeyId } })
}

const showModal = ref(false)
const formRef = ref()
const submitting = ref(false)
const editingId = ref<string | null>(null)
const formValue = ref(createDefaultVirtualKeyForm())

const rules = computed(() => ({
  name: [{ required: true, message: t('virtualKeys.nameRequired'), trigger: 'blur' }],
  modelIds: [
    {
      required: true,
      validator: (_rule: any, value: string[]) => {
        if (!value || value.length === 0) {
          return new Error(t('virtualKeys.modelsRequired'))
        }
        return true
      },
      trigger: 'change'
    }
  ],
  customKey: [
    {
      required: true,
      validator: (_rule: any, value: string) => {
        if (formValue.value.keyType === 'custom' && !value) {
          return new Error(t('virtualKeys.customKeyRequired'))
        }
        return true
      },
      trigger: 'blur'
    }
  ]
}))

function openCreate() {
  resetForm()
  showModal.value = true
}

watch(showModal, (open) => {
  if (open) {
    void loadModels()
  } else {
    // Reset on close so cancel-after-edit never leaks the previous key's values.
    resetForm()
    formRef.value?.restoreValidation?.()
  }
})

function handleEdit(vk: VirtualKey) {
  editingId.value = vk.id
  formValue.value = {
    name: vk.name,
    modelIds: collectBoundModelIds(vk),
    keyType: 'auto',
    customKey: '',
    rateLimit: vk.rateLimit ?? null,
    enabled: vk.enabled,
    cacheEnabled: vk.cacheEnabled,
    disableLogging: vk.disableLogging,
    contextBudgetTokens: vk.contextBudgetTokens ?? null,
    imageCompressionEnabled: vk.imageCompressionEnabled,
    interceptZeroTemperature: vk.interceptZeroTemperature,
    // `??` keeps a legitimate replacement of 0 (`||` would swallow it into the default)
    zeroTemperatureReplacement: vk.zeroTemperatureReplacement ?? 0.7,
    piiProtectionEnabled: vk.piiProtectionEnabled
  }
  showModal.value = true
}

function resetForm() {
  editingId.value = null
  formValue.value = createDefaultVirtualKeyForm()
}

/** Off or an emptied box sends an explicit null, which is what actually clears the stored value. */
function zeroTemperaturePayload(): number | null {
  if (!formValue.value.interceptZeroTemperature) return null
  return formValue.value.zeroTemperatureReplacement ?? null
}

async function handleSubmit() {
  try {
    await formRef.value?.validate()
    submitting.value = true

    if (editingId.value) {
      await virtualKeyApi.update(editingId.value, {
        name: formValue.value.name,
        modelIds: formValue.value.modelIds,
        enabled: formValue.value.enabled,
        rateLimit: formValue.value.rateLimit,
        cacheEnabled: formValue.value.cacheEnabled,
        disableLogging: formValue.value.disableLogging,
        interceptZeroTemperature: formValue.value.interceptZeroTemperature,
        zeroTemperatureReplacement: zeroTemperaturePayload(),
        contextBudgetTokens: formValue.value.contextBudgetTokens,
        imageCompressionEnabled: formValue.value.imageCompressionEnabled,
        piiProtectionEnabled: formValue.value.piiProtectionEnabled
      })
      message.success(t('virtualKeys.updateSuccess'))
      showModal.value = false
    } else {
      const result = await virtualKeyApi.create({
        ...formValue.value,
        zeroTemperatureReplacement: zeroTemperaturePayload()
      })
      createdKeyValue.value = result.keyValue
      resultVirtualKey.value = result.virtualKey
      resultTitle.value = t('virtualKeys.resultTitleCreate')
      resultMessage.value = t('virtualKeys.resultMessageCreate')
      showModal.value = false
      await ensureCurlBaseUrl()
      showKeyModal.value = true
    }

    resetForm()
    await virtualKeyStore.fetchVirtualKeys()
  } catch (error: any) {
    // Validation failures (no message string) are shown by the form items; don't double-toast.
    if (typeof error?.message === 'string' && error.message) {
      message.error(error.message)
    }
  } finally {
    submitting.value = false
  }
}

async function handleToggleEnabled(row: VirtualKey, value: boolean) {
  // Per-row guard: ignore re-entrant toggles while this row's update is pending.
  if (pendingToggleIds.has(row.id)) return
  pendingToggleIds.add(row.id)
  try {
    const updated = await virtualKeyApi.update(row.id, { enabled: value })
    // Resolve the row against the store again: a concurrent refresh may have
    // replaced the row object that triggered this handler.
    const current = virtualKeyStore.virtualKeys.find((key) => key.id === row.id)
    if (current) current.enabled = updated?.enabled ?? value
  } catch (error: any) {
    // The local value was never touched, so the switch reverts; the error stays visible.
    message.error(
      t('virtualKeys.toggleError', { message: error?.message || String(error ?? 'unknown') })
    )
  } finally {
    pendingToggleIds.delete(row.id)
  }
}

async function handleDelete(id: string) {
  try {
    await virtualKeyApi.delete(id)
    message.success(t('virtualKeys.deleteSuccess'))
    await virtualKeyStore.fetchVirtualKeys()
    // Selection must not keep deleted keys: the batch quota scope counts them.
    checkedRowKeys.value = checkedRowKeys.value.filter((keyId) =>
      virtualKeyStore.virtualKeys.some((key) => key.id === keyId)
    )
    if (quotaSingleKeyId.value === id) {
      quotaSingleKeyId.value = null
      showQuotaModal.value = false
    }
    // A shrinking result set can leave the current page past the last page.
    const pageSize = pagination.pageSize ?? 10
    const lastPage = Math.max(1, Math.ceil(filteredKeys.value.length / pageSize))
    if ((pagination.page ?? 1) > lastPage) pagination.page = lastPage
  } catch (error: any) {
    message.error(error?.message || String(error ?? 'unknown'))
  }
}

function copyKey() {
  void copyText(createdKeyValue.value, 'virtualKeys.copyKey')
}

async function copyText(text: string, successKey: 'virtualKeys.copyKey' | 'virtualKeys.copyCurl') {
  try {
    await copyToClipboard(text)
    message.success(t(successKey))
  } catch {
    message.error(t('virtualKeys.copyFailed'))
  }
}

const showKeyModal = ref(false)
const createdKeyValue = ref('')
const resultTitle = ref('')
const resultMessage = ref('')
const resultVirtualKey = ref<VirtualKey | null>(null)
const publicUrl = ref('')
// Set when the system settings request failed and the cURL examples fall back
// to window.location.origin; the modal labels that assumption explicitly.
const curlOriginAssumed = ref(false)

const showRotateModal = ref(false)
const rotating = ref(false)
const rotatingKey = ref<VirtualKey | null>(null)
const rotateForm = ref<{ keyType: 'auto' | 'custom'; customKey: string }>({
  keyType: 'auto',
  customKey: ''
})

const curlBaseUrl = computed(() =>
  (publicUrl.value || window.location.origin).replace(/\/+$/, '')
)

const curlSnippets = computed(() => {
  if (!resultVirtualKey.value) return null
  const modelIdentifier = resolveFirstModelIdentifier(resultVirtualKey.value, modelStore.models)
  if (!modelIdentifier) return null
  return buildVirtualKeyCurlSnippets({
    baseUrl: curlBaseUrl.value,
    keyValue: createdKeyValue.value,
    modelIdentifier
  })
})

const curlEntries = computed(() => {
  const snippets = curlSnippets.value
  if (!snippets) return []
  return [
    { label: t('virtualKeys.curlOpenai'), command: snippets.openai },
    { label: t('virtualKeys.curlAnthropic'), command: snippets.anthropic }
  ]
})

function handleRotateClick(vk: VirtualKey) {
  rotatingKey.value = vk
  rotateForm.value = { keyType: 'auto', customKey: '' }
  showRotateModal.value = true
}

async function handleRotate() {
  if (!rotatingKey.value) return
  if (rotateForm.value.keyType === 'custom' && !rotateForm.value.customKey) {
    message.error(t('virtualKeys.rotateCustomRequired'))
    return
  }

  try {
    rotating.value = true
    const result = await virtualKeyApi.rotate(rotatingKey.value.id, {
      keyType: rotateForm.value.keyType,
      customKey: rotateForm.value.keyType === 'custom' ? rotateForm.value.customKey : undefined
    })
    createdKeyValue.value = result.keyValue
    resultVirtualKey.value = rotatingKey.value
    resultTitle.value = t('virtualKeys.resultTitleRotate')
    resultMessage.value = t('virtualKeys.resultMessageRotate')
    showRotateModal.value = false
    await ensureCurlBaseUrl()
    showKeyModal.value = true
    await virtualKeyStore.fetchVirtualKeys()
  } catch (error: any) {
    if (error?.message) {
      message.error(error.message)
    }
  } finally {
    rotating.value = false
  }
}

function refreshAll() {
  virtualKeyStore.fetchVirtualKeys().catch((error: any) => {
    message.error(error?.message || String(error ?? 'unknown'))
  })
  void loadModels()
  void refreshMetrics()
}

// The configured gateway address is only consumed by the cURL examples, so it is read
// when a result modal is about to open instead of on every mount.
let curlBaseUrlPending = true

async function ensureCurlBaseUrl() {
  if (!curlBaseUrlPending) return
  try {
    const settings = await configApi.getSystemSettings()
    if (settings?.publicUrl) {
      publicUrl.value = settings.publicUrl
      curlOriginAssumed.value = false
    } else {
      // Configured-but-empty is an answer: the examples use the browsing origin and the
      // modal says so instead of retrying a setting that will stay empty.
      curlOriginAssumed.value = true
    }
    curlBaseUrlPending = false
  } catch {
    // Transient failure: keep the fallback labelled and ask again on the next modal.
    curlOriginAssumed.value = true
  }
}

onMounted(() => {
  refreshAll()
})
</script>

<style scoped>
.virtual-keys-view {
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

.metrics-alert {
  display: flex;
  align-items: center;
  gap: 12px;
}

.metrics-notes {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 8px;
}

.metrics-note {
  font-size: 12px;
  color: #999;
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

.form-hint {
  font-size: 12px;
  color: #999;
}

.form-section {
  margin-top: 4px;
}

.curl-base {
  font-size: 12px;
  color: #999;
}

.curl-block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: #666;
  margin-bottom: 4px;
}

.curl-pre {
  margin: 0;
  padding: 8px;
  background: #f6f6f6;
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  overflow-x: auto;
  white-space: pre;
}

.table-card {
  background: #ffffff;
  border-radius: 16px;
  border: none;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.table-card :deep(.n-data-table) {
  background: transparent;
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

.table-card :deep(.n-data-table-tr:hover .n-data-table-td) {
  background: #fafafa;
}

.table-card :deep(.n-data-table-tr:last-child .n-data-table-td) {
  border-bottom: none;
}

.table-card :deep(.n-button.n-button--quaternary-type.n-button--circle-shape) {
  width: 28px;
  height: 28px;
  transition: all 0.2s ease;
}

.table-card :deep(.n-button.n-button--quaternary-type.n-button--circle-shape:hover) {
  background: rgba(15, 107, 74, 0.08);
  color: var(--color-primary);
}

.table-card :deep(.n-button.n-button--quaternary-type.n-button--circle-shape:hover .n-icon) {
  color: var(--color-primary);
}

.table-card :deep(.n-button.n-button--quaternary-type.n-button--circle-shape .n-icon) {
  color: #666;
  font-size: 16px;
}

.table-card :deep(.n-button.n-button--quaternary-type.n-button--circle-shape:disabled) {
  opacity: 0.4;
  cursor: not-allowed;
}

.key-modal :deep(.n-card) {
  background: #ffffff;
  border-radius: 8px;
  border: 1px solid #e8e8e8;
}

.key-modal :deep(.n-card__header) {
  padding: 16px 20px;
  border-bottom: 1px solid #e8e8e8;
}

.key-modal :deep(.n-card__content) {
  padding: 0;
  overflow: hidden;
}

.modal-form-wrapper {
  max-height: calc(85vh - 180px);
  overflow-y: auto;
  overflow-x: hidden;
  padding: 16px 20px;
}

.modal-form-wrapper::-webkit-scrollbar {
  width: 6px;
}

.modal-form-wrapper::-webkit-scrollbar-track {
  background: #f0f0f0;
  border-radius: 3px;
}

.modal-form-wrapper::-webkit-scrollbar-thumb {
  background: #d0d0d0;
  border-radius: 3px;
}

.modal-form-wrapper::-webkit-scrollbar-thumb:hover {
  background: #b0b0b0;
}

.key-modal :deep(.n-card__footer) {
  padding: 12px 20px;
  border-top: 1px solid #e8e8e8;
  background: #ffffff;
}
</style>

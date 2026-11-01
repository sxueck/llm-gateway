<template>
  <n-modal
    :show="show"
    preset="card"
    :title="t('virtualKeys.quotas.title')"
    class="quota-modal"
    :style="{ width: '760px', maxWidth: '92vw' }"
    :segmented="{ content: 'soft', footer: 'soft' }"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <div class="quota-body">
      <div class="quota-period-line">
        <span class="quota-period-label">{{ t('virtualKeys.quotas.periodLabel') }}</span>
        <n-radio-group v-model:value="period" size="small">
          <n-radio-button value="daily">{{ t('virtualKeys.quotas.periodDaily') }}</n-radio-button>
          <n-radio-button value="weekly">{{ t('virtualKeys.quotas.periodWeekly') }}</n-radio-button>
        </n-radio-group>
      </div>
      <div v-if="singleKeyId" class="quota-target-line">
        <span class="quota-target-label">{{ t('virtualKeys.quotas.singleKeyLabel') }}</span>
        <n-tag size="small">{{ singleKeyName }}</n-tag>
      </div>
      <template v-else>
        <n-radio-group v-model:value="scope" size="small">
          <n-space :size="16">
            <n-radio value="selected" :disabled="liveSelectedIds.length === 0">
              {{ t('virtualKeys.quotas.scopeSelected', { n: liveSelectedIds.length }) }}
            </n-radio>
            <n-radio value="all">
              {{ t('virtualKeys.quotas.scopeAll', { n: virtualKeys.length }) }}
            </n-radio>
          </n-space>
        </n-radio-group>
      </template>
      <span class="quota-apply-to" :class="{ 'quota-apply-to-danger': effectiveIds.length === 0 }">
        {{ t('virtualKeys.quotas.applyTo', { n: effectiveIds.length }) }}
      </span>

      <n-alert v-if="usageError" type="warning" style="margin-bottom: 8px">
        <div class="quota-usage-error">
          <span>{{ t('virtualKeys.quotas.loadError', { message: usageError }) }}</span>
          <n-button size="tiny" :loading="usageLoading" @click="refreshUsage">
            {{ t('virtualKeys.quotas.retry') }}
          </n-button>
        </div>
      </n-alert>

      <div v-if="rows.length > 0" class="quota-row quota-row-head" :class="{ 'no-usage': !usageKeyId }">
        <span>{{ t('virtualKeys.quotas.colModel') }}</span>
        <span>{{ t('virtualKeys.quotas.colOp') }}</span>
        <span>{{ t('virtualKeys.quotas.colLimit') }}</span>
        <span v-if="usageKeyId">{{
          t(period === 'daily' ? 'virtualKeys.quotas.colUsageDaily' : 'virtualKeys.quotas.colUsageWeekly')
        }}</span>
        <span></span>
      </div>

      <n-spin :show="usageLoading">
        <div class="quota-rows">
          <div
            v-for="(row, index) in rows"
            :key="index"
            class="quota-row"
            :class="{ 'no-usage': !usageKeyId }"
          >
            <n-select
              v-model:value="row.model"
              :options="modelOptions"
              :placeholder="t('virtualKeys.quotas.modelPlaceholder')"
              filterable
              tag
              size="small"
              class="quota-cell-model"
            />
            <n-radio-group v-model:value="row.op" size="small">
              <n-radio-button value="set">{{ t('virtualKeys.quotas.opSet') }}</n-radio-button>
              <n-radio-button value="remove">{{ t('virtualKeys.quotas.opRemove') }}</n-radio-button>
            </n-radio-group>
            <n-input-number
              v-model:value="row.limitMillions"
              :min="VK_QUOTA_MIN_MILLIONS"
              :step="1"
              :disabled="row.op === 'remove'"
              :placeholder="t('virtualKeys.quotas.limitPlaceholder')"
              size="small"
              class="quota-cell-limit"
            >
              <template #suffix>M</template>
            </n-input-number>
            <span v-if="usageKeyId" class="quota-usage" :class="{ 'is-over': isOverLimit(row) }">
              {{
                usageOf(row)
                  ? t(period === 'daily' ? 'virtualKeys.quotas.usageDaily' : 'virtualKeys.quotas.usageWeekly', {
                      used: formatTokenNumber(usageOf(row)!.usedTokens),
                      limit: formatTokenNumber((row.limitMillions ?? 0) * 1_000_000),
                      n: usageOf(row)!.requestCount
                    })
                  : ''
              }}
            </span>
            <n-button
              size="tiny"
              quaternary
              type="error"
              :aria-label="t('virtualKeys.quotas.removeRow')"
              @click="rows.splice(index, 1)"
            >
              {{ t('virtualKeys.quotas.removeRow') }}
            </n-button>
          </div>
          <div v-if="rows.length === 0 && !usageLoading" class="quota-empty">
            {{
              usageKeyId
                ? t('virtualKeys.quotas.noQuotas')
                : t('virtualKeys.quotas.noRows')
            }}
          </div>
        </div>
      </n-spin>

      <n-button size="small" dashed style="margin-top: 8px" @click="addRow">
        {{ t('virtualKeys.quotas.addRow') }}
      </n-button>

      <n-alert type="info" class="quota-hint">
        <template #header>{{ t('virtualKeys.quotas.hintTitle') }}</template>
        {{ t(period === 'daily' ? 'virtualKeys.quotas.hintDaily' : 'virtualKeys.quotas.hintWeekly') }}
      </n-alert>
    </div>
    <template #footer>
      <n-space justify="end" :size="8">
        <n-button size="small" @click="emit('update:show', false)">
          {{ t('virtualKeys.cancel') }}
        </n-button>
        <n-button type="primary" size="small" :loading="submitting" @click="handleSubmit">
          {{ t('virtualKeys.quotas.submit') }}
        </n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import {
  NAlert,
  NButton,
  NInputNumber,
  NModal,
  NRadioButton,
  NRadioGroup,
  NRadio,
  NSpace,
  NSelect,
  NSpin,
  NTag
} from 'naive-ui'
import { useModelStore } from '@/stores/model'
import { virtualKeyApi, type VirtualKeyQuotaBulkRequest, type VirtualKeyQuotaPeriod } from '@/api/virtual-key'
import {
  VK_QUOTA_MIN_MILLIONS,
  buildQuotaUpserts,
  createQuotaRow,
  quotaRowsFromServer,
  type VirtualKeyQuotaRow,
  type VirtualKeyQuotaRowUsage
} from '@/utils/virtual-key-quota'
import { formatTokenNumber } from '@/utils/format'
import type { VirtualKey } from '@/types'

/**
 * `singleKeyId` set = one key's view, prefilled with its quotas and usage;
 * null = batch mode, targeting the checked keys or all keys per the scope radio.
 */
const props = defineProps<{
  show: boolean
  virtualKeys: VirtualKey[]
  /** Naive UI row keys of the table's checked rows (string ids in practice). */
  selectedIds: Array<string | number>
  singleKeyId: string | null
}>()

const emit = defineEmits<{ (e: 'update:show', value: boolean): void }>()

const { t } = useI18n()
const message = useMessage()
const modelStore = useModelStore()

const scope = ref<'selected' | 'all'>('selected')
// Counting window of the edited quotas; daily and weekly limits are stored and
// enforced independently server-side, so the whole editor (rows + usage +
// submit payload) is scoped to exactly one period at a time.
const period = ref<VirtualKeyQuotaPeriod>('daily')
const rows = ref<VirtualKeyQuotaRow[]>([])
const submitting = ref(false)

const keysById = computed(() => new Map(props.virtualKeys.map((key) => [key.id, key])))

// Deleted keys must not stay in the batch scope.
const liveSelectedIds = computed(() =>
  props.selectedIds.map(String).filter((id) => keysById.value.has(id))
)

const effectiveIds = computed(() => {
  if (props.singleKeyId) {
    return keysById.value.has(props.singleKeyId) ? [props.singleKeyId] : []
  }
  const ids =
    scope.value === 'selected' ? liveSelectedIds.value : props.virtualKeys.map((key) => key.id)
  return ids.filter((id) => keysById.value.has(id))
})

const singleKeyName = computed(
  () => keysById.value.get(props.singleKeyId ?? '')?.name ?? props.singleKeyId ?? '-'
)

// Usage display is only meaningful for exactly one target key; in batch mode
// per-model usage would be a misleading mix of every key's counters.
const usageKeyId = computed(() =>
  effectiveIds.value.length === 1 ? effectiveIds.value[0] : null
)

const usageLoading = ref(false)
const usageError = ref('')
const usageByModel = ref<Record<string, VirtualKeyQuotaRowUsage>>({})
// Latest-fetch guard: a slow response for a previous key/scope must not
// overwrite the rows shown for the current one.
let usageToken = 0

async function refreshUsage() {
  const id = usageKeyId.value
  if (!id || !props.show) return
  const mine = ++usageToken
  usageLoading.value = true
  usageError.value = ''
  try {
    const response = await virtualKeyApi.getQuotas(id, period.value)
    if (mine !== usageToken) return
    const map: Record<string, VirtualKeyQuotaRowUsage> = {}
    for (const quota of response.quotas ?? []) {
      map[quota.model] = { usedTokens: quota.usedTokens ?? 0, requestCount: quota.requestCount ?? 0 }
    }
    usageByModel.value = map
    // Prefill only while untouched: user-added rows are never clobbered by a
    // late fetch (reopen, retry or single-target scope switch).
    if (rows.value.length === 0) rows.value = quotaRowsFromServer(response.quotas ?? [])
  } catch (error: any) {
    if (mine !== usageToken) return
    usageError.value = error?.message || String(error ?? 'unknown')
  } finally {
    if (mine === usageToken) usageLoading.value = false
  }
}

function reset() {
  scope.value = liveSelectedIds.value.length > 0 ? 'selected' : 'all'
  period.value = 'daily'
  rows.value = []
  submitting.value = false
  usageError.value = ''
}

watch(
  () => props.show,
  (open) => {
    if (!open) return
    reset()
    // The model picker needs the model list; a failed fetch just keeps the
    // previous options (the select stays typeable).
    modelStore.fetchModels().catch(() => undefined)
  },
  { immediate: true }
)

watch(
  [() => props.show, usageKeyId, period],
  ([open]) => {
    if (!open || !usageKeyId.value) {
      usageToken++
      usageLoading.value = false
      usageByModel.value = {}
      return
    }
    void refreshUsage()
  },
  { immediate: true }
)

// Switching between two different single keys invalidates the prefilled rows:
// they mirror one key's stored quotas, not an arbitrary upsert template. The
// same holds for the counting window — rows prefilled (or typed) against one
// period must never be silently resubmitted against the other limit.
watch(usageKeyId, (id, previous) => {
  if (id && previous && id !== previous) rows.value = []
})

watch(period, (next, previous) => {
  if (next !== previous) rows.value = []
})

const modelOptions = computed(() => {
  const seen = new Set<string>()
  const options: Array<{ label: string; value: string }> = []
  for (const model of modelStore.models) {
    if (!model.name || seen.has(model.name)) continue
    seen.add(model.name)
    options.push({
      label: model.isVirtual ? `${model.name} (${t('models.virtualModel')})` : model.name,
      value: model.name
    })
  }
  return options
})

function addRow() {
  rows.value.push(createQuotaRow('set'))
}

function usageOf(row: VirtualKeyQuotaRow): VirtualKeyQuotaRowUsage | null {
  if (!usageKeyId.value) return null
  return usageByModel.value[row.model] ?? null
}

function isOverLimit(row: VirtualKeyQuotaRow): boolean {
  const usage = usageOf(row)
  if (!usage || row.op !== 'set' || typeof row.limitMillions !== 'number') return false
  return usage.usedTokens >= row.limitMillions * 1_000_000
}

async function handleSubmit() {
  const result = buildQuotaUpserts(rows.value)
  if (!result.ok) {
    message.error(
      result.reason === 'duplicate-model'
        ? t('virtualKeys.quotas.duplicateModel', { model: result.model })
        : t('virtualKeys.quotas.invalidLimit', { model: result.model })
    )
    return
  }
  if (result.upserts.length === 0) {
    message.warning(t('virtualKeys.quotas.emptySubmit'))
    return
  }
  if (effectiveIds.value.length === 0) {
    message.warning(t('virtualKeys.quotas.noTargets'))
    return
  }

  submitting.value = true
  try {
    const body: VirtualKeyQuotaBulkRequest = {
      virtualKeyIds: effectiveIds.value,
      quotas: result.upserts
    }
    // 'daily' is the server default; only weekly needs the explicit field.
    if (period.value === 'weekly') body.period = 'weekly'
    await virtualKeyApi.updateQuotasBulk(body)
    message.success(t('virtualKeys.quotas.saveSuccess', { n: effectiveIds.value.length }))
    emit('update:show', false)
  } catch (error: any) {
    message.error(error?.message || String(error ?? 'unknown'))
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.quota-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 20px;
  max-height: calc(85vh - 160px);
  overflow-y: auto;
}

.quota-period-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.quota-period-label {
  color: #999;
  font-size: 13px;
}

.quota-target-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.quota-target-label {
  color: #999;
  font-size: 13px;
}

.quota-apply-to {
  font-size: 12px;
  color: #999;
}

.quota-apply-to-danger {
  color: #d03050;
}

.quota-usage-error {
  display: flex;
  align-items: center;
  gap: 12px;
}

.quota-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 40px;
}

.quota-row {
  display: grid;
  grid-template-columns: minmax(180px, 1.3fr) auto minmax(110px, 150px) minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
}

/* Batch scope: no usage column, keep head and rows on one shared 4-column grid. */
.quota-row.no-usage {
  grid-template-columns: minmax(180px, 1.3fr) auto minmax(110px, 150px) auto;
}

.quota-row-head {
  font-size: 12px;
  color: #999;
  padding-bottom: 0;
}

.quota-cell-model {
  min-width: 0;
}

.quota-cell-limit {
  width: 100%;
}

.quota-usage {
  font-size: 12px;
  color: #666;
}

.quota-usage.is-over {
  color: #d03050;
  font-weight: 600;
}

.quota-empty {
  font-size: 12px;
  color: #999;
  padding: 12px 0;
}

.quota-hint {
  margin-top: 8px;
}
</style>

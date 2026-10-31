<template>
  <n-space vertical :size="8" style="width: 100%;">
    <div class="quota-heading">
      <span>{{ $t('settings.modelDailyTokenQuota') }}</span>
      <n-popover trigger="click" placement="bottom-start" :style="{ maxWidth: 'min(360px, 85vw)' }">
        <template #trigger>
          <n-button quaternary circle size="tiny" :aria-label="$t('settings.modelDailyTokenQuotaInfo')">
            <template #icon><n-icon><InformationCircleOutline /></n-icon></template>
          </n-button>
        </template>
        {{ $t('settings.modelDailyTokenQuotaDesc') }}
      </n-popover>
    </div>

    <n-space
      v-for="(row, index) in quotaRows"
      :key="index"
      align="center"
      :size="8"
      style="width: 100%;"
    >
      <n-select
        v-model:value="row.model"
        :options="quotaModelOptions"
        filterable
        tag
        :placeholder="$t('settings.modelDailyTokenQuotaModelPlaceholder')"
        style="width: 280px;"
      />
      <n-input-number
        v-model:value="row.limitMillions"
        :min="0.001"
        :step="1"
        :show-spin-buttons="true"
        size="small"
        style="width: 140px;"
      />
      <n-text depth="3" style="font-size: 12px;">M</n-text>
      <n-text v-if="quotaUsageOf(row.model)" depth="3" style="font-size: 12px;">
        {{
          $t('settings.modelDailyTokenQuotaUsed', {
            used: formatTokens(quotaUsageOf(row.model)!.usedTokens),
            limit: formatTokens(quotaUsageOf(row.model)!.limitTokens),
          })
        }}
      </n-text>
      <n-button size="tiny" quaternary @click="quotaRows.splice(index, 1)">
        {{ $t('common.delete') }}
      </n-button>
    </n-space>

    <n-space :size="8">
      <n-button size="small" @click="quotaRows.push({ model: null, limitMillions: 1 })">
        {{ $t('settings.modelDailyTokenQuotaAdd') }}
      </n-button>
      <n-button
        type="primary"
        size="small"
        :loading="savingQuota"
        :disabled="!isQuotaChanged"
        @click="onSaveModelQuotas"
      >
        {{ $t('common.save') }}
      </n-button>
      <n-button size="small" :disabled="!isQuotaChanged" @click="onResetModelQuotas">
        {{ $t('common.reset') }}
      </n-button>
    </n-space>
  </n-space>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NSpace, NText, NButton, NSelect, NInputNumber, NPopover, NIcon, useMessage } from 'naive-ui';
import { InformationCircleOutline } from '@vicons/ionicons5';
import { useI18n } from 'vue-i18n';
import { useModelStore } from '@/stores/model';
import { configApi, type ModelDailyTokenLimit } from '@/api/config';

const { t } = useI18n();
const modelStore = useModelStore();
const message = useMessage();

interface QuotaRow {
  model: string | null;
  limitMillions: number | null;
}

const quotaRows = ref<QuotaRow[]>([]);
const quotaRowsOriginal = ref('[]');
const quotaUsage = ref<ModelDailyTokenLimit[]>([]);
const savingQuota = ref(false);

// 额度按模型名计量：虚拟模型与它路由到的真实模型各自一条，不合并。
const quotaModelOptions = computed(() => {
  const seen = new Set<string>();
  const options: Array<{ label: string; value: string }> = [];
  for (const model of modelStore.models) {
    if (seen.has(model.name)) continue;
    seen.add(model.name);
    options.push({
      label: model.isVirtual ? `${model.name} (${t('models.virtualModel')})` : model.name,
      value: model.name,
    });
  }
  return options;
});

function quotaUsageOf(model: string | null): ModelDailyTokenLimit | undefined {
  if (!model) return undefined;
  return quotaUsage.value.find(entry => entry.model === model.trim());
}

function normalizeQuotaRows(rows: QuotaRow[]): string {
  return JSON.stringify(
    rows
      .map(row => ({ model: (row.model || '').trim(), limitMillions: row.limitMillions }))
      .filter(row => row.model)
      .sort((a, b) => a.model.localeCompare(b.model)),
  );
}

const isQuotaChanged = computed(() => normalizeQuotaRows(quotaRows.value) !== quotaRowsOriginal.value);

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

async function onSaveModelQuotas() {
  const payload = quotaRows.value
    .map(row => ({ model: (row.model || '').trim(), limitMillions: row.limitMillions }))
    .filter(row => row.model && typeof row.limitMillions === 'number' && row.limitMillions > 0);
  try {
    savingQuota.value = true;
    await configApi.updateSystemSettings({ modelDailyTokenLimits: payload });
    await refreshModelQuotas();
    message.success(t('messages.operationSuccess'));
  } catch (e: any) {
    message.error(e.message || t('messages.operationFailed'));
  } finally {
    savingQuota.value = false;
  }
}

function onResetModelQuotas() {
  applyQuotaRows(quotaUsage.value);
}

function applyQuotaRows(entries: ModelDailyTokenLimit[]) {
  quotaRows.value = entries.map(entry => ({ model: entry.model, limitMillions: entry.limitMillions }));
  quotaRowsOriginal.value = normalizeQuotaRows(quotaRows.value);
}

async function refreshModelQuotas() {
  const s = await configApi.getSystemSettings();
  quotaUsage.value = s.modelDailyTokenLimits || [];
  applyQuotaRows(quotaUsage.value);
}

onMounted(async () => {
  try {
    await Promise.all([
      modelStore.fetchModels(),
      refreshModelQuotas(),
    ]);
  } catch (error: any) {
    console.error('初始化模型预算失败:', error);
    message.error(error?.message || t('messages.loadFailed'));
  }
});
</script>

<style scoped>
.quota-heading {
  display: flex;
  align-items: center;
  gap: 4px;
}
</style>

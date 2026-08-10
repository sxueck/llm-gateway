<template>
  <n-space vertical :size="16">
    <n-alert type="info" :show-icon="false">
      {{ t('expertRouting.trainingRecordsHint') }}
    </n-alert>

    <n-space justify="space-between" wrap>
      <n-select
        v-model:value="status"
        :options="statusOptions"
        style="width: 180px"
      />
      <n-space>
        <n-button :loading="loading" @click="loadRecords">{{ t('expertRouting.refreshTrainingRecords') }}</n-button>
        <n-button type="primary" :loading="exporting" @click="exportAccepted">{{ t('expertRouting.exportAcceptedJsonl') }}</n-button>
      </n-space>
    </n-space>

    <n-spin :show="loading">
      <n-empty v-if="!loading && records.length === 0" :description="t('expertRouting.noTrainingRecords')" :show-icon="false" />
      <n-card v-for="record in records" :key="record.id" size="small" class="record-card">
        <template #header>
          <n-space align="center" :size="8">
            <n-tag :type="statusTagType(record.status)" size="small">{{ statusLabel(record.status) }}</n-tag>
            <n-text code>{{ record.judge_intent_label }}</n-text>
            <n-text depth="3" class="record-meta">{{ t('expertRouting.trainingRecordConfidence', { confidence: formatConfidence(record.judge_confidence), count: record.occurrence_count }) }}</n-text>
          </n-space>
        </template>

        <n-space vertical :size="12">
          <pre class="input-text">{{ record.input_text }}</pre>
          <n-text v-if="record.judge_reason" depth="3">{{ t('expertRouting.trainingRecordJudgeReason', { reason: record.judge_reason }) }}</n-text>
          <n-space align="center" wrap>
            <n-text strong>{{ t('expertRouting.trainingRecordFinalLabel') }}</n-text>
            <n-select
              v-model:value="record.final_intent_label"
              :options="labelOptions"
              filterable
              style="width: 300px"
            />
            <n-button type="success" size="small" @click="reviewRecord(record, 'accepted')">{{ t('expertRouting.acceptTrainingRecord') }}</n-button>
            <n-button type="error" secondary size="small" @click="reviewRecord(record, 'rejected')">{{ t('expertRouting.rejectTrainingRecord') }}</n-button>
          </n-space>
          <n-text depth="3" class="record-meta">{{ t('expertRouting.trainingRecordUpdatedAt', { time: formatTime(record.updated_at) }) }}</n-text>
        </n-space>
      </n-card>
    </n-spin>
  </n-space>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMessage, NAlert, NButton, NCard, NEmpty, NSelect, NSpace, NSpin, NTag, NText } from 'naive-ui';
import { EXPERT_ROUTING_LABELS } from '@llm-gateway/shared';
import {
  expertRoutingApi,
  type ExpertRoutingTrainingRecord,
  type TrainingRecordStatus,
} from '@/api/expert-routing';

interface Props {
  configId: string;
}

const props = defineProps<Props>();
const { t, locale } = useI18n();
const message = useMessage();
const records = ref<ExpertRoutingTrainingRecord[]>([]);
const status = ref<TrainingRecordStatus>('pending_review');
const loading = ref(false);
const exporting = ref(false);

const statusOptions = computed(() => [
  { label: t('expertRouting.trainingRecordPendingReview'), value: 'pending_review' },
  { label: t('expertRouting.trainingRecordAccepted'), value: 'accepted' },
  { label: t('expertRouting.trainingRecordRejected'), value: 'rejected' },
]);
const labelOptions = EXPERT_ROUTING_LABELS.map((label) => ({
  label: `${label.displayName} (${label.label})`,
  value: label.label,
}));

function statusLabel(value: TrainingRecordStatus) {
  return statusOptions.value.find((option) => option.value === value)?.label || value;
}

function statusTagType(value: TrainingRecordStatus) {
  return value === 'accepted' ? 'success' : value === 'rejected' ? 'error' : 'warning';
}

function formatConfidence(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatTime(value: number) {
  return new Date(value).toLocaleString(locale.value);
}

async function loadRecords() {
  loading.value = true;
  try {
    const response = await expertRoutingApi.getTrainingRecords(props.configId, status.value);
    records.value = response.records;
  } catch (error: any) {
    message.error(error.message || t('expertRouting.trainingRecordLoadFailed'));
  } finally {
    loading.value = false;
  }
}

async function reviewRecord(record: ExpertRoutingTrainingRecord, nextStatus: TrainingRecordStatus) {
  try {
    await expertRoutingApi.reviewTrainingRecord(props.configId, record.id, {
      status: nextStatus,
      final_intent_label: record.final_intent_label,
    });
    message.success(t(nextStatus === 'accepted' ? 'expertRouting.trainingRecordAccepted' : 'expertRouting.trainingRecordRejected'));
    await loadRecords();
  } catch (error: any) {
    message.error(error.message || t('expertRouting.trainingRecordReviewFailed'));
  }
}

async function exportAccepted() {
  exporting.value = true;
  try {
    const jsonl = await expertRoutingApi.exportTrainingRecords(props.configId);
    const url = URL.createObjectURL(new Blob([jsonl], { type: 'application/x-ndjson;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `expert-routing-${props.configId}-accepted.jsonl`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (error: any) {
    message.error(error.message || t('expertRouting.trainingRecordExportFailed'));
  } finally {
    exporting.value = false;
  }
}

watch(status, loadRecords);
onMounted(loadRecords);
</script>

<style scoped>
.record-card {
  border-color: var(--n-border-color);
}

.record-meta {
  font-size: 12px;
}

.input-text {
  max-height: 180px;
  margin: 0;
  overflow: auto;
  padding: 10px;
  border-radius: 6px;
  background: var(--n-code-color, #f5f5f5);
  color: var(--n-text-color);
  font-family: var(--n-font-family-mono);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
}
</style>

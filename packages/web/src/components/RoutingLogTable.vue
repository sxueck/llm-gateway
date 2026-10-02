<template>
  <div class="routing-log-table">
    <n-space vertical :size="12">
      <n-space :size="12" align="center" wrap>
        <n-select
          v-model:value="bandFilter"
          :options="bandOptions"
          size="small"
          clearable
          :placeholder="t('expertRouting.allBands')"
          class="filter-select"
        />
        <n-select
          v-model:value="sourceFilter"
          :options="sourceOptions"
          size="small"
          clearable
          :placeholder="t('expertRouting.allSources')"
          class="filter-select"
        />
        <n-input
          v-model:value="virtualKeyFilter"
          size="small"
          clearable
          :placeholder="t('expertRouting.virtualKeyFilter')"
          class="filter-input"
        />
        <n-button size="small" :loading="exporting" @click="exportTrainingRecords">
          {{ t('expertRouting.exportReplaySet') }}
        </n-button>
      </n-space>

      <n-data-table
        :scroll-x="1000"
        :row-key="(row: ExpertRoutingLog) => row.id"
        :columns="columns"
        :data="filteredLogs"
        :loading="loading"
        :pagination="filteredLogs.length ? { pageSize: 20 } : false"
        :row-props="rowProps"
        size="small"
      >
        <template #empty>
          <n-empty :description="t('expertRouting.ui.noLogs')" class="log-empty" />
        </template>
      </n-data-table>
    </n-space>

    <n-drawer
      v-model:show="showDetail"
      width="min(520px, 92vw)"
      placement="right"
      :auto-focus="true"
      :close-on-esc="true"
      :trap-focus="true"
    >
      <n-drawer-content
        :title="t('expertRouting.logDetails')"
        closable
        class="log-detail-drawer"
      >
        <n-spin :show="detailLoading">
          <n-space v-if="detail" vertical :size="16">
            <n-card size="small">
              <n-space vertical :size="6">
                <div class="detail-row">
                  <span class="detail-label">{{ t('common.time') }}</span>
                  <span>{{ formatTime(detail.created_at) }}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">{{ t('expertRouting.difficulty') }}</span>
                  <span>
                    {{ detail.difficulty || '—' }} /
                    {{ detail.band || '—' }}
                  </span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">{{ t('expertRouting.source') }}</span>
                  <n-tag size="small" :type="sourceTagType(detail.route_source)">
                    {{ detail.route_source ? routeSourceLabel(detail.route_source) : '—' }}
                  </n-tag>
                </div>
                <div class="detail-row">
                  <span class="detail-label">{{ t('expertRouting.selectedExpert') }}</span>
                  <span>{{ detail.selected_expert_name || '—' }}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">{{ t('expertRouting.classifierModel') }}</span>
                  <span>{{ detail.classifier_model || '—' }}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">{{ t('expertRouting.classificationTime') }}</span>
                  <span>
                    {{
                      detail.classifier_time_ms != null
                        ? `${detail.classifier_time_ms}ms`
                        : `${detail.classification_time}ms`
                    }}
                  </span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">{{ t('expertRouting.promptTokens') }}</span>
                  <span>{{ detail.prompt_tokens ?? '—' }}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">{{ t('expertRouting.cleanedLength') }}</span>
                  <span>{{ detail.cleaned_content_length ?? '—' }}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">{{ t('expertRouting.virtualKey') }}</span>
                  <span>{{ detail.virtual_key_id || '—' }}</span>
                </div>
              </n-space>
            </n-card>

            <n-card size="small" :title="t('expertRouting.rankedProbabilities')">
              <n-space v-if="ranked.length > 0" vertical :size="6">
                <div v-for="item in ranked" :key="item.expertId" class="ranked-row">
                  <span class="ranked-label">{{ item.expertId }}</span>
                  <n-progress
                    type="line"
                    :percentage="Math.round(Number(item.probability || 0) * 100)"
                    :show-indicator="false"
                    class="ranked-progress"
                  />
                  <span class="ranked-value">
                    {{ (Number(item.probability || 0) * 100).toFixed(1) }}%
                  </span>
                </div>
              </n-space>
              <n-empty v-else :description="t('common.noData')" :show-icon="false" />
            </n-card>

            <n-card size="small" :title="t('expertRouting.metaInfo')">
              <n-space vertical :size="6">
                <div class="detail-row">
                  <span class="detail-label">{{ t('expertRouting.verdictReused') }}</span>
                  <span class="detail-value">{{ detail.verdict_reused ? t('expertRouting.ui.yes') : t('expertRouting.ui.no') }}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">{{ t('expertRouting.continuation') }}</span>
                  <span class="detail-value">{{ classifierMeta.continuation ? t('expertRouting.ui.yes') : t('expertRouting.ui.no') }}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">{{ t('expertRouting.confidence') }}</span>
                  <span>
                    {{
                      classifierMeta.verdictConfidence != null
                        ? `${Math.round(Number(classifierMeta.verdictConfidence) * 100)}%`
                        : '—'
                    }}
                  </span>
                </div>
              </n-space>
            </n-card>
            <n-card size="small" :title="t('expertRouting.feedbackTitle')">
              <n-space :size="8" align="center">
                <n-button
                  size="small"
                  type="warning"
                  :loading="feedbackLoading"
                  :disabled="!detailLogId"
                  @click="submitFeedback('too_low')"
                >
                  {{ t('expertRouting.judgedTooLow') }}
                </n-button>
                <n-button
                  size="small"
                  type="warning"
                  :loading="feedbackLoading"
                  :disabled="!detailLogId"
                  @click="submitFeedback('too_high')"
                >
                  {{ t('expertRouting.judgedTooHigh') }}
                </n-button>
                <n-text depth="3" style="font-size: 12px">
                  {{ t('expertRouting.feedbackHint') }}
                </n-text>
              </n-space>
            </n-card>
          </n-space>
        </n-spin>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NButton,
  NCard,
  NDataTable,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NInput,
  NProgress,
  NSelect,
  NSpace,
  NSpin,
  NTag,
  NText,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import {
  expertRoutingApi,
  type ExpertRoutingLog,
  type ExpertRoutingLogDetail,
} from '@/api/expert-routing';

interface Props {
  configId: string;
}

const props = defineProps<Props>();

const { t } = useI18n();

const ROUTE_SOURCES = [
  'session',
  'jev',
  'fail_open',
  'intent_api',
  'llm_second_pass',
  'fallback',
] as const;

const logs = ref<ExpertRoutingLog[]>([]);
const loading = ref(false);
const bandFilter = ref<string | null>(null);
const sourceFilter = ref<string | null>(null);
const virtualKeyFilter = ref('');
const showDetail = ref(false);
const detail = ref<ExpertRoutingLogDetail | null>(null);
const detailLoading = ref(false);
const detailLogId = ref<string | null>(null);
const feedbackLoading = ref(false);
const exporting = ref(false);
const message = useMessage();

const bandOptions = computed(() => ['low', 'medium', 'high'].map((band) => ({
  label: t(`expertRouting.band.${band}`),
  value: band,
})));

const sourceOptions = computed(() => ROUTE_SOURCES.map((source) => ({
  label: routeSourceLabel(source),
  value: source,
})));

function routeSourceLabel(source: string): string {
  const key = `expertRouting.ui.source.${source}`;
  const translated = t(key);
  return translated === key ? source.replace(/_/g, ' ') : translated;
}

const filteredLogs = computed(() => {
  return logs.value.filter((log) => {
    if (bandFilter.value && log.band !== bandFilter.value) return false;
    if (sourceFilter.value && log.route_source !== sourceFilter.value) return false;
    const vk = virtualKeyFilter.value.trim();
    if (vk && !(log.virtual_key_id || '').includes(vk)) return false;
    return true;
  });
});

const ranked = computed(() => {
  const response = detail.value?.classifier_response;
  const list = response && typeof response === 'object' ? response.ranked : null;
  return Array.isArray(list) ? list : [];
});

const classifierMeta = computed<Record<string, any>>(() => {
  const response = detail.value?.classifier_response;
  if (!response || typeof response !== 'object') return {};
  const meta = response.meta;
  return meta && typeof meta === 'object' ? meta : response;
});

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function bandTagType(band?: string | null): 'success' | 'warning' | 'error' | 'default' {
  const map: Record<string, 'success' | 'warning' | 'error'> = {
    low: 'success',
    medium: 'warning',
    high: 'error',
  };
  return band ? map[band] ?? 'default' : 'default';
}

function sourceTagType(source?: string): 'success' | 'warning' | 'error' | 'info' | 'default' {
  const map: Record<string, 'success' | 'warning' | 'error' | 'info'> = {
    session: 'info',
    jev: 'success',
    fail_open: 'warning',
    intent_api: 'info',
    llm_second_pass: 'success',
    fallback: 'error',
  };
  return source ? map[source] ?? 'default' : 'default';
}

const columns: DataTableColumns<ExpertRoutingLog> = [
  {
    title: () => t('common.time'),
    key: 'created_at',
    width: 170,
    render: (row) => formatTime(row.created_at),
  },
  {
    title: () => t('expertRouting.ui.bandLabel'),
    key: 'band',
    width: 90,
    render: (row) =>
      row.band
        ? h(
            NTag,
            { size: 'small', type: bandTagType(row.band), bordered: false },
            { default: () => row.band },
          )
        : '—',
  },
  {
    title: () => t('expertRouting.source'),
    key: 'route_source',
    width: 130,
    render: (row) => (row.route_source ? routeSourceLabel(row.route_source) : '—'),
  },
  {
    title: () => t('expertRouting.difficulty'),
    key: 'difficulty',
    width: 90,
    render: (row) => row.difficulty || '—',
  },
  {
    title: () => t('expertRouting.selectedExpert'),
    key: 'selected_expert_name',
    ellipsis: { tooltip: true },
  },
  {
    title: () => t('expertRouting.classificationTime'),
    key: 'classifier_time_ms',
    width: 110,
    render: (row) =>
      row.classifier_time_ms != null ? `${row.classifier_time_ms}ms` : '—',
  },
  {
    title: () => t('expertRouting.verdictReused'),
    key: 'verdict_reused',
    width: 90,
    render: (row) =>
      row.verdict_reused != null
        ? row.verdict_reused
          ? t('expertRouting.ui.yes')
          : t('expertRouting.ui.no')
        : '—',
  },
];

const rowProps = (row: ExpertRoutingLog) => ({
  style: 'cursor: pointer',
  tabindex: 0,
  'aria-label': t('expertRouting.ui.viewLogDetails'),
  onClick: () => handleRowClick(row),
  onKeydown: (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleRowClick(row);
    }
  },
});

async function loadLogs() {
  loading.value = true;
  try {
    const response = await expertRoutingApi.getLogs(props.configId, 100);
    logs.value = response.logs;
  } catch (error: any) {
    message.error(error.message || t('messages.operationFailed'));
  } finally {
    loading.value = false;
  }
}

async function handleRowClick(log: ExpertRoutingLog) {
  showDetail.value = true;
  detailLoading.value = true;
  detail.value = null;
  detailLogId.value = log.id;
  try {
    detail.value = await expertRoutingApi.getLogDetails(props.configId, log.id);
  } catch (error: any) {
    message.error(error.message || t('messages.operationFailed'));
  } finally {
    detailLoading.value = false;
  }
}

/** §5.9: mark a verdict as too low / too high; the corrected tier is persisted. */
async function submitFeedback(rating: 'too_low' | 'too_high') {
  if (!detailLogId.value) return;
  feedbackLoading.value = true;
  try {
    const result = await expertRoutingApi.submitLogFeedback(
      props.configId,
      detailLogId.value,
      rating,
    );
    message.success(
      t('expertRouting.feedbackRecorded', { tier: result.corrected }),
    );
  } catch (error: any) {
    message.error(error?.message || t('expertRouting.feedbackFailed'));
  } finally {
    feedbackLoading.value = false;
  }
}

/** §5.9: download the replay set as JSON for classifier tuning. */
async function exportTrainingRecords() {
  exporting.value = true;
  try {
    const { records } = await expertRoutingApi.getTrainingRecords(props.configId, {
      limit: 1000,
    });
    const blob = new Blob([JSON.stringify(records, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tier-routing-replay-${props.configId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (error: any) {
    message.error(error?.message || t('expertRouting.feedbackFailed'));
  } finally {
    exporting.value = false;
  }
}

onMounted(loadLogs);
</script>

<style scoped>
.filter-select {
  width: 150px;
  max-width: 100%;
}

.filter-input {
  width: 220px;
  max-width: 100%;
}

.log-empty {
  padding: 24px 0;
}

.detail-row {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  min-width: 0;
}

.detail-row > span:last-child {
  min-width: 0;
  overflow-wrap: anywhere;
}

.detail-value {
  word-break: break-all;
}

.detail-label {
  flex: none;
  width: 110px;
  color: #8c8c8c;
  font-size: 12px;
}

.ranked-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.ranked-row .n-progress {
  flex: 1 1 auto;
  min-width: 60px;
}

.ranked-label {
  width: 140px;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ranked-value {
  font-size: 12px;
  width: 56px;
  text-align: right;
}
</style>

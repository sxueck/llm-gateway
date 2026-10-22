<template>
  <div class="routing-simulator">
    <n-space vertical :size="12">
      <n-card size="small" :title="t('expertRouting.simulatorTitle')">
        <template #header-extra>
          <n-text depth="3" class="simulator-hint">
            {{ t('expertRouting.simulatorHint') }}
          </n-text>
        </template>
        <n-space vertical :size="12">
          <n-alert v-if="draft" type="info" :show-icon="true">
            {{ t('expertRouting.draftHint') }}
          </n-alert>
          <n-form label-placement="top" size="small">
            <n-form-item :label="t('expertRouting.prompt')">
              <n-input
                v-model:value="prompt"
                type="textarea"
                :rows="4"
                :placeholder="t('expertRouting.promptPlaceholder')"
              />
            </n-form-item>
            <n-form-item :label="t('expertRouting.pasteMessages')">
              <n-switch v-model:value="useMessages" />
            </n-form-item>
            <n-form-item v-if="useMessages" :show-label="false">
              <n-input
                v-model:value="messagesJson"
                type="textarea"
                :rows="5"
                :placeholder="t('expertRouting.messagesPlaceholder')"
              />
            </n-form-item>
          </n-form>
          <n-space justify="end">
            <n-button
              type="primary"
              size="small"
              :loading="loading"
              :disabled="!canRun"
              @click="handleSimulate"
            >
              <template #icon>
                <n-icon><PlayOutline /></n-icon>
              </template>
              {{ t('expertRouting.runSimulate') }}
            </n-button>
          </n-space>
        </n-space>
      </n-card>

      <n-alert v-if="errorMessage" type="error" :show-icon="true">
        {{ errorMessage }}
      </n-alert>

      <template v-if="result">
        <n-card size="small" :title="t('expertRouting.simulationResult')">
          <n-space vertical :size="12">
            <n-grid :cols="'1 640:3'" responsive="screen" :x-gap="12">
              <n-gi>
                <n-statistic :label="t('expertRouting.difficulty')">
                  <n-tag :type="difficultyTagType" size="small">
                    {{ t(`expertRouting.band.${result.difficulty}`) }}
                  </n-tag>
                </n-statistic>
              </n-gi>
              <n-gi>
                <n-statistic
                  :label="t('expertRouting.confidence')"
                  :value="Math.round(result.confidence * 100) + '%'"
                />
              </n-gi>
              <n-gi>
                <n-statistic
                  :label="t('expertRouting.classificationTime')"
                  :value="result.classifierTimeMs"
                >
                  <template #suffix>ms</template>
                </n-statistic>
              </n-gi>
            </n-grid>

            <div>
              <n-text depth="3" class="section-label">
                {{ t('expertRouting.confidence') }}
              </n-text>
              <n-progress
                type="line"
                :percentage="Math.round(result.confidence * 100)"
                :height="12"
              />
            </div>

            <div>
              <n-text depth="3" class="section-label">
                {{ t('expertRouting.intentText') }}
              </n-text>
              <n-code :code="result.intentText || '—'" word-wrap class="intent-code" />
              <n-text depth="3" class="token-stats">
                {{ tokenStatsText }}
              </n-text>
            </div>

            <div>
              <n-text depth="3" class="section-label">
                {{ t('expertRouting.rankedProbabilities') }}
              </n-text>
              <n-space vertical :size="6">
                <div
                  v-for="item in result.ranked"
                  :key="item.expertId"
                  class="ranked-row"
                >
                  <span class="ranked-label">{{ labelOf(item.expertId) }}</span>
                  <n-progress
                    type="line"
                    :percentage="Math.round(item.probability * 100)"
                    :show-indicator="false"
                    class="ranked-progress"
                  />
                  <span class="ranked-value">
                    {{ (item.probability * 100).toFixed(1) }}%
                  </span>
                </div>
              </n-space>
            </div>

            <div>
              <n-text depth="3" class="section-label">
                {{ t('expertRouting.candidateOrder') }}
              </n-text>
              <n-space :size="6">
                <n-tag
                  v-for="candidate in result.candidates"
                  :key="candidate.id"
                  size="small"
                  :type="bandTagType(candidate.band)"
                  :class="{ 'would-hit': candidate.id === result.wouldHit }"
                >
                  {{ labelOf(candidate.id)
                  }}{{ candidate.id === result.wouldHit ? ' ✓' : '' }}
                </n-tag>
                <n-text v-if="!result.wouldHit" depth="3" class="no-hit">
                  {{ t('expertRouting.noWouldHit') }}
                </n-text>
              </n-space>
            </div>

            <n-text depth="3" class="classifier-line">
              {{ t('expertRouting.classifierModel') }}: {{ result.classifierModel }}
            </n-text>
          </n-space>
        </n-card>
      </template>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NAlert,
  NButton,
  NCard,
  NCode,
  NForm,
  NFormItem,
  NGi,
  NGrid,
  NIcon,
  NInput,
  NProgress,
  NSpace,
  NStatistic,
  NSwitch,
  NTag,
  NText,
} from 'naive-ui';
import { PlayOutline } from '@vicons/ionicons5';
import {
  expertRoutingApi,
  type Band,
  type ExpertTarget,
  type PreprocessingConfig,
  type RoutingSimulation,
} from '@/api/expert-routing';

interface Props {
  routingId: string;
  experts: ExpertTarget[];
  preprocessing?: PreprocessingConfig;
  /** 有未保存修改时用草稿配置模拟，否则按已保存配置模拟。 */
  draft?: boolean;
  resolveExpertLabel?: (expertId: string) => string;
}

const props = defineProps<Props>();

const { t } = useI18n();

const prompt = ref('');
const useMessages = ref(false);
const messagesJson = ref('');
const loading = ref(false);
const errorMessage = ref('');
const result = ref<RoutingSimulation | null>(null);

const canRun = computed(() =>
  useMessages.value ? !!messagesJson.value.trim() : !!prompt.value.trim(),
);

const difficultyTagType = computed(() => {
  const map: Record<string, 'success' | 'warning' | 'error'> = {
    low: 'success',
    medium: 'warning',
    high: 'error',
  };
  return result.value ? map[result.value.difficulty] ?? 'default' : 'default';
});

const tokenStatsText = computed(() => {
  const stats = result.value?.stats;
  if (!stats) return '';
  const parts: string[] = [];
  if (stats.promptTokens != null)
    parts.push(`${t('expertRouting.promptTokens')}: ${stats.promptTokens}`);
  if (stats.originalTokens != null)
    parts.push(`${t('expertRouting.originalTokens')}: ${stats.originalTokens}`);
  if (stats.cleanedTokens != null)
    parts.push(`${t('expertRouting.cleanedTokens')}: ${stats.cleanedTokens}`);
  if (stats.cleanedLength != null)
    parts.push(`${t('expertRouting.cleanedLength')}: ${stats.cleanedLength}`);
  return parts.join(' · ');
});

function bandTagType(band: Band): 'success' | 'warning' | 'error' | 'default' {
  const map: Record<Band, 'success' | 'warning' | 'error'> = {
    low: 'success',
    medium: 'warning',
    high: 'error',
  };
  return map[band] ?? 'default';
}

function labelOf(expertId: string): string {
  if (props.resolveExpertLabel) return props.resolveExpertLabel(expertId);
  const expert = props.experts.find((e) => e.id === expertId);
  return expert ? expert.model || expert.model_id || expert.id : expertId;
}

async function handleSimulate() {
  errorMessage.value = '';
  result.value = null;

  let input: { prompt?: string; messages?: any[] };
  if (useMessages.value) {
    let parsed: any;
    try {
      parsed = JSON.parse(messagesJson.value);
    } catch (error: any) {
      errorMessage.value = t('expertRouting.messagesJsonError', {
        error: error?.message || error,
      });
      return;
    }
    if (!Array.isArray(parsed)) {
      errorMessage.value = t('expertRouting.messagesJsonError', {
        error: 'not an array',
      });
      return;
    }
    input = { messages: parsed };
  } else {
    input = { prompt: prompt.value };
  }

  loading.value = true;
  try {
    result.value = props.draft
      ? await expertRoutingApi.simulate(
          { experts: props.experts, preprocessing: props.preprocessing },
          input,
        )
      : await expertRoutingApi.simulateById(props.routingId, input);
  } catch (error: any) {
    errorMessage.value = `${t('expertRouting.simulationFailed')}: ${error?.message || error}`;
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.simulator-hint {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40vw;
}

@media (max-width: 640px) {
  .simulator-hint {
    display: none;
  }
}

.section-label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
}

.intent-code {
  font-size: 12px;
  max-width: 100%;
}

.intent-code :deep(pre) {
  white-space: pre-wrap;
  word-break: break-word;
}

.token-stats {
  display: block;
  margin-top: 6px;
  font-size: 12px;
}

.ranked-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.ranked-label {
  flex: none;
  width: 160px;
  max-width: 40%;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ranked-row .n-progress {
  flex: 1 1 auto;
  min-width: 60px;
}

.ranked-value {
  flex: none;
  font-size: 12px;
  width: 56px;
  text-align: right;
}

.would-hit {
  font-weight: 600;
  box-shadow: 0 0 0 1px currentcolor inset;
}

.no-hit {
  font-size: 12px;
}

.classifier-line {
  font-size: 12px;
}
</style>

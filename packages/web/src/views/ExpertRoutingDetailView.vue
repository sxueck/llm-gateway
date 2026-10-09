<template>
  <div class="expert-routing-detail" :style="{ '--routing-border': themeVars.borderColor }">
    <n-space vertical :size="12">
      <PageHeader
        eyebrow="ROUTING"
        :title="routing?.name ?? t('expertRouting.detail')"
        :subtitle="t('expertRouting.subtitle')"
      >
        <template #title-extra>
          <n-tag v-if="routing" size="small" :type="routing.enabled ? 'success' : 'default'" :bordered="false">
            {{ routing.enabled ? t('common.enabled') : t('common.disabled') }}
          </n-tag>
        </template>
        <template #actions>
          <n-button size="small" @click="goBack">
            <template #icon>
              <n-icon><ArrowBackOutline /></n-icon>
            </template>
            {{ t('common.back') }}
          </n-button>
          <n-tag v-if="isDirty" size="small" type="warning">
            {{ t('expertRouting.unsavedChanges') }}
          </n-tag>
          <n-button
            size="small"
            type="primary"
            :loading="saving"
            :disabled="!isDirty"
            @click="handleSave"
          >
            <template #icon>
              <n-icon><SaveOutline /></n-icon>
            </template>
            {{ t('common.save') }}
          </n-button>
        </template>
      </PageHeader>

      <n-spin :show="loading">
        <n-tabs v-model:value="activeTab" type="line">
          <n-tab-pane name="config" :tab="t('expertRouting.tabs.config')">
            <div class="config-grid">
              <n-card
                :title="t('expertRouting.basicInfo')"
                size="small"
                class="config-card"
              >
                <n-form label-placement="top" size="small">
                  <n-form-item :label="t('expertRouting.configName')">
                    <n-input v-model:value="form.name" :placeholder="t('expertRouting.configNamePlaceholder')" />
                  </n-form-item>
                  <n-form-item :label="t('expertRouting.configDescription')">
                    <n-input
                      v-model:value="form.description"
                      type="textarea"
                      :rows="2"
                      :placeholder="t('expertRouting.configDescriptionPlaceholder')"
                    />
                  </n-form-item>
                  <n-form-item :label="t('expertRouting.exposedModelName')">
                    <n-input
                      v-model:value="form.virtualModelName"
                      :placeholder="t('expertRouting.exposedModelNamePlaceholder')"
                    />
                  </n-form-item>
                </n-form>
              </n-card>

              <n-card
                :title="t('expertRouting.classifier')"
                size="small"
                class="config-card"
              >
                <n-space vertical :size="12">
                  <div class="classifier-status">
                    <n-spin v-if="jevLoading" size="small" />
                    <n-space v-else-if="jevStatus" :size="20" align="center" wrap>
                      <span>
                        {{ t('expertRouting.classifier') }}:
                        <n-tag
                          size="small"
                          :type="jevStatus.configured ? 'success' : 'warning'"
                        >
                          {{
                            jevStatus.configured
                              ? t('expertRouting.configured')
                              : t('expertRouting.notConfigured')
                          }}
                        </n-tag>
                      </span>
                      <span v-if="jevStatus.model">
                        {{ t('expertRouting.classifierModel') }}:
                        {{ jevStatus.model }}
                      </span>
                      <span>
                        {{ t('expertRouting.breakerState') }}:
                        <n-tag
                          size="small"
                          :type="jevStatus.breaker.open ? 'error' : 'success'"
                        >
                          {{
                            jevStatus.breaker.open
                              ? t('expertRouting.breakerOpen')
                              : t('expertRouting.breakerClosed')
                          }}
                        </n-tag>
                      </span>
                      <span v-if="jevStatus.breaker.consecutiveFailures > 0">
                        {{ t('expertRouting.consecutiveFailures') }}:
                        {{ jevStatus.breaker.consecutiveFailures }}
                      </span>
                      <n-button size="tiny" quaternary @click="loadJevStatus">
                        <template #icon>
                          <n-icon><RefreshOutline /></n-icon>
                        </template>
                        {{ t('common.refresh') }}
                      </n-button>
                    </n-space>
                    <n-text v-else depth="3">
                      {{ t('expertRouting.statusLoadFailed') }}
                    </n-text>
                  </div>
                  <n-alert
                    v-if="jevStatus?.breaker.open"
                    type="error"
                    :show-icon="true"
                  >
                    <div v-if="jevStatus.breaker.openUntil">
                      {{ t('expertRouting.openUntil') }}:
                      {{ new Date(jevStatus.breaker.openUntil).toLocaleString() }}
                    </div>
                    <div v-if="jevStatus.breaker.lastError">
                      {{ t('expertRouting.lastError') }}:
                      {{ jevStatus.breaker.lastError }}
                    </div>
                  </n-alert>
                  <n-alert v-if="jevStatus && !jevStatus.configured" type="warning" :show-icon="true">
                    {{ t('expertRouting.ui.classifierUnavailable') }}
                  </n-alert>
                  <n-divider style="margin: 4px 0" />
                  <n-form label-placement="top" size="small">
                    <n-form-item :label="t('expertRouting.timeoutMs')">
                      <n-input-number
                        v-model:value="form.classifier.timeout_ms"
                        :min="100"
                        :step="500"
                        style="width: 100%"
                      />
                      <template #feedback>
                        {{ t('expertRouting.timeoutMsHint') }}
                      </template>
                    </n-form-item>
                    <n-form-item :label="t('expertRouting.onLowConfidence')">
                      <n-radio-group v-model:value="form.classifier.on_low_confidence">
                        <n-space>
                          <n-radio value="escalate">
                            {{ t('expertRouting.escalateToHigh') }}
                          </n-radio>
                          <n-radio value="keep">
                            {{ t('expertRouting.keepVerdict') }}
                          </n-radio>
                        </n-space>
                      </n-radio-group>
                      <template #feedback>
                        {{ t('expertRouting.onLowConfidenceHint') }}
                      </template>
                    </n-form-item>
                    <n-form-item :label="t('expertRouting.minConfidence')">
                      <n-input-number
                        v-model:value="form.classifier.min_confidence"
                        :min="0"
                        :max="1"
                        :step="0.05"
                        style="width: 100%"
                      />
                      <template #feedback>
                        {{ t('expertRouting.minConfidenceHint') }}
                      </template>
                    </n-form-item>
                  </n-form>
                </n-space>
              </n-card>

              <n-card
                :title="t('expertRouting.tierBoard')"
                size="small"
                class="config-card config-card--wide"
              >
                <TierBoard
                  v-model:experts="form.experts"
                  :routing-id="routingId"
                  :resolve-model-label="resolveModelLabel"
                />
              </n-card>

              <div class="config-section config-card--wide">
                <h3>{{ t('expertRouting.ui.advancedSettings') }}</h3>
                <n-text depth="3">{{ t('expertRouting.ui.advancedSettingsHint') }}</n-text>
              </div>

              <n-card
                :title="t('expertRouting.sessionPolicy')"
                size="small"
                class="config-card"
              >
                <SessionPolicyForm v-model:policy="form.sessionPolicy" />
              </n-card>

              <n-card
                :title="t('expertRouting.preprocessingTitle')"
                size="small"
                class="config-card"
              >
                <n-form label-placement="left" label-align="left" label-width="180" size="small" class="switch-form">
                  <n-form-item :label="t('expertRouting.stripTools')">
                    <n-switch v-model:value="form.preprocessing.strip_tools" />
                    <template #feedback>
                      {{ t('expertRouting.stripToolsHint') }}
                    </template>
                  </n-form-item>
                  <n-form-item :label="t('expertRouting.stripFiles')">
                    <n-switch v-model:value="form.preprocessing.strip_files" />
                    <template #feedback>
                      {{ t('expertRouting.stripFilesHint') }}
                    </template>
                  </n-form-item>
                  <n-form-item :label="t('expertRouting.stripCodeBlocks')">
                    <n-switch v-model:value="form.preprocessing.strip_code_blocks" />
                    <template #feedback>
                      {{ t('expertRouting.stripCodeBlocksHint') }}
                    </template>
                  </n-form-item>
                  <n-form-item :label="t('expertRouting.stripSystemPrompt')">
                    <n-switch v-model:value="form.preprocessing.strip_system_prompt" />
                    <template #feedback>
                      {{ t('expertRouting.stripSystemPromptHint') }}
                    </template>
                  </n-form-item>
                </n-form>
              </n-card>

              <n-card
                :title="t('expertRouting.failOpenStrategy')"
                size="small"
                class="config-card"
              >
                <n-form label-placement="top" size="small">
                  <n-form-item :label="t('expertRouting.ui.failureAction')">
                    <n-radio-group v-model:value="form.failOpen">
                      <n-space>
                        <n-radio value="fallback">
                          {{ t('expertRouting.failOpenFallback') }}
                        </n-radio>
                        <n-radio value="parent">
                          {{ t('expertRouting.failOpenParent') }}
                        </n-radio>
                        <n-radio value="error">
                          {{ t('expertRouting.failOpenError') }}
                        </n-radio>
                      </n-space>
                    </n-radio-group>
                    <template #feedback>
                      {{ t('expertRouting.failOpenStrategyHint') }}
                    </template>
                  </n-form-item>
                  <n-form-item
                    v-if="form.failOpen === 'fallback'"
                    :label="t('expertRouting.fallbackModel')"
                    class="fallback-selector"
                  >
                    <ModelSelector
                      v-model:type="fallbackType"
                      v-model:model-id="fallbackModelId"
                      v-model:provider-id="fallbackProviderId"
                      v-model:model="fallbackModelName"
                      :provider-options="providerOptions"
                      :virtual-model-options="virtualModelOptions"
                    />
                  </n-form-item>
                </n-form>
              </n-card>

              <n-card
                :title="t('expertRouting.exposure')"
                size="small"
                class="config-card"
              >
                <ExposureSettings v-model:exposure="form.exposure" />
              </n-card>

              <div class="config-card config-card--wide config-actions">
                <n-text :type="isDirty ? 'warning' : 'default'" depth="3" aria-live="polite">
                  {{ isDirty ? t('expertRouting.unsavedChanges') : t('expertRouting.ui.savedState') }}
                </n-text>
                <n-button
                  size="small"
                  type="primary"
                  :loading="saving"
                  :disabled="!isDirty"
                  @click="handleSave"
                >
                  {{ t('common.save') }}
                </n-button>
              </div>
            </div>
          </n-tab-pane>

          <n-tab-pane name="simulate" :tab="t('expertRouting.tabs.simulate')">
            <RoutingSimulator
              :routing-id="routingId"
              :experts="form.experts"
              :preprocessing="form.preprocessing"
              :draft="isDirty"
              :resolve-expert-label="resolveExpertLabel"
            />
          </n-tab-pane>

          <n-tab-pane name="monitor" :tab="t('expertRouting.tabs.monitor')">
            <ExpertRoutingStatistics :config-id="routingId" />
          </n-tab-pane>

          <n-tab-pane name="logs" :tab="t('expertRouting.tabs.logs')">
            <RoutingLogTable :config-id="routingId" />
          </n-tab-pane>
        </n-tabs>
      </n-spin>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useMessage, useThemeVars } from 'naive-ui';
import {
  NAlert,
  NButton,
  NCard,
  NDivider,
  NForm,
  NFormItem,
  NIcon,
  NInput,
  NInputNumber,
  NRadio,
  NRadioGroup,
  NSpace,
  NSpin,
  NSwitch,
  NTabPane,
  NTabs,
  NTag,
  NText,
} from 'naive-ui';
import { ArrowBackOutline, RefreshOutline, SaveOutline } from '@vicons/ionicons5';
import {
  expertRoutingApi,
  type ClassifierConfig,
  type ExpertRouting,
  type ExpertTarget,
  type ExposureConfig,
  type FailOpenPolicy,
  type FallbackConfig,
  type JevStatus,
  type PreprocessingConfig,
  type SessionPolicy,
  type UpdateExpertRoutingRequest,
} from '@/api/expert-routing';
import PageHeader from '@/components/PageHeader.vue';
import TierBoard from '@/components/TierBoard.vue';
import SessionPolicyForm from '@/components/SessionPolicyForm.vue';
import ExposureSettings from '@/components/ExposureSettings.vue';
import RoutingSimulator from '@/components/RoutingSimulator.vue';
import ExpertRoutingStatistics from '@/components/ExpertRoutingStatistics.vue';
import RoutingLogTable from '@/components/RoutingLogTable.vue';
import ModelSelector from '@/components/ModelSelector.vue';
import { useProviderStore } from '@/stores/provider';
import { useModelStore } from '@/stores/model';
import { createDefaultSessionPolicy } from '@/utils/expert-routing';

interface DetailForm {
  name: string;
  description: string;
  virtualModelName: string;
  failOpen: FailOpenPolicy;
  preprocessing: PreprocessingConfig;
  experts: ExpertTarget[];
  fallback: FallbackConfig | null;
  sessionPolicy: SessionPolicy;
  classifier: {
    timeout_ms: number | null;
    on_low_confidence: 'escalate' | 'keep';
    min_confidence: number | null;
  };
  exposure: ExposureConfig;
}

const { t } = useI18n();
const message = useMessage();
const themeVars = useThemeVars();
const route = useRoute();
const router = useRouter();
const providerStore = useProviderStore();
const modelStore = useModelStore();

const routingId = computed(() => String(route.params.id ?? ''));

const routing = ref<ExpertRouting | null>(null);
const loading = ref(false);
const saving = ref(false);
const activeTab = ref('config');
const jevStatus = ref<JevStatus | null>(null);
const jevLoading = ref(false);

const form = ref<DetailForm>(createEmptyForm());
const savedSnapshot = ref('');

function createEmptyForm(): DetailForm {
  return {
    name: '',
    description: '',
    virtualModelName: '',
    failOpen: 'fallback',
    preprocessing: {
      strip_tools: false,
      strip_files: false,
      strip_code_blocks: false,
      strip_system_prompt: false,
    },
    experts: [],
    fallback: null,
    sessionPolicy: createDefaultSessionPolicy(),
    classifier: {
      timeout_ms: null,
      on_low_confidence: 'escalate',
      min_confidence: null,
    },
    exposure: {},
  };
}

const providerOptions = computed(() =>
  providerStore.providers
    .filter((p) => p.enabled)
    .map((p) => ({ label: p.name, value: p.id })),
);

const virtualModelOptions = computed(() =>
  modelStore.models
    .filter((m) => m.isVirtual && m.expertRoutingId !== routingId.value)
    .map((m) => ({ label: m.name, value: m.id })),
);

const fallbackType = computed<'virtual' | 'real'>({
  get: () => form.value.fallback?.type ?? 'virtual',
  set: (value) => patchFallback({ type: value }),
});
const fallbackModelId = computed<string>({
  get: () => form.value.fallback?.model_id ?? '',
  set: (value) => patchFallback({ model_id: value }),
});
const fallbackProviderId = computed<string>({
  get: () => form.value.fallback?.provider_id ?? '',
  set: (value) => patchFallback({ provider_id: value }),
});
const fallbackModelName = computed<string>({
  get: () => form.value.fallback?.model ?? '',
  set: (value) => patchFallback({ model: value }),
});

function patchFallback(patch: Partial<FallbackConfig>) {
  const base: FallbackConfig =
    form.value.fallback ?? { type: 'virtual', model_id: '' };
  form.value.fallback = { ...base, ...patch };
}

function applyRouting(record: ExpertRouting) {
  routing.value = record;
  const config = record.config;
  form.value = {
    name: record.name,
    description: record.description ?? '',
    virtualModelName: record.virtualModel?.name ?? '',
    failOpen: config.fail_open ?? 'fallback',
    preprocessing: {
      strip_tools: config.preprocessing?.strip_tools ?? false,
      strip_files: config.preprocessing?.strip_files ?? false,
      strip_code_blocks: config.preprocessing?.strip_code_blocks ?? false,
      strip_system_prompt: config.preprocessing?.strip_system_prompt ?? false,
    },
    experts: config.experts ?? [],
    fallback: config.fallback ? { ...config.fallback } : null,
    sessionPolicy: config.session_policy ?? createDefaultSessionPolicy(),
    classifier: {
      timeout_ms: config.classifier?.timeout_ms ?? null,
      on_low_confidence: config.classifier?.on_low_confidence ?? 'escalate',
      min_confidence: config.classifier?.min_confidence ?? null,
    },
    exposure: config.exposure ? { ...config.exposure } : {},
  };
  savedSnapshot.value = JSON.stringify(buildPayload());
}

function buildPayload(): UpdateExpertRoutingRequest {
  const classifier: ClassifierConfig = {
    timeout_ms: form.value.classifier.timeout_ms ?? undefined,
    on_low_confidence: form.value.classifier.on_low_confidence,
    min_confidence: form.value.classifier.min_confidence ?? undefined,
  };
  return {
    name: form.value.name,
    description: form.value.description,
    virtualModelName: form.value.virtualModelName.trim() || undefined,
    fail_open: form.value.failOpen,
    preprocessing: { ...form.value.preprocessing },
    experts: form.value.experts,
    fallback:
      form.value.failOpen === 'fallback' ? form.value.fallback ?? null : null,
    session_policy: { ...form.value.sessionPolicy },
    classifier,
    exposure: { ...form.value.exposure },
  };
}

const isDirty = computed(
  () =>
    !loading.value &&
    routing.value !== null &&
    JSON.stringify(buildPayload()) !== savedSnapshot.value,
);

function resolveModelLabel(expert: ExpertTarget): string {
  if (expert.type === 'virtual') {
    if (expert.model_id) {
      const model = modelStore.models.find(
        (m) => m.isVirtual && m.id === expert.model_id,
      );
      if (model) return model.name;
    }
  } else {
    const model = modelStore.models.find(
      (m) =>
        !m.isVirtual &&
        m.providerId === expert.provider_id &&
        m.modelIdentifier === expert.model,
    );
    if (model) return model.name;
  }
  return expert.model || expert.model_id || expert.id;
}

function resolveExpertLabel(expertId: string): string {
  const expert = form.value.experts.find((e) => e.id === expertId);
  return expert ? resolveModelLabel(expert) : expertId;
}

async function loadRouting() {
  loading.value = true;
  try {
    applyRouting(await expertRoutingApi.getById(routingId.value));
  } catch (error: any) {
    message.error(error.message || t('messages.operationFailed'));
  } finally {
    loading.value = false;
  }
}

async function loadJevStatus() {
  jevLoading.value = true;
  try {
    jevStatus.value = await expertRoutingApi.getJevStatus();
  } catch {
    jevStatus.value = null;
  } finally {
    jevLoading.value = false;
  }
}

async function handleSave() {
  if (!form.value.name.trim()) {
    message.warning(t('validation.required'));
    return;
  }
  saving.value = true;
  try {
    const updated = await expertRoutingApi.update(
      routingId.value,
      buildPayload(),
    );
    applyRouting(updated);
    message.success(t('expertRouting.updateSuccess'));
  } catch (error: any) {
    message.error(error.message || t('messages.operationFailed'));
  } finally {
    saving.value = false;
  }
}

function goBack() {
  router.push('/expert-routing');
}

onMounted(async () => {
  await Promise.all([
    providerStore.fetchProviders(),
    modelStore.fetchModels(),
  ]);
  await Promise.all([loadRouting(), loadJevStatus()]);
});
</script>

<style scoped>
.expert-routing-detail {
  max-width: 1360px;
  margin: 0 auto;
}

.config-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
  align-items: stretch;
  padding-top: 4px;
}

.config-card--wide {
  grid-column: 1 / -1;
}

.config-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 16px 0;
  border-top: 1px solid var(--routing-border);
}

.config-card {
  min-width: 0;
}

.config-section {
  padding: 12px 0 0;
}

.config-section h3 {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 600;
}

:deep(.n-form-item-feedback-wrapper) {
  min-height: 24px;
  padding-top: 6px;
  line-height: 1.6;
}

:deep(.n-radio-group) {
  max-width: 100%;
}

:deep(.config-card .n-form-item) {
  margin-bottom: 12px;
}

:deep(.config-card .n-form-item:last-child) {
  margin-bottom: 0;
}

:deep(.fallback-selector > .n-form-item-blank > div) {
  width: 100%;
}

:deep(.switch-form .n-form-item-feedback-wrapper) {
  grid-column: 1 / -1;
}

:deep(.switch-form .n-form-item) {
  padding: 12px 0;
  border-bottom: 1px solid var(--routing-border);
}

:deep(.switch-form .n-form-item:last-child) {
  border-bottom: 0;
}

:deep(.switch-form .n-form-item-blank:has(.n-switch)) {
  justify-content: flex-end;
}

:deep(.page-heading__title) {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

@media (max-width: 600px) {
  :deep(.switch-form .n-form-item-label) {
    width: auto !important;
    max-width: calc(100% - 60px);
  }

  .config-grid {
    gap: 12px;
  }
}

@media (max-width: 900px) {
  .config-grid {
    grid-template-columns: 1fr;
  }
}

.classifier-status {
  font-size: 13px;
}
</style>

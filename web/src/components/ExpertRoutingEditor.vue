<template>
  <div>
    <div class="steps-container">
      <n-steps :current="currentStep" :status="currentStatus">
        <n-step :title="t('expertRouting.basicInfo')" />
        <n-step :title="t('expertRouting.classifierConfig')" />
        <n-step :title="t('expertRouting.expertsConfig')" />
        <n-step :title="t('expertRouting.fallbackStrategy')" />
      </n-steps>
    </div>

    <div class="step-content">
      <div v-show="currentStep === 1">
        <n-form :model="formValue" label-placement="left" :label-width="120">
          <n-form-item :label="t('expertRouting.configName')" required>
            <n-input v-model:value="formValue.name" :placeholder="t('expertRouting.configNamePlaceholder')" />
          </n-form-item>
          <n-form-item :label="t('expertRouting.configDescription')">
            <n-input
              v-model:value="formValue.description"
              type="textarea"
              :rows="3"
              :placeholder="t('expertRouting.configDescriptionPlaceholder')"
            />
          </n-form-item>
          <n-form-item :label="t('common.enabled')">
            <n-switch v-model:value="formValue.enabled" />
          </n-form-item>
        </n-form>
      </div>

      <div v-show="currentStep === 2">
        <n-form :model="formValue.classifier" label-placement="left" :label-width="120">
          <ModelSelector
            v-model:type="formValue.classifier.type"
            v-model:model-id="formValue.classifier.model_id"
            v-model:provider-id="formValue.classifier.provider_id"
            v-model:model="formValue.classifier.model"
            :provider-options="providerOptions"
            :virtual-model-options="virtualModelOptions"
          />

            <n-form-item :label="t('expertRouting.systemPrompt')" required>
              <n-input
                v-model:value="systemPrompt"
                type="textarea"
                :rows="8"
                :placeholder="t('expertRouting.systemPromptPlaceholder')"
              />
              <template #feedback>
                <n-text depth="3" style="font-size: 12px">
                  {{ t('expertRouting.systemPromptHint') }}
                </n-text>
              </template>
            </n-form-item>

            <n-form-item :label="t('expertRouting.userPromptMarker')" required>
              <n-input
                v-model:value="userPromptMarker"
                :placeholder="t('expertRouting.userPromptMarkerPlaceholder')"
              />
              <template #feedback>
                <n-text depth="3" style="font-size: 12px">
                  {{ t('expertRouting.userPromptMarkerHint') }}
                </n-text>
              </template>
            </n-form-item>


          <n-grid :cols="2" :x-gap="12">
            <n-gi>
              <n-form-item :label="t('expertRouting.maxTokens')">
                <n-input-number
                  v-model:value="formValue.classifier.max_tokens"
                  :min="1"
                  :max="1000"
                  style="width: 100%"
                />
                <template #feedback>
                  <n-text depth="3" style="font-size: 12px">
                    {{ t('expertRouting.maxTokensHint') }}
                  </n-text>
                </template>
              </n-form-item>
            </n-gi>
            <n-gi>
              <n-form-item :label="t('expertRouting.temperature')">
                <n-input-number
                  v-model:value="formValue.classifier.temperature"
                  :min="0"
                  :max="2"
                  :step="0.1"
                  style="width: 100%"
                />
                <template #feedback>
                  <n-text depth="3" style="font-size: 12px">
                    {{ t('expertRouting.temperatureHint') }}
                  </n-text>
                </template>
              </n-form-item>
            </n-gi>
          </n-grid>

          <n-form-item :label="t('expertRouting.timeout')">
            <n-input-number
              v-model:value="formValue.classifier.timeout"
              :min="1000"
              :max="60000"
              :step="1000"
              style="width: 100%"
            />
            <template #feedback>
              <n-text depth="3" style="font-size: 12px">
                {{ t('expertRouting.timeoutHint') }}
              </n-text>
            </template>
          </n-form-item>

          <n-form-item :label="t('expertRouting.ignoreSystemMessages')">
            <n-switch v-model:value="formValue.classifier.ignore_system_messages" />
            <template #feedback>
              <n-text depth="3" style="font-size: 12px">
                {{ t('expertRouting.ignoreSystemMessagesHint') }}
              </n-text>
            </template>
          </n-form-item>

          <n-form-item :label="t('expertRouting.maxMessagesToClassify')">
            <n-input-number
              v-model:value="formValue.classifier.max_messages_to_classify"
              :min="0"
              :max="100"
              :step="1"
              style="width: 100%"
              placeholder="0"
            />
            <template #feedback>
              <n-text depth="3" style="font-size: 12px">
                {{ t('expertRouting.maxMessagesToClassifyHint') }}
              </n-text>
            </template>
          </n-form-item>

          <n-form-item :label="t('expertRouting.ignoredTags')">
            <n-input
              v-model:value="ignoredTagsInput"
              :placeholder="t('expertRouting.ignoredTagsPlaceholder')"
            />
          </n-form-item>

          <n-form-item :label="t('expertRouting.enableStructuredOutput')">
            <n-switch v-model:value="formValue.classifier.enable_structured_output" />
            <template #feedback>
              <n-text depth="3" style="font-size: 12px">
                {{ t('expertRouting.enableStructuredOutputHint') }}
              </n-text>
            </template>
          </n-form-item>
        </n-form>
      </div>

      <div v-show="currentStep === 3">
        <ExpertRoutingVisualization
          v-model:experts="formValue.experts"
          :classifier-config="formValue.classifier"
          :provider-options="providerOptions"
          :virtual-model-options="virtualModelOptions"
          editable
        />
      </div>

      <div v-show="currentStep === 4">
        <n-form :model="formValue" label-placement="left" :label-width="120">
          <n-form-item :label="t('expertRouting.enableFallback')">
            <n-switch v-model:value="enableFallback" />
          </n-form-item>

          <template v-if="enableFallback">
            <ModelSelector
              v-model:type="fallbackType"
              v-model:model-id="fallbackModelId"
              v-model:provider-id="fallbackProviderId"
              v-model:model="fallbackModel"
              :provider-options="providerOptions"
              :virtual-model-options="virtualModelOptions"
            />
          </template>
        </n-form>
      </div>


    </div>

    <n-space justify="space-between" style="margin-top: 24px">
      <n-button @click="handlePrevious" :disabled="currentStep === 1">
        {{ t('common.previous') }}
      </n-button>
      <n-space>
        <n-button @click="$emit('cancel')">{{ t('common.cancel') }}</n-button>
        <n-button
          v-if="currentStep < 4"
          type="primary"
          @click="handleNext"
        >
          {{ t('common.next') }}
        </n-button>
        <n-button
          v-else
          type="primary"
          @click="handleSave"
          :loading="saving"
        >
          {{ t('common.save') }}
        </n-button>
      </n-space>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NSteps,
  NStep,
  NSpace,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSwitch,
  NButton,
  NText,
  NGrid,
  NGi,
} from 'naive-ui';
import { useProviderStore } from '@/stores/provider';
import { useModelStore } from '@/stores/model';
import type { CreateExpertRoutingRequest } from '@/api/expert-routing';
import ExpertRoutingVisualization from './ExpertRoutingVisualization.vue';
import ModelSelector from './ModelSelector.vue';

const { t } = useI18n();

interface Props {
  config: CreateExpertRoutingRequest;
  editingId?: string | null;
  saving?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  save: [data: CreateExpertRoutingRequest];
  cancel: [];
}>();

const providerStore = useProviderStore();
const modelStore = useModelStore();

const currentStep = ref(1);
const currentStatus = ref<'process' | 'finish' | 'error' | 'wait'>('process');
const formValue = ref<CreateExpertRoutingRequest>({ ...props.config });
const enableFallback = ref(!!props.config.fallback);
const fallbackType = ref<'virtual' | 'real'>(props.config.fallback?.type || 'real');
const fallbackModelId = ref(props.config.fallback?.model_id || '');
const fallbackProviderId = ref(props.config.fallback?.provider_id || '');
const fallbackModel = ref(props.config.fallback?.model || '');
const ignoredTagsInput = ref<string>(
  props.config.classifier.ignored_tags?.join(', ') || ''
);

const systemPrompt = ref('');
const userPromptMarker = ref('---\nUser Prompt:\n{{USER_PROMPT}}\n---');

// 设置分类器性能参数默认值
if (formValue.value.classifier.temperature === undefined) {
  formValue.value.classifier.temperature = 0;
}
if (formValue.value.classifier.max_tokens === undefined) {
  formValue.value.classifier.max_tokens = 50;
}
if (formValue.value.classifier.timeout === undefined) {
  formValue.value.classifier.timeout = 10000;
}

function parsePromptTemplate(template: string) {
  const markers = [
    '---\nUser Prompt:\n{{USER_PROMPT}}\n---',
    '---\nUser Prompt:\n{{user_prompt}}\n---',
    '{{USER_PROMPT}}',
    '{{user_prompt}}'
  ];

  for (const marker of markers) {
    if (template.includes(marker)) {
      const parts = template.split(marker);
      if (parts.length === 2) {
        systemPrompt.value = parts[0].trim();
        userPromptMarker.value = marker;
        return;
      }
    }
  }

  // 若无标记，视为全部为系统提示词
  systemPrompt.value = template.trim();
}

if (props.config.classifier.prompt_template) {
  parsePromptTemplate(props.config.classifier.prompt_template);
}

const providerOptions = computed(() =>
  providerStore.providers.map((p) => ({
    label: p.name,
    value: p.id,
  }))
);

const virtualModelOptions = computed(() =>
  modelStore.models
    .filter((m) => m.isVirtual === true)
    .map((m) => ({
      label: m.name,
      value: m.id,
    }))
);

function handlePrevious() {
  if (currentStep.value > 1) {
    currentStep.value--;
  }
}

function handleNext() {
  if (currentStep.value < 4) {
    currentStep.value++;
  }
}

function handleSave() {
  formValue.value.classifier.prompt_template = `${systemPrompt.value}\n${userPromptMarker.value}`;
  formValue.value.classifier.system_prompt = systemPrompt.value;
  formValue.value.classifier.user_prompt_marker = userPromptMarker.value;

  if (enableFallback.value) {
    formValue.value.fallback = {
      type: fallbackType.value,
      model_id: fallbackType.value === 'virtual' ? fallbackModelId.value : undefined,
      provider_id: fallbackType.value === 'real' ? fallbackProviderId.value : undefined,
      model: fallbackType.value === 'real' ? fallbackModel.value : undefined,
    };
  } else {
    formValue.value.fallback = undefined;
  }

  const tags = ignoredTagsInput.value
    .split(/[,，\n]/)
    .map(tag => tag.trim())
    .filter(tag => tag.length > 0);
  formValue.value.classifier.ignored_tags = tags.length > 0 ? tags : undefined;

  emit('save', formValue.value);
}

onMounted(async () => {
  await providerStore.fetchProviders();
  await modelStore.fetchModels();
});
</script>

<style scoped>
.steps-container {
  display: flex;
  justify-content: center;
  padding: 0 20px;
}

.step-content {
  margin-top: 24px;
  min-height: 400px;
}
</style>


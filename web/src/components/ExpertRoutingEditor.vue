<template>
  <div>
    <div class="steps-container">
      <n-steps :current="currentStep" :status="currentStatus">
        <n-step :title="t('expertRouting.basicInfo')" />
        <n-step :title="t('expertRouting.classifierConfig')" />
        <n-step :title="t('expertRouting.expertsConfig')" />
        <n-step :title="t('expertRouting.fallbackStrategy')" />
        <n-step :title="t('expertRouting.createSmartRouting')" />
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
          <n-form-item :label="t('expertRouting.modelType')" required>
            <n-radio-group v-model:value="formValue.classifier.type" class="model-type-radio">
              <n-space :size="16">
                <n-radio value="virtual">{{ t('expertRouting.virtualModel') }}</n-radio>
                <n-radio value="real">{{ t('expertRouting.realModel') }}</n-radio>
              </n-space>
            </n-radio-group>
          </n-form-item>

          <n-form-item
            v-if="formValue.classifier.type === 'virtual'"
            :label="t('expertRouting.virtualModel')"
            required
          >
            <n-select
              v-model:value="formValue.classifier.model_id"
              :options="virtualModelOptions"
              :placeholder="t('expertRouting.selectVirtualModel')"
            />
          </n-form-item>

          <template v-else>
            <n-form-item :label="t('expertRouting.selectProvider')" required>
              <n-select
                v-model:value="formValue.classifier.provider_id"
                :options="providerOptions"
                :placeholder="t('expertRouting.selectProvider')"
                @update:value="handleClassifierProviderChange"
              />
            </n-form-item>
            <n-form-item :label="t('expertRouting.modelName')" required>
              <n-select
                v-model:value="formValue.classifier.model"
                :options="classifierProviderModelOptions"
                :placeholder="t('expertRouting.selectModel')"
                :disabled="!formValue.classifier.provider_id"
                filterable
              />
            </n-form-item>
          </template>

          <n-form-item :label="t('expertRouting.classificationPrompt')" required>
            <n-input
              v-model:value="formValue.classifier.prompt_template"
              type="textarea"
              :rows="6"
              :placeholder="t('expertRouting.classificationPromptPlaceholder')"
            />
            <template #feedback>
              <n-text depth="3" style="font-size: 12px">
                {{ t('expertRouting.classificationPromptHint') }}
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
            <n-form-item :label="t('expertRouting.modelType')" required>
              <n-radio-group v-model:value="fallbackType" class="model-type-radio">
                <n-space :size="16">
                  <n-radio value="virtual">{{ t('expertRouting.virtualModel') }}</n-radio>
                  <n-radio value="real">{{ t('expertRouting.realModel') }}</n-radio>
                </n-space>
              </n-radio-group>
            </n-form-item>

            <n-form-item
              v-if="fallbackType === 'virtual'"
              :label="t('expertRouting.virtualModel')"
              required
            >
              <n-select
                v-model:value="fallbackModelId"
                :options="virtualModelOptions"
                :placeholder="t('expertRouting.selectVirtualModel')"
              />
            </n-form-item>

            <template v-else>
              <n-form-item :label="t('expertRouting.selectProvider')" required>
                <n-select
                  v-model:value="fallbackProviderId"
                  :options="providerOptions"
                  :placeholder="t('expertRouting.selectProvider')"
                  @update:value="handleFallbackProviderChange"
                />
              </n-form-item>
              <n-form-item :label="t('expertRouting.modelName')" required>
                <n-select
                  v-model:value="fallbackModel"
                  :options="fallbackProviderModelOptions"
                  :placeholder="t('expertRouting.selectModel')"
                  :disabled="!fallbackProviderId"
                  filterable
                />
              </n-form-item>
            </template>
          </template>
        </n-form>
      </div>

      <div v-show="currentStep === 5">
        <n-form label-placement="left" :label-width="140">
          <n-form-item>
            <template #label>
              <n-space align="center" :size="8">
                <span>{{ t('expertRouting.createExpertModel') }}</span>
                <n-switch v-model:value="createVirtualModel" size="small" />
              </n-space>
            </template>
            <n-text depth="3" style="font-size: 12px">
              {{ t('expertRouting.createExpertModelHint') }}
            </n-text>
          </n-form-item>

          <template v-if="createVirtualModel">
            <n-form-item :label="t('expertRouting.expertModelName')" required>
              <n-input
                v-model:value="virtualModelName"
                :placeholder="t('expertRouting.expertModelNamePlaceholder')"
              />
            </n-form-item>

            <n-form-item :label="t('expertRouting.modelAttributes')">
              <n-text depth="3" style="font-size: 12px">
                {{ t('expertRouting.modelAttributesHint') }}
              </n-text>
            </n-form-item>
          </template>

          <n-divider v-if="createVirtualModel" style="margin: 20px 0;" />

          <n-form-item :label="t('expertRouting.smartRoutingName')">
            <n-input
              v-model:value="smartRoutingName"
              :placeholder="t('expertRouting.smartRoutingNamePlaceholder')"
            />
          </n-form-item>
          <n-form-item :label="t('expertRouting.smartRoutingDescription')">
            <n-input
              v-model:value="smartRoutingDescription"
              type="textarea"
              :rows="3"
              :placeholder="t('expertRouting.smartRoutingDescriptionPlaceholder')"
            />
          </n-form-item>
          <n-form-item>
            <n-text depth="3" style="font-size: 13px; line-height: 1.6">
              {{ t('expertRouting.createSmartRoutingHint') }}
            </n-text>
          </n-form-item>
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
          v-if="currentStep < 5"
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
  NRadioGroup,
  NRadio,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSelect,
  NSwitch,
  NButton,
  NText,
  NGrid,
  NGi,
  NDivider,
} from 'naive-ui';
import { useProviderStore } from '@/stores/provider';
import { useModelStore } from '@/stores/model';
import type { CreateExpertRoutingRequest } from '@/api/expert-routing';
import ExpertRoutingVisualization from './ExpertRoutingVisualization.vue';

const { t } = useI18n();

interface Props {
  config: CreateExpertRoutingRequest;
  editingId?: string | null;
  saving?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  save: [data: CreateExpertRoutingRequest, smartRouting?: { name: string; description?: string }];
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
const createVirtualModel = ref(false);
const virtualModelName = ref('');
const smartRoutingName = ref('');
const smartRoutingDescription = ref('');

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

const classifierProviderModelOptions = computed(() => {
  if (!formValue.value.classifier.provider_id) {
    return [];
  }
  return modelStore.models
    .filter((m) => m.providerId === formValue.value.classifier.provider_id && m.isVirtual !== true)
    .map((m) => ({
      label: m.name,
      value: m.modelIdentifier,
    }));
});

const fallbackProviderModelOptions = computed(() => {
  if (!fallbackProviderId.value) {
    return [];
  }
  return modelStore.models
    .filter((m) => m.providerId === fallbackProviderId.value && m.isVirtual !== true)
    .map((m) => ({
      label: m.name,
      value: m.modelIdentifier,
    }));
});

function handleClassifierProviderChange() {
  formValue.value.classifier.model = '';
}

function handleFallbackProviderChange() {
  fallbackModel.value = '';
}

function handlePrevious() {
  if (currentStep.value > 1) {
    currentStep.value--;
  }
}

function handleNext() {
  if (currentStep.value < 5) {
    currentStep.value++;
  }
}

function handleSave() {
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

  if (createVirtualModel.value && virtualModelName.value.trim()) {
    formValue.value.createVirtualModel = true;
    formValue.value.virtualModelName = virtualModelName.value.trim();
  }

  const smartRouting = smartRoutingName.value.trim()
    ? {
        name: smartRoutingName.value.trim(),
        description: smartRoutingDescription.value.trim() || undefined,
      }
    : undefined;

  emit('save', formValue.value, smartRouting);
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

:deep(.model-type-radio .n-radio) {
  padding: 8px 16px;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  transition: all 0.3s ease;
}

:deep(.model-type-radio .n-radio:hover) {
  border-color: #18a058;
  background-color: rgba(24, 160, 88, 0.05);
}

:deep(.model-type-radio .n-radio.n-radio--checked) {
  border-color: #18a058;
  background-color: rgba(24, 160, 88, 0.1);
}

:deep(.model-type-radio .n-radio__dot) {
  width: 18px;
  height: 18px;
}

:deep(.model-type-radio .n-radio__dot-wrapper) {
  width: 18px;
  height: 18px;
}
</style>


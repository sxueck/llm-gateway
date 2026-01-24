<template>
  <div class="expert-routing-editor">
    <div class="steps-container">
      <n-steps :current="currentStep" :status="currentStatus">
        <n-step :title="t('expertRouting.stepDefineExperts')" :description="t('expertRouting.stepDefineExpertsDesc')" />
        <n-step :title="t('expertRouting.stepConfigurePipeline')" :description="t('expertRouting.stepConfigurePipelineDesc')" />
        <n-step :title="t('expertRouting.stepReview')" :description="t('expertRouting.stepReviewDesc')" />
      </n-steps>
    </div>

    <div class="step-content">
      <!-- STEP 1: Define Experts (The "Who") -->
      <div v-show="currentStep === 1">
        <div class="step-header-text">
          <h3>{{ t('expertRouting.basicInfo') }}</h3>
        </div>
        <n-form :model="formValue" label-placement="left" :label-width="120">
          <n-form-item :label="t('expertRouting.configName')" required>
            <n-input v-model:value="formValue.name" :placeholder="t('expertRouting.configNamePlaceholder')" />
          </n-form-item>
          <n-form-item :label="t('expertRouting.configDescription')">
            <n-input
              v-model:value="formValue.description"
              type="textarea"
              :rows="2"
              :placeholder="t('expertRouting.configDescriptionPlaceholder')"
            />
          </n-form-item>
          <n-form-item :label="t('common.enabled')">
            <n-switch v-model:value="formValue.enabled" />
          </n-form-item>
        </n-form>

        <n-divider />

        <div class="step-header-text">
          <h3>{{ t('expertRouting.expertsConfig') }}</h3>
          <p class="step-sub-text">{{ t('expertRouting.expertsConfigHint') }}</p>
        </div>
        
        <!-- Use existing visualization component but in editable mode with utterances enabled -->
        <ExpertRoutingVisualization
          v-model:experts="formValue.experts"
          :routes="formValue.routing?.semantic?.routes"
          :show-utterances="true"
          :classifier-config="formValue.classifier"
          :provider-options="providerOptions"
          :virtual-model-options="virtualModelOptions"
          editable
          @update:routes="(routes) => { if(formValue.routing?.semantic) formValue.routing.semantic.routes = routes }"
        />
      </div>

      <!-- STEP 2: Configure Pipeline (The "How") -->
      <div v-show="currentStep === 2">
        <div class="step-header-text" style="text-align: center; margin-bottom: 20px;">
          <h3>{{ t('expertRouting.pipelineConfig') }}</h3>
          <p class="step-sub-text">{{ t('expertRouting.pipelineConfigHint') }}</p>
        </div>

        <RoutingPipelineConfig
          v-model:config="routingConfig"
          v-model:classifier="formValue.classifier"
          v-model:preprocessing="preprocessingConfig"
          :experts="formValue.experts"
          :provider-options="providerOptions"
          :virtual-model-options="virtualModelOptions"
        />
      </div>

      <!-- STEP 3: Fallback & Review -->
      <div v-show="currentStep === 3">
        <n-form :model="formValue" label-placement="left" :label-width="120">
          <div class="step-header-text">
            <h3>{{ t('expertRouting.fallbackStrategy') }}</h3>
            <p class="step-sub-text">{{ t('expertRouting.fallbackDesc') }}</p>
          </div>
          
          <n-card :bordered="true" style="margin-bottom: 20px;">
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
          </n-card>

          <div class="step-header-text">
            <h3>{{ t('expertRouting.reviewConfig') }}</h3>
          </div>
          
          <n-descriptions bordered :column="1">
            <n-descriptions-item :label="t('expertRouting.configName')">
              {{ formValue.name }}
            </n-descriptions-item>
            <n-descriptions-item :label="t('expertRouting.expertCount')">
              {{ formValue.experts.length }}
            </n-descriptions-item>
             <n-descriptions-item :label="t('expertRouting.semanticExamplesCount')">
              {{ formValue.routing?.semantic?.routes?.reduce((acc, r) => acc + r.utterances.length, 0) || 0 }}
            </n-descriptions-item>
            <n-descriptions-item :label="t('expertRouting.classifierModel')">
              {{ getModelLabel(formValue.classifier) }}
            </n-descriptions-item>
          </n-descriptions>
        </n-form>
      </div>
    </div>

    <n-space class="footer-actions" justify="space-between">
      <n-button @click="handlePrevious" :disabled="currentStep === 1">
        {{ t('common.previous') }}
      </n-button>
      <n-space>
        <n-button @click="$emit('cancel')">{{ t('common.cancel') }}</n-button>
        <n-button
          v-if="currentStep < 3"
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
import { ref, computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NSteps,
  NStep,
  NSpace,
  NForm,
  NFormItem,
  NInput,
  NSwitch,
  NButton,
  NDivider,
  NCard,
  NDescriptions,
  NDescriptionsItem,
} from 'naive-ui';
import { useProviderStore } from '@/stores/provider';
import { useModelStore } from '@/stores/model';
import type { CreateExpertRoutingRequest, ClassifierConfig, ExpertRoutingConfig } from '@/api/expert-routing';
import ExpertRoutingVisualization from './ExpertRoutingVisualization.vue';
import RoutingPipelineConfig from './RoutingPipelineConfig.vue';
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

function normalizeRoutingConfig(target: CreateExpertRoutingRequest) {
  // Keep routing config always present and in pipeline mode.
  if (!target.routing) {
    target.routing = {
      mode: 'pipeline',
      semantic: {
        model: 'bge-small-zh-v1.5',
        threshold: 0.6,
        margin: 0.1,
        routes: [],
      },
      heuristics: { rules: [] },
    };
  }

  target.routing.mode = 'pipeline';

  if (!target.routing.semantic) {
    target.routing.semantic = {
      model: 'bge-small-zh-v1.5',
      threshold: 0.6,
      margin: 0.1,
      routes: [],
    };
  }

  if (!target.routing.heuristics) {
    target.routing.heuristics = { rules: [] };
  }

  if (!target.preprocessing) {
    target.preprocessing = {
      strip_tools: false,
      strip_files: false,
      strip_code_blocks: false,
      strip_system_prompt: false,
    };
  }
}

normalizeRoutingConfig(formValue.value);

type StrictRoutingConfig = NonNullable<ExpertRoutingConfig['routing']> & {
  semantic: NonNullable<NonNullable<ExpertRoutingConfig['routing']>['semantic']>;
};

type StrictPreprocessingConfig = NonNullable<ExpertRoutingConfig['preprocessing']>;

// Strongly-typed v-model target for child components.
const routingConfig = computed<StrictRoutingConfig>({
  get: () => formValue.value.routing as StrictRoutingConfig,
  set: (v) => {
    formValue.value.routing = v;
  },
});

const preprocessingConfig = computed<StrictPreprocessingConfig>({
  get: () => formValue.value.preprocessing as StrictPreprocessingConfig,
  set: (v) => {
    formValue.value.preprocessing = v;
  },
});


const enableFallback = ref(!!props.config.fallback);
const fallbackType = ref<'virtual' | 'real'>(props.config.fallback?.type || 'real');
const fallbackModelId = ref(props.config.fallback?.model_id || '');
const fallbackProviderId = ref(props.config.fallback?.provider_id || '');
const fallbackModel = ref(props.config.fallback?.model || '');

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

function getModelLabel(config: ClassifierConfig) {
  if (config.type === 'virtual') {
     const m = virtualModelOptions.value.find(v => v.value === config.model_id);
     return m ? `Virtual: ${m.label}` : config.model_id;
  }
  return config.model || 'Unknown';
}

function handlePrevious() {
  if (currentStep.value > 1) {
    currentStep.value--;
  }
}

function handleNext() {
  if (currentStep.value < 3) {
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

  emit('save', formValue.value);
}

// Avoid refetching large provider/model lists on every modal open.
onMounted(async () => {
  const tasks: Promise<unknown>[] = [];
  if (!providerStore.providers.length && !providerStore.loading) tasks.push(providerStore.fetchProviders());
  if (!modelStore.models.length && !modelStore.loading) tasks.push(modelStore.fetchModels());
  if (tasks.length) await Promise.all(tasks);
});

// When the modal is kept alive or reopened quickly, refresh form state.
watch(
  () => props.config,
  (cfg) => {
    // Shallow clone is enough; normalize will create missing nested objects.
    formValue.value = { ...cfg };
    normalizeRoutingConfig(formValue.value);
    currentStep.value = 1;
    currentStatus.value = 'process';
  }
);
</script>

<style scoped>
.expert-routing-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  max-height: 100%;
  box-sizing: border-box;
}

.steps-container {
  display: flex;
  justify-content: center;
  padding: 0 20px;
  flex-shrink: 0;
}

.step-content {
  margin-top: 24px;
  flex: 1;
  min-height: 0;
  overflow-y: auto; /* Allow scrolling within the step content */
  padding: 0 4px 12px 4px; /* Slight padding for scrollbar */
}

.step-header-text {
  margin-bottom: 16px;
}

.step-header-text h3 {
  margin: 0 0 8px 0;
  font-size: 18px;
  font-weight: 600;
}

.step-sub-text {
  margin: 0;
  color: var(--n-text-color-3);
  font-size: 14px;
}

.footer-actions {
  position: sticky;
  bottom: 0;
  z-index: 10;
  padding-top: 12px;
  border-top: 1px solid var(--divider-color, rgba(0,0,0,0.06));
  background-color: var(--modal-color, rgba(255,255,255,0.9));
  /* backdrop-filter is visually nice but can cause noticeable FPS drops in modals */
  /* backdrop-filter: saturate(140%) blur(3px); */
  margin-top: auto; /* Push to bottom */
}
</style>

<style scoped>
.expert-routing-editor {
  display: flex;
  flex-direction: column;
  max-height: 100%;  /* 跟随外层容器高度 */
  overflow: visible; /* 让 sticky 参考外层滚动容器 (.modal-content-wrapper) */
  box-sizing: border-box;
}

.steps-container {
  display: flex;
  justify-content: center;
  padding: 0 20px;
}

.step-content {
  margin-top: 24px;
  flex: 1;             /* 让内容区占满中间空间 */
  min-height: 0;       /* 配合 flex:1 才能正确收缩 */
  overflow: visible;   /* 将滚动交给 .modal-content-wrapper */
  padding-bottom: 12px;/* 避免最后一行被底部操作区遮挡 */
}

.footer-actions {
  position: sticky;
  bottom: 0;
  z-index: 1;
  padding-top: 12px;
  border-top: 1px solid var(--divider-color, rgba(0,0,0,0.06));
  background-color: var(--modal-color, rgba(255,255,255,0.9));
  /* backdrop-filter: saturate(140%) blur(3px); */
}
</style>

<template>
  <div class="virtual-model-wizard">
    <n-steps :current="currentStep" :status="stepStatus" size="small">
      <n-step title="选择类型" />
      <n-step title="基本信息" />
      <n-step title="目标配置" />
      <n-step title="模型属性" />
    </n-steps>

    <div class="step-content">
      <div v-if="currentStep === 1" class="step-panel">
        <n-radio-group v-model:value="localConfigType">
          <n-space vertical :size="12">
            <n-radio value="loadbalance">
              <div class="config-type-option">
                <div class="option-title">负载均衡</div>
                <div class="option-description">将请求按权重分配到多个目标</div>
              </div>
            </n-radio>
            <n-radio value="fallback">
              <div class="config-type-option">
                <div class="option-title">故障转移</div>
                <div class="option-description">主要目标失败时自动切换到备用目标</div>
              </div>
            </n-radio>
          </n-space>
        </n-radio-group>
      </div>

      <div v-if="currentStep === 2" class="step-panel">
        <n-form ref="basicFormRef" :model="localFormValue" label-placement="top" :show-feedback="false">
          <n-form-item label="虚拟模型名称" path="virtualModelName" :rule="{ required: true, message: '请输入虚拟模型名称' }">
            <n-input
              v-model:value="localFormValue.virtualModelName"
              :placeholder="localConfigType === 'loadbalance' ? 'GPT-4-LB' : 'GPT-4-Fallback'"
            />
          </n-form-item>
          <n-form-item label="描述">
            <n-input
              v-model:value="localFormValue.description"
              type="textarea"
              placeholder="可选"
              :rows="2"
            />
          </n-form-item>
        </n-form>
      </div>

      <div v-if="currentStep === 3" class="step-panel">
        <n-alert v-if="localConfigType === 'fallback'" type="info" style="margin-bottom: 16px;">
          按优先级从高到低排列，失败时自动切换到下一个
        </n-alert>

        <n-space vertical :size="12">
          <n-card v-for="(target, index) in localFormValue.targets" :key="index" size="small" class="target-card">
            <template #header>
              <n-space justify="space-between" align="center">
                <span class="target-title">
                  {{ localConfigType === 'loadbalance' ? `目标 ${index + 1}` : `优先级 ${index + 1}` }}
                </span>
                <n-space :size="4">
                  <n-button
                    v-if="localConfigType === 'fallback'"
                    text
                    size="small"
                    @click="moveTargetUp(index)"
                    :disabled="index === 0"
                  >
                    <template #icon>
                      <n-icon><ArrowUpOutline /></n-icon>
                    </template>
                  </n-button>
                  <n-button
                    v-if="localConfigType === 'fallback'"
                    text
                    size="small"
                    @click="moveTargetDown(index)"
                    :disabled="index === localFormValue.targets.length - 1"
                  >
                    <template #icon>
                      <n-icon><ArrowDownOutline /></n-icon>
                    </template>
                  </n-button>
                  <n-button text type="error" size="small" @click="removeTarget(index)">
                    <template #icon>
                      <n-icon><CloseOutline /></n-icon>
                    </template>
                  </n-button>
                </n-space>
              </n-space>
            </template>

            <n-space vertical :size="12">
              <div class="form-row">
                <label class="form-label">提供商</label>
                <n-select
                  v-model:value="target.providerId"
                  :options="providerOptions"
                  placeholder="选择提供商"
                  size="small"
                  @update:value="() => target.modelId = ''"
                />
              </div>
              <div class="form-row">
                <label class="form-label">模型</label>
                <n-select
                  v-model:value="target.modelId"
                  :options="getModelOptionsByProvider(target.providerId)"
                  placeholder="选择模型"
                  size="small"
                  :disabled="!target.providerId"
                />
              </div>
              <div v-if="localConfigType === 'loadbalance'" class="form-row">
                <label class="form-label">权重</label>
                <n-input-number
                  v-model:value="target.weight"
                  :min="0"
                  :max="1"
                  :step="0.1"
                  placeholder="0.0 - 1.0"
                  size="small"
                  style="width: 100%"
                />
              </div>
              <div v-if="localConfigType === 'fallback'" class="form-row">
                <label class="form-label">触发状态码</label>
                <n-select
                  v-model:value="target.onStatusCodes"
                  multiple
                  :options="statusCodeOptions"
                  placeholder="选择状态码"
                  size="small"
                />
              </div>
            </n-space>
          </n-card>

          <n-button dashed block @click="addTarget" size="small">
            <template #icon>
              <n-icon><AddOutline /></n-icon>
            </template>
            添加目标
          </n-button>
        </n-space>
      </div>

      <div v-if="currentStep === 4" class="step-panel">
        <n-alert type="info" style="margin-bottom: 16px;">
          为虚拟模型配置属性（可选）。可以从 LiteLLM 预设库搜索并应用配置。
        </n-alert>

        <n-space vertical :size="12">
          <n-button
            size="small"
            type="primary"
            secondary
            @click="showLiteLLMSelector = true"
          >
            从 LiteLLM 搜索预设
          </n-button>

          <ModelAttributesEditor v-model="localFormValue.modelAttributes" />
        </n-space>
      </div>
    </div>

    <n-modal
      v-model:show="showLiteLLMSelector"
      preset="card"
      title="从 LiteLLM 预设库搜索模型"
      :style="{ width: '800px' }"
    >
      <LiteLLMPresetSelector @select="handleLiteLLMSelect" />
    </n-modal>

    <div class="wizard-footer">
      <n-space justify="space-between">
        <n-button v-if="currentStep > 1" @click="prevStep" size="small">上一步</n-button>
        <div v-else></div>
        <n-space :size="8">
          <n-button @click="handleCancel" size="small">取消</n-button>
          <n-button v-if="currentStep < 4" type="primary" @click="nextStep" size="small">下一步</n-button>
          <n-button v-else type="primary" @click="handleSave" :loading="saving" size="small">
            {{ isEditing ? '保存修改' : '创建虚拟模型' }}
          </n-button>
        </n-space>
      </n-space>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
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
  NAlert,
  NCard,
  NButton,
  NIcon,
  NModal,
  useMessage,
} from 'naive-ui';
import {
  AddOutline,
  CloseOutline,
  ArrowUpOutline,
  ArrowDownOutline,
} from '@vicons/ionicons5';
import { litellmPresetsApi } from '@/api/litellm-presets';
import type { LiteLLMSearchResult } from '@/api/litellm-presets';
import ModelAttributesEditor from '@/components/ModelAttributesEditor.vue';
import LiteLLMPresetSelector from '@/components/LiteLLMPresetSelector.vue';

interface Target {
  providerId: string;
  modelId?: string;
  weight?: number;
  onStatusCodes?: number[];
}

interface FormValue {
  name: string;
  description: string;
  targets: Target[];
  createVirtualModel: boolean;
  virtualModelName: string;
  modelAttributes?: any;
}

interface Props {
  configType: 'loadbalance' | 'fallback';
  formValue: FormValue;
  providerOptions: Array<{ label: string; value: string }>;
  getModelOptionsByProvider: (providerId: string) => Array<{ label: string; value: string }>;
  statusCodeOptions: Array<{ label: string; value: number }>;
  saving: boolean;
  isEditing?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  'update:configType': [value: 'loadbalance' | 'fallback'];
  'update:formValue': [value: FormValue];
  save: [];
  cancel: [];
}>();

const message = useMessage();
const currentStep = ref(1);
const basicFormRef = ref();
const showLiteLLMSelector = ref(false);

const localConfigType = computed({
  get: () => props.configType,
  set: (value) => emit('update:configType', value),
});

const localFormValue = computed({
  get: () => props.formValue,
  set: (value) => emit('update:formValue', value),
});

const stepStatus = computed(() => {
  if (currentStep.value === 3 && localFormValue.value.targets.length === 0) {
    return 'error';
  }
  return 'process';
});

function nextStep() {
  if (currentStep.value === 1) {
    if (!localConfigType.value) {
      message.error('请选择配置类型');
      return;
    }
  } else if (currentStep.value === 2) {
    basicFormRef.value?.validate((errors: any) => {
      if (errors) {
        message.error('请完善基本信息');
        return;
      }
      localFormValue.value.name = localFormValue.value.virtualModelName;
      localFormValue.value.createVirtualModel = true;
      currentStep.value++;
    });
    return;
  }
  currentStep.value++;
}

function prevStep() {
  currentStep.value--;
}

function addTarget() {
  localFormValue.value.targets.push({
    providerId: '',
    modelId: '',
    weight: localConfigType.value === 'loadbalance' ? 0.5 : undefined,
    onStatusCodes: localConfigType.value === 'fallback' ? [] : undefined,
  });
}

function removeTarget(index: number) {
  localFormValue.value.targets.splice(index, 1);
}

function moveTargetUp(index: number) {
  if (index > 0) {
    const temp = localFormValue.value.targets[index];
    localFormValue.value.targets[index] = localFormValue.value.targets[index - 1];
    localFormValue.value.targets[index - 1] = temp;
  }
}

function moveTargetDown(index: number) {
  if (index < localFormValue.value.targets.length - 1) {
    const temp = localFormValue.value.targets[index];
    localFormValue.value.targets[index] = localFormValue.value.targets[index + 1];
    localFormValue.value.targets[index + 1] = temp;
  }
}

function handleSave() {
  if (localFormValue.value.targets.length === 0) {
    message.error('请至少添加一个目标');
    return;
  }

  const hasEmptyProvider = localFormValue.value.targets.some(t => !t.providerId);
  if (hasEmptyProvider) {
    message.error('请为所有目标选择提供商');
    return;
  }

  emit('save');
}

function handleCancel() {
  emit('cancel');
}

async function handleLiteLLMSelect(result: LiteLLMSearchResult) {
  try {
    const detail = await litellmPresetsApi.getModelDetail(result.modelName);

    localFormValue.value.modelAttributes = {
      ...localFormValue.value.modelAttributes,
      ...detail.attributes,
    };

    showLiteLLMSelector.value = false;
    message.success(`已应用 ${result.modelName} 的预设属性`);
  } catch (error: any) {
    message.error(error.message || '应用预设失败');
  }
}

watch(() => localConfigType.value, () => {
  localFormValue.value.targets = [];
});
</script>

<style scoped>
.virtual-model-wizard {
  padding: 20px 0;
}

.step-content {
  margin-top: 24px;
  min-height: 300px;
}

.step-panel {
  padding: 16px 0;
}

.config-type-option {
  padding: 8px 0;
}

.option-title {
  font-weight: 500;
  font-size: 14px;
  color: #262626;
  margin-bottom: 4px;
}

.option-description {
  font-size: 12px;
  color: #8c8c8c;
}

.target-card {
  background: #fafafa;
}

.target-title {
  font-weight: 500;
  font-size: 13px;
}

.form-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-label {
  font-size: 12px;
  color: #595959;
  font-weight: 500;
}

.wizard-footer {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid #e8e8e8;
}
</style>


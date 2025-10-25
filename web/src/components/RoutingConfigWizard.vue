<template>
  <div class="routing-config-wizard">
    <n-steps :current="currentStep" :status="stepStatus" size="small">
      <n-step title="选择类型" />
      <n-step title="基本信息" />
      <n-step title="目标配置" />
    </n-steps>

    <div class="step-content">
      <!-- 步骤 1: 选择类型 -->
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

      <!-- 步骤 2: 基本信息 -->
      <div v-if="currentStep === 2" class="step-panel">
        <n-form ref="basicFormRef" :model="localFormValue" label-placement="top" :show-feedback="false">
          <n-form-item label="配置名称" path="name" :rule="{ required: true, message: '请输入配置名称' }">
            <n-input
              v-model:value="localFormValue.name"
              :placeholder="localConfigType === 'loadbalance' ? '生产环境负载均衡' : '生产环境故障转移'"
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

          <n-divider style="margin: 20px 0;" />

          <n-form-item>
            <template #label>
              <n-space align="center" :size="8">
                <span>创建智能路由</span>
                <n-switch v-model:value="localFormValue.createVirtualModel" size="small" />
              </n-space>
            </template>
            <n-text depth="3" style="font-size: 12px">
              创建后可通过统一的模型名称访问此路由配置
            </n-text>
          </n-form-item>

          <template v-if="localFormValue.createVirtualModel">
            <n-form-item label="智能路由名称" path="virtualModelName" :rule="{ required: true, message: '请输入智能路由名称' }">
              <n-input
                v-model:value="localFormValue.virtualModelName"
                :placeholder="localConfigType === 'loadbalance' ? 'GPT-4-LB' : 'GPT-4-Fallback'"
              />
            </n-form-item>
          </template>
        </n-form>
      </div>

      <!-- 步骤 3: 目标配置 -->
      <div v-if="currentStep === 3" class="step-panel">
        <n-alert v-if="localConfigType === 'fallback'" type="info" style="margin-bottom: 16px;">
          <div style="font-size: 13px;">按优先级从高到低排列，失败时自动切换到下一个</div>
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
    </div>

    <div class="wizard-footer">
      <n-space justify="space-between">
        <n-button v-if="currentStep > 1" @click="prevStep" size="small">上一步</n-button>
        <div v-else></div>
        <n-space :size="8">
          <n-button @click="handleCancel" size="small">取消</n-button>
          <n-button v-if="currentStep < 3" type="primary" @click="nextStep" size="small">下一步</n-button>
          <n-button v-else type="primary" @click="handleSave" :loading="saving" size="small">保存配置</n-button>
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
  NSwitch,
  NDivider,
  NAlert,
  NCard,
  NButton,
  NIcon,
  NText,
  useMessage,
} from 'naive-ui';
import {
  AddOutline,
  CloseOutline,
  ArrowUpOutline,
  ArrowDownOutline,
} from '@vicons/ionicons5';

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
  providerId: string;
}

interface Props {
  configType: 'loadbalance' | 'fallback';
  formValue: FormValue;
  providerOptions: Array<{ label: string; value: string }>;
  getModelOptionsByProvider: (providerId: string) => Array<{ label: string; value: string }>;
  statusCodeOptions: Array<{ label: string; value: number }>;
  saving: boolean;
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

const localConfigType = computed({
  get: () => props.configType,
  set: (value) => emit('update:configType', value),
});

const localFormValue = computed({
  get: () => props.formValue,
  set: (value) => emit('update:formValue', value),
});

const stepStatus = computed(() => {
  return currentStep.value === 3 && localFormValue.value.targets.length === 0 ? 'error' : 'process';
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
    onStatusCodes: localConfigType.value === 'fallback' ? [429, 500] : undefined,
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

  for (const target of localFormValue.value.targets) {
    if (!target.providerId) {
      message.error('请为所有目标选择提供商');
      return;
    }
    if (!target.modelId) {
      message.error('请为所有目标选择模型');
      return;
    }
  }

  if (localFormValue.value.createVirtualModel) {
    if (!localFormValue.value.virtualModelName) {
      message.error('请输入虚拟模型名称');
      return;
    }
  }

  const totalWeight = localFormValue.value.targets.reduce((sum, t) => sum + (t.weight || 0), 0);
  if (localConfigType.value === 'loadbalance' && Math.abs(totalWeight - 1) > 0.01) {
    message.warning(`权重总和应为 1.0，当前为 ${totalWeight.toFixed(2)}`);
  }

  emit('save');
}

function handleCancel() {
  emit('cancel');
}

// 监听配置类型变化，重置表单
watch(localConfigType, () => {
  localFormValue.value.targets = [];
});
</script>

<style scoped>
.routing-config-wizard {
  padding: 16px 0;
}

.step-content {
  margin: 24px 0;
  min-height: 360px;
}

.step-panel {
  padding: 0;
}

.config-type-option {
  margin-left: 8px;
}

.option-title {
  font-weight: 500;
  margin-bottom: 2px;
  font-size: 14px;
}

.option-description {
  font-size: 12px;
  color: var(--n-text-color-3);
  line-height: 1.4;
}

.target-card {
  background: #fafafa;
}

.target-card :deep(.n-card__header) {
  padding: 12px 16px;
}

.target-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--n-text-color);
}

.form-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-label {
  font-size: 13px;
  color: var(--n-text-color-2);
  font-weight: 400;
}

.wizard-footer {
  border-top: 1px solid var(--n-border-color);
  padding-top: 16px;
  margin-top: 16px;
}
</style>

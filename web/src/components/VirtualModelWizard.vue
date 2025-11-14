<template>
  <div class="virtual-model-wizard">
    <n-steps :current="currentStep" :status="stepStatus" size="small">
      <n-step :title="t('wizard.selectTypeStep')" />
      <n-step :title="t('wizard.basicInfoStep')" />
      <n-step :title="t('wizard.targetConfigStep')" />
    </n-steps>

    <div class="step-content">
      <div v-if="currentStep === 1" class="step-panel">
        <n-radio-group v-model:value="localConfigType">
          <n-space vertical :size="12">
            <n-radio value="loadbalance">
              <div class="config-type-option">
                <div class="option-title">{{ t('wizard.loadBalanceOption') }}</div>
                <div class="option-description">{{ t('wizard.loadBalanceOptionDesc') }}</div>
              </div>
            </n-radio>
            <n-radio value="fallback">
              <div class="config-type-option">
                <div class="option-title">{{ t('wizard.fallbackOption') }}</div>
                <div class="option-description">{{ t('wizard.fallbackOptionDesc') }}</div>
              </div>
            </n-radio>
            <n-radio value="hash">
              <div class="config-type-option">
                <div class="option-title">一致性哈希</div>
                <div class="option-description">基于虚拟密钥或请求特征哈希，相同来源总是路由到相同provider，最大化缓存命中率</div>
              </div>
            </n-radio>
            <n-radio value="affinity">
              <div class="config-type-option">
                <div class="option-title">时间窗口亲和</div>
                <div class="option-description">在短时间窗口内持续使用同一provider，最大化缓存效益</div>
              </div>
            </n-radio>
          </n-space>
        </n-radio-group>
      </div>

      <div v-if="currentStep === 2" class="step-panel">
        <n-form ref="basicFormRef" :model="localFormValue" label-placement="top" :show-feedback="false">
          <n-form-item :label="t('wizard.virtualModelNameLabel')" path="virtualModelName" :rule="{ required: true, message: t('wizard.virtualModelNameRequired') }">
            <n-input
              v-model:value="localFormValue.virtualModelName"
              :placeholder="localConfigType === 'loadbalance' ? 'GPT-4-LB' : localConfigType === 'hash' ? 'GPT-4-Hash' : localConfigType === 'affinity' ? 'GPT-4-Affinity' : 'GPT-4-Fallback'"
            />
          </n-form-item>
          <n-form-item :label="t('wizard.descriptionLabel')">
            <n-input
              v-model:value="localFormValue.description"
              type="textarea"
              :placeholder="t('common.optional')"
              :rows="2"
            />
          </n-form-item>

          <n-form-item v-if="localConfigType === 'hash'" label="哈希源">
            <n-radio-group v-model:value="localFormValue.hashSource">
              <n-space vertical :size="8">
                <n-radio value="virtualKey">
                  <div class="config-type-option">
                    <div class="option-title" style="font-size: 13px;">虚拟密钥</div>
                    <div class="option-description" style="font-size: 11px;">相同API Key的请求总是路由到同一provider</div>
                  </div>
                </n-radio>
                <n-radio value="request">
                  <div class="config-type-option">
                    <div class="option-title" style="font-size: 13px;">请求内容</div>
                    <div class="option-description" style="font-size: 11px;">相同请求内容路由到同一provider（更细粒度）</div>
                  </div>
                </n-radio>
              </n-space>
            </n-radio-group>
          </n-form-item>

          <n-form-item v-if="localConfigType === 'affinity'" label="亲和性持续时间（秒）">
            <n-input-number
              v-model:value="localFormValue.affinityTTLSeconds"
              :min="10"
              :max="3600"
              :step="10"
              placeholder="300"
              style="width: 100%"
            >
              <template #suffix>
                秒
              </template>
            </n-input-number>
            <div style="font-size: 11px; color: #8c8c8c; margin-top: 4px;">
              在此时间内，所有请求将使用同一provider（默认300秒/5分钟）
            </div>
          </n-form-item>
        </n-form>
      </div>

      <div v-if="currentStep === 3" class="step-panel">
        <n-alert v-if="localConfigType === 'fallback'" type="info" style="margin-bottom: 16px;">
          <div style="font-size: 13px;">{{ t('wizard.fallbackPriorityTip') }}</div>
        </n-alert>
        <n-alert v-if="localConfigType === 'hash'" type="info" style="margin-bottom: 16px;">
          <div style="font-size: 13px;">Hash模式：权重决定了哈希空间的分配，权重越高，被分配到的概率越大</div>
        </n-alert>
        <n-alert v-if="localConfigType === 'affinity'" type="info" style="margin-bottom: 16px;">
          <div style="font-size: 13px;">Affinity模式：每次选择新provider时基于权重随机选择，在TTL时间内持续使用</div>
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
              <div v-if="['loadbalance', 'hash', 'affinity'].includes(localConfigType)" class="form-row">
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
        <n-button v-if="currentStep > 1" @click="prevStep" size="small">{{ t('common.previous') }}</n-button>
        <div v-else></div>
        <n-space :size="8">
          <n-button @click="handleCancel" size="small">{{ t('common.cancel') }}</n-button>
          <n-button v-if="currentStep < 3" type="primary" @click="nextStep" size="small">{{ t('common.next') }}</n-button>
          <n-button v-else type="primary" @click="handleSave" :loading="saving" size="small">
            {{ isEditing ? t('common.save') : t('virtualModels.addVirtualModel') }}
          </n-button>
        </n-space>
      </n-space>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { VirtualModelFormValue, RoutingConfigType } from '@/types/virtual-model';

const { t } = useI18n();
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
  useMessage,
} from 'naive-ui';
import {
  AddOutline,
  CloseOutline,
  ArrowUpOutline,
  ArrowDownOutline,
} from '@vicons/ionicons5';

interface Props {
  configType: RoutingConfigType;
  formValue: VirtualModelFormValue;
  providerOptions: Array<{ label: string; value: string }>;
  getModelOptionsByProvider: (providerId: string) => Array<{ label: string; value: string }>;
  statusCodeOptions: Array<{ label: string; value: number }>;
  saving: boolean;
  isEditing?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  'update:configType': [value: RoutingConfigType];
  'update:formValue': [value: VirtualModelFormValue];
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
    weight: ['loadbalance', 'hash', 'affinity'].includes(localConfigType.value) ? 0.5 : undefined,
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


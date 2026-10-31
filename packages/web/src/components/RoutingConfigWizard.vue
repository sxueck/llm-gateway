<template>
  <div class="routing-config-wizard">
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
          </n-space>
        </n-radio-group>
      </div>

      <div v-if="currentStep === 2" class="step-panel">
        <n-form ref="basicFormRef" :model="localFormValue" label-placement="top" :show-feedback="false">
          <n-form-item :label="t('wizard.configName')" path="name" :rule="{ required: true, message: t('wizard.configNameRequired') }">
            <n-input
              v-model:value="localFormValue.name"
              :placeholder="localConfigType === 'loadbalance' ? t('wizard.placeholderLoadBalance') : t('wizard.placeholderFallback')"
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

          <n-divider style="margin: 20px 0;" />

          <n-form-item>
            <template #label>
              <n-space align="center" :size="8">
                <span>{{ t('wizard.createSmartRoute') }}</span>
                <n-switch v-model:value="localFormValue.createVirtualModel" size="small" />
              </n-space>
            </template>
            <n-text depth="3" style="font-size: 12px">
              {{ t('wizard.createSmartRouteHint') }}
            </n-text>
          </n-form-item>

          <template v-if="localFormValue.createVirtualModel">
            <n-form-item :label="t('wizard.virtualModelNameLabel')" path="virtualModelName" :rule="{ required: true, message: t('wizard.virtualModelNameRequired') }">
              <n-input
                v-model:value="localFormValue.virtualModelName"
                :placeholder="localConfigType === 'loadbalance' ? 'GPT-4-LB' : 'GPT-4-Fallback'"
              />
            </n-form-item>
          </template>
        </n-form>
      </div>

      <div v-if="currentStep === 3" class="step-panel">
        <n-alert v-if="localConfigType === 'fallback'" type="info" style="margin-bottom: 16px;">
          <div style="font-size: 13px;">{{ t('wizard.fallbackPriorityTip') }}</div>
        </n-alert>

        <n-space vertical :size="12">
          <n-card v-for="(target, index) in localFormValue.targets" :key="target.providerId + '-' + index" size="small" class="target-card">
            <template #header>
              <n-space justify="space-between" align="center">
                <span class="target-title">
                  {{ localConfigType === 'loadbalance' ? t('wizard.targetIndex', { index: index + 1 }) : t('wizard.priorityIndex', { index: index + 1 }) }}
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
                <label class="form-label">{{ t('dashboard.providers') }}</label>
                <n-select
                  v-model:value="target.providerId"
                  :options="providerOptions"
                  :placeholder="t('models.selectProvider')"
                  size="small"
                  @update:value="() => target.modelName = ''"
                />
              </div>
              <div class="form-row">
                <label class="form-label">{{ t('apiRequests.model') }}</label>
                <n-select
                  v-model:value="target.modelName"
                  :options="getModelOptionsByProvider(target.providerId)"
                  :placeholder="t('modelPresets.selectModel')"
                  size="small"
                  :disabled="!target.providerId"
                />
              </div>
              <div v-if="localConfigType === 'loadbalance'" class="form-row">
                <label class="form-label">{{ t('wizard.weight') }}</label>
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
                <label class="form-label">{{ t('wizard.triggerStatusCodes') }}</label>
                <n-select
                  v-model:value="target.onStatusCodes"
                  multiple
                  :options="statusCodeOptions"
                  :placeholder="t('wizard.selectStatusCodes')"
                  size="small"
                />
              </div>
            </n-space>
          </n-card>

          <n-button dashed block @click="addTarget" size="small">
            <template #icon>
              <n-icon><AddOutline /></n-icon>
            </template>
            {{ t('wizard.addTarget') }}
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
          <n-button v-else type="primary" @click="handleSave" :loading="saving" size="small">{{ t('wizard.saveConfig') }}</n-button>
        </n-space>
      </n-space>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
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
import { useRoutingTargets } from '@/composables/useRoutingTargets';

interface Target {
  providerId: string;
  modelName?: string;
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

const { t } = useI18n();
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

const targetsProxy = computed<typeof localFormValue.value.targets>({
  get: () => localFormValue.value.targets,
  set: (val) => {
    localFormValue.value = { ...localFormValue.value, targets: val };
  },
});

const { addTarget, removeTarget, moveTargetUp, moveTargetDown, validateTargets, getTotalWeight } =
  useRoutingTargets({
    configType: localConfigType as any,
    targets: targetsProxy as any,
    clearOnTypeChange: true,
    defaultFallbackStatusCodes: [429, 500],
  });

const stepStatus = computed(() => {
  return currentStep.value === 3 && localFormValue.value.targets.length === 0 ? 'error' : 'process';
});

function nextStep() {
  if (currentStep.value === 1) {
    if (!localConfigType.value) {
      message.error(t('wizard.selectConfigType'));
      return;
    }
  } else if (currentStep.value === 2) {
    basicFormRef.value?.validate((errors: any) => {
      if (errors) {
        message.error(t('wizard.completeBasicInfo'));
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

function handleSave() {
  const result = validateTargets();
  if (!result.valid) {
    message.error(result.message!);
    return;
  }

  if (localFormValue.value.createVirtualModel) {
    if (!localFormValue.value.virtualModelName) {
      message.error(t('wizard.enterVirtualModelName'));
      return;
    }
  }

  const totalWeight = getTotalWeight();
  if (localConfigType.value === 'loadbalance' && Math.abs(totalWeight - 1) > 0.01) {
    message.warning(t('wizard.weightSumWarning', { value: totalWeight.toFixed(2) }));
  }

  emit('save');
}

function handleCancel() {
  emit('cancel');
}
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

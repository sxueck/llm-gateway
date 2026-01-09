<template>
  <div>
    <n-form :model="formValue" label-placement="left" :label-width="120">
      <n-form-item :label="t('expertRouting.expertCategory')" required>
        <n-input
          v-model:value="formValue.category"
          :placeholder="t('expertRouting.expertCategoryPlaceholder')"
        />
      </n-form-item>

      <n-form-item :label="t('expertRouting.modelType')" required>
        <n-radio-group v-model:value="formValue.type" class="model-type-radio">
          <n-space :size="16">
            <n-radio value="virtual">{{ t('expertRouting.virtualModel') }}</n-radio>
            <n-radio value="real">{{ t('expertRouting.realModel') }}</n-radio>
          </n-space>
        </n-radio-group>
      </n-form-item>

      <n-form-item
        v-if="formValue.type === 'virtual'"
        :label="t('expertRouting.virtualModel')"
        required
      >
        <n-select
          v-model:value="formValue.model_id"
          :options="virtualModelOptions"
          :placeholder="t('expertRouting.selectVirtualModel')"
        />
      </n-form-item>

      <template v-else>
        <n-form-item :label="t('expertRouting.selectProvider')" required>
          <n-select
            v-model:value="formValue.provider_id"
            :options="providerOptions"
            :placeholder="t('expertRouting.selectProvider')"
            @update:value="handleProviderChange"
          />
        </n-form-item>
        <n-form-item :label="t('expertRouting.modelName')" required>
          <n-select
            v-model:value="formValue.model"
            :options="providerModelOptions"
            :placeholder="t('expertRouting.selectModel')"
            :disabled="!formValue.provider_id"
            filterable
          />
        </n-form-item>
      </template>

      <n-form-item :label="t('expertRouting.expertDescription')">
        <n-input
          v-model:value="formValue.description"
          type="textarea"
          :rows="3"
          :placeholder="t('expertRouting.expertDescriptionPlaceholder')"
        />
      </n-form-item>

      <n-form-item :label="t('expertRouting.expertColor')">
        <n-color-picker v-model:value="formValue.color" :modes="['hex']" />
      </n-form-item>
    </n-form>

    <n-space justify="end" style="margin-top: 16px">
      <n-button @click="$emit('cancel')">{{ t('common.cancel') }}</n-button>
      <n-button type="primary" @click="handleSave">{{ t('common.save') }}</n-button>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NForm,
  NFormItem,
  NInput,
  NRadioGroup,
  NRadio,
  NSelect,
  NColorPicker,
  NSpace,
  NButton,
} from 'naive-ui';
import { useModelStore } from '@/stores/model';
import type { ExpertTarget } from '@/api/expert-routing';

const { t } = useI18n();
const modelStore = useModelStore();

interface Props {
  expert: ExpertTarget;
  providerOptions?: Array<{ label: string; value: string }>;
  virtualModelOptions?: Array<{ label: string; value: string }>;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  save: [expert: ExpertTarget];
  cancel: [];
}>();

const formValue = ref<ExpertTarget>({ ...props.expert });

const providerModelOptions = computed(() => {
  if (!formValue.value.provider_id) {
    return [];
  }
  return modelStore.models
    .filter((m) => m.providerId === formValue.value.provider_id && m.isVirtual !== true)
    .map((m) => ({
      label: m.name,
      value: m.modelIdentifier,
    }));
});

function handleProviderChange() {
  formValue.value.model = '';
}

function handleSave() {
  emit('save', formValue.value);
}

watch(() => props.expert, (newExpert) => {
  formValue.value = { ...newExpert };
}, { deep: true });
</script>

<style scoped>
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


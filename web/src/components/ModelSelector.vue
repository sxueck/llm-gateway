<template>
  <div>
    <n-form-item :label="t('expertRouting.modelType')" required>
      <n-radio-group v-model:value="localType" class="model-type-radio">
        <n-space :size="16">
          <n-radio value="virtual">{{ t('expertRouting.virtualModel') }}</n-radio>
          <n-radio value="real">{{ t('expertRouting.realModel') }}</n-radio>
        </n-space>
      </n-radio-group>
    </n-form-item>

    <n-form-item
      v-if="localType === 'virtual'"
      :label="t('expertRouting.virtualModel')"
      required
    >
      <n-select
        v-model:value="localModelId"
        :options="virtualModelOptions"
        :placeholder="t('expertRouting.selectVirtualModel')"
      />
    </n-form-item>

    <template v-else>
      <n-form-item :label="t('expertRouting.selectProvider')" required>
        <n-select
          v-model:value="localProviderId"
          :options="providerOptions"
          :placeholder="t('expertRouting.selectProvider')"
          @update:value="handleProviderChange"
        />
      </n-form-item>
      <n-form-item :label="t('expertRouting.modelName')" required>
        <n-select
          v-model:value="localModel"
          :options="providerModelOptions"
          :placeholder="t('expertRouting.selectModel')"
          :disabled="!localProviderId"
          filterable
        />
      </n-form-item>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NFormItem,
  NRadioGroup,
  NRadio,
  NSelect,
  NSpace,
} from 'naive-ui';
import { useModelStore } from '@/stores/model';

const { t } = useI18n();
const modelStore = useModelStore();

interface Props {
  type: 'virtual' | 'real';
  modelId?: string;
  providerId?: string;
  model?: string;
  providerOptions: Array<{ label: string; value: string }>;
  virtualModelOptions: Array<{ label: string; value: string }>;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  'update:type': [value: 'virtual' | 'real'];
  'update:modelId': [value: string];
  'update:providerId': [value: string];
  'update:model': [value: string];
}>();

const localType = ref(props.type);
const localModelId = ref(props.modelId || '');
const localProviderId = ref(props.providerId || '');
const localModel = ref(props.model || '');

const providerModelOptions = computed(() => {
  if (!localProviderId.value) {
    return [];
  }
  return modelStore.models
    .filter((m) => m.providerId === localProviderId.value && m.isVirtual !== true)
    .map((m) => ({
      label: m.name,
      value: m.modelIdentifier,
    }));
});

function handleProviderChange() {
  localModel.value = '';
  emit('update:model', '');
}

watch(localType, (newVal) => {
  emit('update:type', newVal);
});

watch(localModelId, (newVal) => {
  emit('update:modelId', newVal);
});

watch(localProviderId, (newVal) => {
  emit('update:providerId', newVal);
});

watch(localModel, (newVal) => {
  emit('update:model', newVal);
});

watch(() => props.type, (newVal) => {
  localType.value = newVal;
});

watch(() => props.modelId, (newVal) => {
  localModelId.value = newVal || '';
});

watch(() => props.providerId, (newVal) => {
  localProviderId.value = newVal || '';
});

watch(() => props.model, (newVal) => {
  localModel.value = newVal || '';
});
</script>


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
          :loading="loadingModels"
          filterable
        />
      </n-form-item>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NFormItem,
  NRadioGroup,
  NRadio,
  NSelect,
  NSpace,
} from 'naive-ui';
import { useProviderModels } from '@/composables/useProviderModels';

const { t } = useI18n();

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

const localType = computed({
  get: () => props.type,
  set: (val) => emit('update:type', val)
});

const localModelId = computed({
  get: () => props.modelId || '',
  set: (val) => emit('update:modelId', val)
});

const localProviderId = computed({
  get: () => props.providerId || '',
  set: (val) => emit('update:providerId', val)
});

const localModel = computed({
  get: () => props.model || '',
  set: (val) => emit('update:model', val)
});

const { options: providerModelOptions, loading: loadingModels } = useProviderModels(
  () => props.providerId,
);

function handleProviderChange() {
  localModel.value = '';
}
</script>


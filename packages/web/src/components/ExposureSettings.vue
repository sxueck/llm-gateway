<template>
  <n-form label-placement="left" label-align="left" label-width="180" size="small" class="switch-form">
    <n-form-item :label="t('expertRouting.exposureHeaders')">
      <n-switch :value="headers" @update:value="(v) => update({ headers: v })" />
      <template #feedback>
        {{ t('expertRouting.exposureHeadersHint') }}
      </template>
    </n-form-item>
    <n-form-item :label="t('expertRouting.exposureProviderHeader')">
      <n-switch
        :value="providerHeader"
        @update:value="(v) => update({ provider_header: v })"
      />
      <template #feedback>
        {{ t('expertRouting.exposureProviderHeaderHint') }}
      </template>
    </n-form-item>
    <n-form-item :label="t('expertRouting.exposureModelField')" label-placement="top">
      <n-radio-group
        :value="modelField"
        @update:value="(v) => update({ model_field: v })"
      >
        <n-space>
          <n-radio value="upstream">
            {{ t('expertRouting.exposureModelFieldUpstream') }}
          </n-radio>
          <n-radio value="gateway_name">
            {{ t('expertRouting.exposureModelFieldGatewayName') }}
          </n-radio>
        </n-space>
      </n-radio-group>
      <template #feedback>
        {{ t('expertRouting.exposureModelFieldHint') }}
      </template>
    </n-form-item>
    <n-form-item :label="t('expertRouting.exposureSseComment')">
      <n-switch
        :value="sseComment"
        @update:value="(v) => update({ sse_comment: v })"
      />
      <template #feedback>
        {{ t('expertRouting.exposureSseCommentHint') }}
      </template>
    </n-form-item>
  </n-form>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NForm,
  NFormItem,
  NRadio,
  NRadioGroup,
  NSpace,
  NSwitch,
} from 'naive-ui';
import type { ExposureConfig } from '@/api/expert-routing';

interface Props {
  exposure: ExposureConfig;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  'update:exposure': [value: ExposureConfig];
}>();

const { t } = useI18n();

// 归一化默认值与后端 DEFAULT_EXPOSURE 一致。
const headers = computed(() => props.exposure.headers ?? true);
const providerHeader = computed(() => props.exposure.provider_header ?? false);
const modelField = computed(
  () => props.exposure.model_field ?? 'upstream',
);
const sseComment = computed(() => props.exposure.sse_comment ?? false);

function update(patch: Partial<ExposureConfig>) {
  emit('update:exposure', {
    headers: headers.value,
    provider_header: providerHeader.value,
    model_field: modelField.value,
    sse_comment: sseComment.value,
    ...patch,
  });
}
</script>

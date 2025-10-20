<template>
  <n-space vertical :size="16">
    <n-space justify="space-between" align="center">
      <span style="font-weight: 500; font-size: 14px;">Prompt 配置</span>
      <n-switch v-model:value="localEnabled" size="small" @update:value="handleEnabledChange">
        <template #checked>启用</template>
        <template #unchecked>禁用</template>
      </n-switch>
    </n-space>

    <n-form-item label="操作类型" :show-feedback="false">
      <n-select
        v-model:value="localConfig.operationType"
        :options="operationTypeOptions"
        :disabled="!localEnabled"
        @update:value="handleChange"
        placeholder="选择操作类型"
      />
    </n-form-item>

    <n-form-item
      v-if="localConfig.operationType !== 'system'"
      label="模板内容"
      :show-feedback="false"
    >
      <n-input
        v-model:value="localConfig.templateContent"
        type="textarea"
        :placeholder="getPlaceholder()"
        :autosize="{ minRows: 5, maxRows: 10 }"
        @update:value="handleChange"
        :disabled="!localEnabled"
      />
    </n-form-item>

    <n-form-item
      v-if="localConfig.operationType === 'system'"
      label="System Message"
      :show-feedback="false"
    >
      <n-input
        v-model:value="localConfig.systemMessage"
        type="textarea"
        placeholder="例如: 你是一个专业的编程助手，当前日期是 {{date}}"
        :autosize="{ minRows: 5, maxRows: 10 }"
        @update:value="handleChange"
        :disabled="!localEnabled"
      />
    </n-form-item>

    <n-form-item label="注入时机" :show-feedback="false">
      <n-space vertical :size="8" style="width: 100%">
        <n-checkbox
          v-model:checked="localConfig.injectOnce"
          :disabled="!localEnabled"
          @update:checked="handleChange"
        >
          仅在对话开始时注入一次
        </n-checkbox>
        <div style="font-size: 12px; color: rgba(0, 0, 0, 0.45); margin-left: 24px;">
          启用后, Prompt 只会在首次请求时注入以避免重复注入相同内容
        </div>
      </n-space>
    </n-form-item>

    <div class="variables-hint">
      <div class="variables-title">支持的变量</div>
      <div class="variables-list">
        <div class="variable-item">
          <code class="variable-code" v-html="'{{user_prompt}}'"></code>
          <span class="variable-desc">用户的原始 prompt</span>
        </div>
        <div class="variable-item">
          <code class="variable-code" v-html="'{{date}}'"></code>
          <span class="variable-desc">当前日期 (YYYY-MM-DD)</span>
        </div>
      </div>
    </div>
  </n-space>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  NSpace,
  NSwitch,
  NFormItem,
  NSelect,
  NInput,
  NCheckbox
} from 'naive-ui';
import type { PromptConfig } from '../types';

const operationTypeOptions = [
  {
    label: 'Replace - 完全替换用户的原始 prompt',
    value: 'replace'
  },
  {
    label: 'Prepend - 在用户 prompt 前添加内容',
    value: 'prepend'
  },
  {
    label: 'System - 设置或替换 system message',
    value: 'system'
  }
];

const props = defineProps<{
  modelValue?: PromptConfig | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: PromptConfig | null];
}>();

const defaultConfig: PromptConfig = {
  operationType: 'prepend',
  templateContent: '',
  systemMessage: '',
  enabled: false,
  injectOnce: false,
};

const localConfig = ref<PromptConfig>({ ...defaultConfig });
const localEnabled = ref(false);

function resetToDefault() {
  localConfig.value = { ...defaultConfig };
  localEnabled.value = false;
}

watch(
  () => props.modelValue,
  (newValue) => {
    if (newValue) {
      localConfig.value = { ...newValue };
      localEnabled.value = newValue.enabled;
    } else {
      resetToDefault();
    }
  },
  { immediate: true }
);

function handleChange() {
  if (localEnabled.value) {
    emit('update:modelValue', { ...localConfig.value, enabled: true });
  }
}

function handleEnabledChange(enabled: boolean) {
  if (enabled) {
    emit('update:modelValue', { ...localConfig.value, enabled: true });
  } else {
    emit('update:modelValue', null);
  }
}

function getPlaceholder() {
  switch (localConfig.value.operationType) {
    case 'replace':
      return '例如: 请用简洁的方式回答: {{user_prompt}}';
    case 'prepend':
      return '例如: 你是一个专业的编程助手。';
    default:
      return '';
  }
}
</script>

<style scoped>
.variables-hint {
  background: rgba(24, 160, 88, 0.06);
  border-radius: 6px;
  padding: 14px 16px;
  margin-top: 4px;
}

.variables-title {
  font-size: 13px;
  font-weight: 500;
  color: rgba(0, 0, 0, 0.88);
  margin-bottom: 10px;
  letter-spacing: 0.2px;
}

.variables-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.variable-item {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  line-height: 1.6;
}

.variable-code {
  background: rgba(0, 0, 0, 0.06);
  color: #18a058;
  padding: 3px 8px;
  border-radius: 4px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  min-width: 120px;
  display: inline-block;
}

.variable-desc {
  color: rgba(0, 0, 0, 0.65);
  font-size: 12px;
}
</style>


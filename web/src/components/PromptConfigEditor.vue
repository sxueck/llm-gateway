<template>
  <n-space vertical :size="12">
    <n-space justify="space-between" align="center">
      <span style="font-weight: 500;">Prompt 配置</span>
      <n-switch v-model:value="localEnabled" size="small" @update:value="handleEnabledChange">
        <template #checked>启用</template>
        <template #unchecked>禁用</template>
      </n-switch>
    </n-space>

    <n-form-item label="操作类型" :show-feedback="false">
      <n-radio-group v-model:value="localConfig.operationType" @update:value="handleChange" :disabled="!localEnabled">
        <n-space>
          <n-radio value="replace">
            <n-space :size="4" align="center">
              <span>Replace</span>
              <n-tooltip trigger="hover">
                <template #trigger>
                  <InfoIcon />
                </template>
                完全替换用户的原始 prompt
              </n-tooltip>
            </n-space>
          </n-radio>
          <n-radio value="prepend">
            <n-space :size="4" align="center">
              <span>Prepend</span>
              <n-tooltip trigger="hover">
                <template #trigger>
                  <InfoIcon />
                </template>
                在用户 prompt 前添加内容
              </n-tooltip>
            </n-space>
          </n-radio>
          <n-radio value="system">
            <n-space :size="4" align="center">
              <span>System</span>
              <n-tooltip trigger="hover">
                <template #trigger>
                  <InfoIcon />
                </template>
                设置或替换 system message
              </n-tooltip>
            </n-space>
          </n-radio>
        </n-space>
      </n-radio-group>
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
        :autosize="{ minRows: 3, maxRows: 6 }"
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
        :autosize="{ minRows: 3, maxRows: 6 }"
        @update:value="handleChange"
        :disabled="!localEnabled"
      />
    </n-form-item>

    <n-alert type="info" :bordered="false" size="small">
      <template #header>
        <span style="font-size: 12px;">支持的变量</span>
      </template>
      <div style="font-size: 12px; line-height: 1.6;">
        <div><code v-text="'{{user_prompt}}'"></code> - 用户的原始 prompt</div>
        <div><code v-text="'{{date}}'"></code> - 当前日期 (YYYY-MM-DD)</div>
      </div>
    </n-alert>
  </n-space>
</template>

<script setup lang="ts">
import { ref, watch, h } from 'vue';
import { NIcon } from 'naive-ui';
import type { PromptConfig } from '../types';

const InfoIcon = () => h(NIcon, { size: 14, style: { color: '#999' } }, {
  default: () => h('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 24 24',
    fill: 'currentColor'
  }, [
    h('path', { d: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z' })
  ])
});

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
code {
  background-color: rgba(150, 150, 150, 0.1);
  padding: 2px 6px;
  border-radius: 3px;
  font-family: 'Courier New', monospace;
  font-size: 11px;
}
</style>


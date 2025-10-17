<template>
  <n-space vertical :size="16">
    <n-space justify="space-between" align="center">
      <span style="font-weight: 500; font-size: 14px;">上下文压缩配置</span>
      <n-switch v-model:value="localEnabled" size="small" @update:value="handleEnabledChange">
        <template #checked>启用</template>
        <template #unchecked>禁用</template>
      </n-switch>
    </n-space>

    <n-alert type="warning" :bordered="false" style="margin-bottom: 8px;">
      <template #header>重要提示</template>
      <n-space vertical :size="3">
        <div style="font-size: 12px;">• 仅支持纯文本对话，不建议在多模态模型（支持图片、文件等）上启用</div>
        <div style="font-size: 12px;">• 压缩会保留可能相关的代码、日志等关键信息，省略明确无关的内容</div>
        <div style="font-size: 12px;">• 必须配置摘要模型才能启用压缩功能</div>
        <div style="font-size: 12px;">• 每次压缩会产生额外的 LLM 调用成本（约 100-200ms 延迟）</div>
      </n-space>
    </n-alert>

    <n-form-item label="Token 阈值" :show-feedback="false">
      <n-input-number
        v-model:value="localConfig.maxTokens"
        :min="1000"
        :max="200000"
        :step="1000"
        :disabled="!localEnabled"
        @update:value="handleChange"
        placeholder="默认 30000"
        style="width: 100%"
      >
        <template #suffix>tokens</template>
      </n-input-number>
    </n-form-item>

    <n-form-item label="最小消息数" :show-feedback="false">
      <n-input-number
        v-model:value="localConfig.minMessages"
        :min="2"
        :max="100"
        :step="1"
        :disabled="!localEnabled"
        @update:value="handleChange"
        placeholder="默认 4"
        style="width: 100%"
      >
        <template #suffix>条</template>
      </n-input-number>
    </n-form-item>

    <n-form-item label="保留最近消息" :show-feedback="false">
      <n-input-number
        v-model:value="localConfig.keepRecentTokens"
        :min="500"
        :max="100000"
        :step="500"
        :disabled="!localEnabled"
        @update:value="handleChange"
        placeholder="默认 10000"
        style="width: 100%"
      >
        <template #suffix>tokens</template>
      </n-input-number>
    </n-form-item>

    <n-form-item label="压缩比例" :show-feedback="false">
      <n-select
        v-model:value="localConfig.compressionRatio"
        :options="compressionRatioOptions"
        :disabled="!localEnabled"
        @update:value="handleChange"
        placeholder="选择压缩比例"
      />
    </n-form-item>

    <n-form-item label="摘要模型" :show-feedback="false">
      <n-select
        v-model:value="localConfig.summaryModelId"
        :options="modelOptions"
        :disabled="!localEnabled"
        @update:value="handleChange"
        placeholder="选择用于生成摘要的模型"
        clearable
        filterable
      />
    </n-form-item>

    <n-form-item label="自定义摘要 Prompt" :show-feedback="false">
      <n-input
        v-model:value="localConfig.summaryPrompt"
        type="textarea"
        placeholder="留空使用默认 prompt"
        :autosize="{ minRows: 4, maxRows: 8 }"
        @update:value="handleChange"
        :disabled="!localEnabled"
      />
    </n-form-item>

    <div class="info-hint">
      <div class="info-title">配置说明</div>
      <div class="info-list">
        <div class="info-item">
          <strong>Token 阈值:</strong> 当对话历史超过此 Token 数量时触发压缩
        </div>
        <div class="info-item">
          <strong>最小消息数:</strong> 只有消息数量大于此值时才会压缩
        </div>
        <div class="info-item">
          <strong>保留最近消息:</strong> 压缩时保留最近的消息,确保上下文连贯性
        </div>
        <div class="info-item">
          <strong>压缩比例:</strong> 目标压缩后的摘要占原始内容的比例
        </div>
        <div class="info-item">
          <strong>摘要模型:</strong> 用于生成摘要的 LLM 模型,建议使用低成本模型
        </div>
      </div>
    </div>
  </n-space>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import {
  NSpace,
  NSwitch,
  NFormItem,
  NSelect,
  NInput,
  NInputNumber,
  NAlert
} from 'naive-ui';
import type { CompressionConfig, Model } from '../types';

const props = defineProps<{
  modelValue?: CompressionConfig | null;
  models?: Model[];
}>();

const emit = defineEmits<{
  'update:modelValue': [value: CompressionConfig | null];
}>();

const defaultConfig: CompressionConfig = {
  enabled: true,
  maxTokens: 30000,
  minMessages: 4,
  keepRecentTokens: 10000,
  compressionRatio: 0.3,
  summaryModelId: undefined,
  summaryPrompt: '',
};

const localConfig = ref<CompressionConfig>({ ...defaultConfig });
const localEnabled = ref(false);

const compressionRatioOptions = [
  { label: '20%', value: 0.2 },
  { label: '30%', value: 0.3 },
  { label: '50%', value: 0.5 },
  { label: '70%', value: 0.7 },
];

const modelOptions = computed(() => {
  if (!props.models) return [];

  return props.models
    .filter(m => m.enabled)
    .map(m => ({
      label: `${m.name} (${m.providerName})`,
      value: m.id,
    }));
});

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
</script>

<style scoped>
.info-hint {
  background: rgba(24, 160, 88, 0.06);
  border-radius: 6px;
  padding: 14px 16px;
  margin-top: 4px;
}

.info-title {
  font-size: 13px;
  font-weight: 500;
  color: rgba(0, 0, 0, 0.88);
  margin-bottom: 10px;
  letter-spacing: 0.2px;
}

.info-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.info-item {
  font-size: 12px;
  line-height: 1.6;
  color: rgba(0, 0, 0, 0.65);
}

.info-item strong {
  color: rgba(0, 0, 0, 0.88);
  font-weight: 500;
}
</style>


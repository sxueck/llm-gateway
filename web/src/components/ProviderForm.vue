<template>
  <n-form ref="formRef" :model="formValue" :rules="rules" label-placement="left" label-width="90" size="small">
    <n-form-item label="提供商 ID" path="id">
      <n-space vertical style="width: 100%" :size="6">
        <n-auto-complete
          v-model:value="formValue.id"
          :disabled="!!editingId"
          :options="idSuggestions"
          placeholder="如: deepseek"
          size="small"
          @input="handleIdInput"
          @blur="validateId"
        />
        <n-alert
          v-if="idValidation.message"
          :type="getIdValidationType()"
          :title="idValidation.message"
          size="small"
          :closable="false"
          :bordered="false"
        >
          <div v-if="idValidation.suggestion" style="font-size: 12px">
            {{ idValidation.suggestion }}
          </div>
        </n-alert>
      </n-space>
    </n-form-item>

    <n-form-item label="显示名称" path="name">
      <n-input v-model:value="formValue.name" placeholder="如: DeepSeek" size="small" />
    </n-form-item>

    <n-form-item label="协议类型" path="protocol">
      <n-select
        v-model:value="formValue.protocol"
        :options="protocolOptions"
        placeholder="选择上游协议"
        size="small"
      />
    </n-form-item>

    <n-form-item label="Base URL" path="baseUrl">
      <n-space vertical style="width: 100%" :size="6">
        <n-input
          v-model:value="formValue.baseUrl"
          placeholder="https://api.deepseek.com"
          size="small"
          @blur="validateUrl"
        />
        <n-alert
          v-if="urlValidation.message"
          :type="urlValidation.isValid ? 'success' : 'error'"
          :title="urlValidation.message"
          size="small"
          :closable="false"
          :bordered="false"
        />
      </n-space>
    </n-form-item>

    <n-form-item label="API Key" path="apiKey">
      <n-space vertical style="width: 100%" :size="6">
        <n-space style="width: 100%" :size="8">
          <n-input
            v-model:value="formValue.apiKey"
            type="password"
            show-password-on="click"
            :placeholder="editingId ? '留空则保持原有密钥不变' : 'sk-xxx'"
            size="small"
            @blur="validateKey"
            style="flex: 1"
          />
          <n-button
            @click="handleFetchModels"
            :loading="fetchingModels"
            :disabled="!formValue.baseUrl || !formValue.apiKey"
            size="small"
          >
            获取模型
          </n-button>
        </n-space>
        <n-alert
          v-if="editingId && !formValue.apiKey"
          type="info"
          title="已有 API Key"
          size="small"
          :closable="false"
          :bordered="false"
        >
          <div style="font-size: 13px;">当前提供商已配置 API Key，如需更新请输入新的密钥</div>
        </n-alert>
        <n-alert
          v-if="keyValidation.message"
          :type="keyValidation.isValid ? 'success' : 'error'"
          :title="keyValidation.message"
          size="small"
          :closable="false"
          :bordered="false"
        />
        <n-alert
          v-if="fetchError"
          type="warning"
          :title="fetchError"
          size="small"
          :closable="false"
          :bordered="false"
        >
          <div style="font-size: 13px; margin-top: 4px;">
            该提供商可能不支持标准的 /models 接口。您可以在创建提供商后，通过"批量添加模型"功能手动添加模型。
          </div>
        </n-alert>
      </n-space>
    </n-form-item>

    <n-form-item v-if="availableModels.length > 0" label="选择模型">
      <n-space vertical style="width: 100%" :size="6">
        <n-select
          v-model:value="selectedModels"
          :options="modelOptions"
          multiple
          filterable
          placeholder="选择要添加的模型"
          max-tag-count="responsive"
          size="small"
        />
        <n-text depth="3" style="font-size: 11px">
          已选择 {{ selectedModels.length }} 个模型
        </n-text>
      </n-space>
    </n-form-item>

    <n-form-item label="启用">
      <n-switch v-model:value="formValue.enabled" size="small" />
    </n-form-item>
  </n-form>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import {
  NForm,
  NFormItem,
  NInput,
  NSwitch,
  NSpace,
  NAlert,
  NAutoComplete,
  NButton,
  NSelect,
  NText,
  useMessage,
} from 'naive-ui';
import {
  validateProviderId,
  validateBaseUrl,
  validateApiKey,
  getProviderIdSuggestions
} from '@/utils/provider-validation';
import { providerApi, type ModelInfo } from '@/api/provider';

interface Props {
  modelValue: {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    protocol: string;
    enabled: boolean;
  };
  editingId?: string | null;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  'update:modelValue': [value: Props['modelValue']];
}>();

const message = useMessage();
const formRef = ref();
const idValidation = ref<ReturnType<typeof validateProviderId>>({ isValid: true, isSupported: true });
const urlValidation = ref<ReturnType<typeof validateBaseUrl>>({ isValid: true });
const keyValidation = ref<ReturnType<typeof validateApiKey>>({ isValid: true });
const fetchingModels = ref(false);
const availableModels = ref<ModelInfo[]>([]);
const selectedModels = ref<string[]>([]);
const fetchError = ref<string>('');

const formValue = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
});

const idSuggestions = computed(() => {
  const suggestions = getProviderIdSuggestions(formValue.value.id);
  return suggestions.map(id => ({ label: id, value: id }));
});

const protocolOptions = [
  { label: 'OpenAI 协议', value: 'openai' },
  { label: 'Anthropic 协议 (Claude)', value: 'anthropic' },
  { label: 'Google 协议 (Gemini)', value: 'google' },
];

const modelOptions = computed(() => {
  return availableModels.value.map(model => ({
    label: model.name,
    value: model.id,
  }));
});

const rules = {
  id: [
    { required: true, message: '请输入提供商 ID', trigger: 'blur' },
    {
      validator: (_rule: any, value: string) => {
        const validation = validateProviderId(value);
        return validation.isValid;
      },
      message: '提供商 ID 格式不正确',
      trigger: 'blur',
    },
  ],
  name: [{ required: true, message: '请输入显示名称', trigger: 'blur' }],
  protocol: [{ required: true, message: '请选择协议类型', trigger: 'change' }],
  baseUrl: [
    { required: true, message: '请输入 Base URL', trigger: 'blur' },
    {
      validator: (_rule: any, value: string) => {
        const validation = validateBaseUrl(value);
        return validation.isValid;
      },
      message: 'Base URL 格式不正确',
      trigger: 'blur',
    },
  ],
  apiKey: [
    {
      required: !props.editingId,
      message: '请输入 API Key',
      trigger: 'blur',
    },
    {
      validator: (_rule: any, value: string) => {
        if (!value && props.editingId) {
          return true;
        }
        const validation = validateApiKey(value, formValue.value.id);
        return validation.isValid;
      },
      message: 'API Key 格式不正确',
      trigger: 'blur',
    },
  ],
};

function handleIdInput(value: string) {
  formValue.value.id = value;
  if (value) {
    validateId();
  }
}

function validateId() {
  idValidation.value = validateProviderId(formValue.value.id);
}

function validateUrl() {
  urlValidation.value = validateBaseUrl(formValue.value.baseUrl);
}

function validateKey() {
  if (!formValue.value.apiKey && props.editingId) {
    keyValidation.value = { isValid: true };
    return;
  }
  keyValidation.value = validateApiKey(formValue.value.apiKey, formValue.value.id);
}

function getIdValidationType(): 'success' | 'warning' | 'error' {
  if (!idValidation.value.isValid) return 'error';
  if (!idValidation.value.isSupported) return 'warning';
  return 'success';
}

async function handleFetchModels() {
  if (!formValue.value.baseUrl || !formValue.value.apiKey) {
    message.warning('请先填写 Base URL 和 API Key');
    return;
  }

  try {
    fetchingModels.value = true;
    fetchError.value = '';
    const result = await providerApi.fetchModels(formValue.value.baseUrl, formValue.value.apiKey);

    if (result.success) {
      availableModels.value = result.models;
      selectedModels.value = [];
      fetchError.value = '';
      message.success(result.message);
    } else {
      availableModels.value = [];
      fetchError.value = result.message;
    }
  } catch (error: any) {
    availableModels.value = [];
    fetchError.value = error.message || '获取模型列表失败';
  } finally {
    fetchingModels.value = false;
  }
}

watch(() => formValue.value.id, () => {
  if (formValue.value.apiKey) {
    validateKey();
  }
});

defineExpose({
  validate: () => formRef.value?.validate(),
  getSelectedModels: () => selectedModels.value,
  getSelectedModelsInfo: () => {
    return availableModels.value.filter(model =>
      selectedModels.value.includes(model.id)
    );
  },
});
</script>

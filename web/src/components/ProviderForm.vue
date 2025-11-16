<template>
  <n-form ref="formRef" :model="formValue" :rules="rules" label-placement="left" label-width="120" size="small">
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
        />
      </n-space>
    </n-form-item>

    <n-form-item label="显示名称" path="name">
      <n-input v-model:value="formValue.name" placeholder="如: DeepSeek" size="small" />
    </n-form-item>

    <n-form-item label="多协议支持">
      <n-switch v-model:value="multiProtocolEnabled" size="small" />
    </n-form-item>

    <n-form-item v-if="!multiProtocolEnabled" label="Base URL" path="baseUrl">
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

    <template v-if="multiProtocolEnabled">
      <n-form-item label="OpenAI 协议 URL">
        <n-input
          v-model:value="protocolUrls.openai"
          placeholder="https://api.openai.com/v1"
          size="small"
        />
      </n-form-item>

      <n-form-item label="Anthropic 协议 URL">
        <n-input
          v-model:value="protocolUrls.anthropic"
          placeholder="https://api.anthropic.com/claude"
          size="small"
        />
      </n-form-item>

      <n-form-item label="Google 协议 URL">
        <n-input
          v-model:value="protocolUrls.google"
          placeholder="https://api.generativelanguage.googleapis.com/gemini"
          size="small"
        />
      </n-form-item>
    </template>

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
import type { ProtocolMapping } from '@/types';

interface Props {
  modelValue: {
    id: string;
    name: string;
    baseUrl: string;
    protocolMappings?: ProtocolMapping | null;
    apiKey: string;
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
const idValidation = ref<ReturnType<typeof validateProviderId>>({ isValid: true });
const urlValidation = ref<ReturnType<typeof validateBaseUrl>>({ isValid: true });
const keyValidation = ref<ReturnType<typeof validateApiKey>>({ isValid: true });
const fetchingModels = ref(false);
const availableModels = ref<ModelInfo[]>([]);
const selectedModels = ref<string[]>([]);
const fetchError = ref<string>('');
const multiProtocolEnabled = ref(false);
const protocolUrls = ref<ProtocolMapping>({
  openai: '',
  anthropic: '',
  google: '',
});

// 初始化多协议状态
if (props.modelValue.protocolMappings) {
  multiProtocolEnabled.value = true;
  protocolUrls.value = { ...props.modelValue.protocolMappings };
}

// 监听 modelValue.protocolMappings 的变化，用于编辑模式下异步加载数据
watch(() => props.modelValue.protocolMappings, (newMappings) => {
  if (newMappings) {
    // 仅在值实际变化时更新
    const hasChanged = !protocolUrls.value.openai && !protocolUrls.value.anthropic && !protocolUrls.value.google;
    if (hasChanged || JSON.stringify(protocolUrls.value) !== JSON.stringify(newMappings)) {
      multiProtocolEnabled.value = true;
      protocolUrls.value = { ...newMappings };
    }
  } else if (multiProtocolEnabled.value) {
    // 仅在当前启用多协议时才禁用
    multiProtocolEnabled.value = false;
    protocolUrls.value = {
      openai: '',
      anthropic: '',
      google: '',
    };
  }
}, { immediate: false });

const formValue = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
});

// 监听多协议开关变化
watch(multiProtocolEnabled, (enabled) => {
  if (enabled) {
    // 启用多协议时
    // 仅当所有协议 URL 都为空时（首次启用多协议），才将 baseUrl 复制到 openai URL
    const allProtocolsEmpty = !protocolUrls.value.openai && !protocolUrls.value.anthropic && !protocolUrls.value.google;
    if (allProtocolsEmpty && formValue.value.baseUrl) {
      protocolUrls.value.openai = formValue.value.baseUrl;
    }
    updateProtocolMappings();
  } else {
    // 禁用多协议时,将 protocolMappings 设置为 null
    // 如果有 openai URL，将其设置为 baseUrl
    if (protocolUrls.value.openai) {
      formValue.value.baseUrl = protocolUrls.value.openai;
    }
    formValue.value.protocolMappings = null;
    // 清空协议 URLs
    protocolUrls.value = {
      openai: '',
      anthropic: '',
      google: '',
    };
  }
});

// 移除实时监听，改为在需要时手动调用 updateProtocolMappings()

function updateProtocolMappings() {
  const mappings: ProtocolMapping = {};
  if (protocolUrls.value.openai) mappings.openai = protocolUrls.value.openai;
  if (protocolUrls.value.anthropic) mappings.anthropic = protocolUrls.value.anthropic;
  if (protocolUrls.value.google) mappings.google = protocolUrls.value.google;

  const newMappings = Object.keys(mappings).length > 0 ? mappings : null;

  // 当启用多协议时，baseUrl 设置为第一个可用的协议 URL（作为后备）
  // 但在实际使用时，后端会优先使用 protocolMappings 中对应协议的 URL
  const newBaseUrl = newMappings
    ? (mappings.openai || mappings.anthropic || mappings.google || '')
    : '';

  // 更新 formValue
  formValue.value.protocolMappings = newMappings;
  formValue.value.baseUrl = newBaseUrl;

  console.log('[ProviderForm] Protocol mappings synced:', {
    protocolMappings: newMappings,
    baseUrl: newBaseUrl,
  });
}

const idSuggestions = computed(() => {
  const suggestions = getProviderIdSuggestions(formValue.value.id);
  return suggestions.map(id => ({ label: id, value: id }));
});

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
  baseUrl: [
    {
      // 仅在未启用多协议时才要求必填
      required: () => !multiProtocolEnabled.value,
      message: '请输入 Base URL',
      trigger: 'blur'
    },
    {
      validator: (_rule: any, value: string) => {
        // 如果启用了多协议，baseUrl 会被自动设置，跳过验证
        if (multiProtocolEnabled.value) {
          return true;
        }
        // 单协议模式下，验证 baseUrl 格式
        if (!value) {
          return false;
        }
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

function getIdValidationType(): 'success' | 'error' {
  return idValidation.value.isValid ? 'success' : 'error';
}

async function handleFetchModels() {
  const baseUrlToUse = multiProtocolEnabled.value
    ? (protocolUrls.value.openai || protocolUrls.value.anthropic || protocolUrls.value.google)
    : formValue.value.baseUrl;

  if (!baseUrlToUse || !formValue.value.apiKey) {
    message.warning('请先填写 Base URL 和 API Key');
    return;
  }

  try {
    fetchingModels.value = true;
    fetchError.value = '';
    const result = await providerApi.fetchModels(baseUrlToUse, formValue.value.apiKey);

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
  // 在提交前调用此方法以更新 protocolMappings
  syncProtocolMappings: () => {
    if (multiProtocolEnabled.value) {
      updateProtocolMappings();
    }
  },
});
</script>

<template>
  <div class="provider-form-container">
    <div v-if="!editingId" class="preset-section">
      <div class="preset-header" @click="showPresetSelector = !showPresetSelector">
        <span class="section-label" style="margin-bottom: 0">选择提供商模板</span>
        <span v-if="!showPresetSelector" class="preset-summary">{{ presetSummary }}</span>
        <n-icon :component="showPresetSelector ? ChevronDown : ChevronRight" />
      </div>

      <n-collapse-transition :show="showPresetSelector">
        <div class="preset-grid">
          <div
            class="preset-card custom-card"
            :class="{ active: !activePresetId }"
            @click="selectPreset(null)"
          >
            <div class="preset-name">Custom / 自定义</div>
            <div class="preset-desc">连接自定义协议服务</div>
          </div>
          <div
            v-for="preset in PROVIDER_PRESETS"
            :key="preset.id"
            class="preset-card"
            :class="{ active: activePresetId === preset.id }"
            @click="selectPreset(preset)"
          >
            <div class="preset-name">{{ preset.name }}</div>
            <div class="preset-tag">{{ preset.category }}</div>
          </div>
        </div>
      </n-collapse-transition>
    </div>

    <n-divider v-if="!editingId" style="margin: 16px 0 24px 0" />

    <n-form
      ref="formRef"
      :model="formValue"
      :rules="rules"
      label-placement="left"
      label-width="120"
      size="small"
      class="main-form"
    >
      <div class="form-section">
        <div 
          class="section-header" 
          @click="showAdvanced = !showAdvanced" 
          :class="{ 'is-collapsed': !showAdvanced && activePresetId }"
        >
          <span class="section-title">基础配置</span>
          <n-icon v-if="activePresetId" :component="showAdvanced ? ChevronDown : ChevronRight" />
          <span v-if="activePresetId && !showAdvanced" class="summary-text">
            {{ formValue.name }} ({{ formValue.baseUrl }})
          </span>
        </div>

        <n-collapse-transition :show="showAdvanced || !activePresetId">
          <div class="section-content">
            <n-form-item label="显示名称" path="name">
              <n-input 
                v-model:value="formValue.name" 
                placeholder="如: My LLM Service" 
                size="small"
                @input="handleNameInput" 
              />
            </n-form-item>

            <n-form-item label="提供商 ID" path="id">
              <n-space vertical style="width: 100%" :size="4">
                <n-auto-complete
                  v-model:value="formValue.id"
                  :disabled="!!editingId"
                  :options="idSuggestions"
                  placeholder="唯一标识符，如: my-llm"
                  size="small"
                  :status="getFieldStatus(idValidation.isValid, formValue.id)"
                  @update:value="handleIdInput"
                  @blur="validateId"
                >
                  <template #suffix>
                    <n-icon
                      v-if="formValue.id && idValidation.isValid"
                      :component="CheckmarkCircle"
                      class="field-icon field-icon--success"
                    />
                    <n-icon
                      v-else-if="formValue.id && !idValidation.isValid"
                      :component="CloseCircle"
                      class="field-icon field-icon--error"
                    />
                  </template>
                </n-auto-complete>
                <div
                  v-if="idValidation.message"
                  class="field-feedback"
                  :class="idValidation.isValid ? 'field-feedback--success' : 'field-feedback--error'"
                >
                  {{ idValidation.message }}
                </div>
              </n-space>
            </n-form-item>
            
            <n-form-item label="描述">
              <n-input 
                v-model:value="formValue.description" 
                placeholder="备注信息（可选）" 
                size="small" 
                type="textarea" 
                :autosize="{ minRows: 1, maxRows: 3 }" 
              />
            </n-form-item>

            <n-form-item label="多协议支持">
              <n-switch v-model:value="multiProtocolEnabled" size="small" />
            </n-form-item>

            <n-form-item v-if="!multiProtocolEnabled" label="Base URL" path="baseUrl">
              <n-space vertical style="width: 100%" :size="4">
                <n-input
                  v-model:value="formValue.baseUrl"
                  placeholder="https://api.example.com/v1"
                  size="small"
                  :status="getFieldStatus(urlValidation.isValid, formValue.baseUrl)"
                  @blur="validateUrl"
                >
                  <template #suffix>
                    <n-icon
                      v-if="formValue.baseUrl && urlValidation.isValid"
                      :component="CheckmarkCircle"
                      class="field-icon field-icon--success"
                    />
                    <n-icon
                      v-else-if="formValue.baseUrl && !urlValidation.isValid"
                      :component="CloseCircle"
                      class="field-icon field-icon--error"
                    />
                  </template>
                </n-input>
                <div
                  v-if="urlValidation.message"
                  class="field-feedback"
                  :class="urlValidation.isValid ? 'field-feedback--success' : 'field-feedback--error'"
                >
                  {{ urlValidation.message }}
                </div>
              </n-space>
            </n-form-item>

            <template v-if="multiProtocolEnabled">
              <n-form-item label="OpenAI URL">
                <n-input
                  v-model:value="protocolUrls.openai"
                  placeholder="https://api.openai.com/v1"
                  size="small"
                />
              </n-form-item>

              <n-form-item label="Anthropic URL">
                <n-input
                  v-model:value="protocolUrls.anthropic"
                  placeholder="https://api.anthropic.com/claude"
                  size="small"
                />
              </n-form-item>

              <n-form-item label="Google URL">
                <n-input
                  v-model:value="protocolUrls.google"
                  placeholder="https://api.generativelanguage.googleapis.com/gemini"
                  size="small"
                />
              </n-form-item>
            </template>
          </div>
        </n-collapse-transition>
      </div>

      <div class="form-section highlight-section">
        <div class="section-header">认证与连接</div>
        <div class="section-content">
          <n-form-item label="API Key" path="apiKey">
            <n-space vertical style="width: 100%" :size="4">
              <n-input-group>
                <n-input
                  v-model:value="formValue.apiKey"
                  type="password"
                  show-password-on="click"
                  :placeholder="editingId ? '留空保持不变' : 'sk-...'"
                  size="small"
                  :status="getFieldStatus(keyValidation.isValid, formValue.apiKey)"
                  @blur="validateKey"
                  style="flex: 1"
                >
                  <template #suffix>
                    <n-icon
                      v-if="formValue.apiKey && keyValidation.isValid"
                      :component="CheckmarkCircle"
                      class="field-icon field-icon--success"
                    />
                    <n-icon
                      v-else-if="formValue.apiKey && !keyValidation.isValid"
                      :component="CloseCircle"
                      class="field-icon field-icon--error"
                    />
                  </template>
                </n-input>
                <n-tooltip trigger="hover">
                  <template #trigger>
                    <n-button size="small" @click="pasteApiKey">
                      <template #icon><n-icon :component="ClipboardOutline" /></template>
                    </n-button>
                  </template>
                  粘贴
                </n-tooltip>
              </n-input-group>
              
              <div
                v-if="editingId && !formValue.apiKey"
                class="field-hint"
              >
                <n-icon :component="InformationCircle" class="field-hint__icon" />
                <span>当前已配置密钥，如需更新请输入新密钥</span>
              </div>
              
              <div
                v-else-if="keyValidation.message"
                class="field-feedback"
                :class="keyValidation.isValid ? 'field-feedback--success' : 'field-feedback--error'"
              >
                {{ keyValidation.message }}
              </div>
              
              <div class="connection-actions">
                 <n-button
                  type="primary"
                  secondary
                  @click="handleFetchModels"
                  :loading="fetchingModels"
                  :disabled="!formValue.baseUrl || (!formValue.apiKey && !editingId)"
                  size="small"
                  block
                >
                  <template #icon>
                    <n-icon :component="LinkOutline" />
                  </template>
                  {{ fetchingModels ? '连接中...' : '测试连接并获取模型' }}
                </n-button>
              </div>

              <n-collapse-transition :show="Boolean(fetchError)">
                <div class="field-feedback field-feedback--warning">
                  <div class="field-feedback__title">{{ fetchError }}</div>
                  <div class="field-feedback__desc">连接失败或该提供商不支持标准模型列表接口。</div>
                </div>
              </n-collapse-transition>
            </n-space>
          </n-form-item>

          <n-collapse-transition :show="availableModels.length > 0">
            <n-form-item label="选择模型">
              <n-space vertical style="width: 100%" :size="6">
                <n-select
                  v-model:value="selectedModels"
                  :options="modelOptions"
                  multiple
                  filterable
                  placeholder="选择要启用的模型"
                  max-tag-count="responsive"
                  size="small"
                />
                <n-text depth="3" style="font-size: 11px">
                  已发现 {{ availableModels.length }} 个模型，选中 {{ selectedModels.length }} 个
                </n-text>
              </n-space>
            </n-form-item>
          </n-collapse-transition>
        </div>
      </div>

      <div class="form-section">
        <n-form-item label="立即启用" :show-feedback="false" style="margin-bottom: 0;">
          <n-switch v-model:value="formValue.enabled" size="small" />
        </n-form-item>
      </div>

    </n-form>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import {
  NForm,
  NFormItem,
  NInput,
  NSwitch,
  NSpace,
  NAutoComplete,
  NButton,
  NSelect,
  NText,
  useMessage,
  NIcon,
  NInputGroup,
  NTooltip,
  NDivider,
  NCollapseTransition,
} from 'naive-ui';
import { 
  ClipboardOutline, 
  LinkOutline,
  ChevronForward as ChevronRight,
  ChevronDown,
  CheckmarkCircle,
  CloseCircle,
  InformationCircle,
} from '@vicons/ionicons5';
import {
  validateProviderId,
  validateBaseUrl,
  validateApiKey,
  getProviderIdSuggestions
} from '@/utils/provider-validation';
import { providerApi, type ModelInfo } from '@/api/provider';
import type { ProtocolMapping } from '@/types';
import { PROVIDER_PRESETS, type ProviderPreset } from '@/constants/providers';

interface Props {
  modelValue: {
    id: string;
    name: string;
    description?: string | null;
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
const activePresetId = ref<string | null>(null);
const showAdvanced = ref(true)
const showPresetSelector = ref(false)

const presetSummary = computed(() => {
  if (activePresetId.value) {
    const preset = PROVIDER_PRESETS.find(p => p.id === activePresetId.value)
    return preset?.name ?? activePresetId.value
  }
  return 'Custom / 自定义'
})

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


if (props.modelValue.protocolMappings) {
  multiProtocolEnabled.value = true;
  protocolUrls.value = { ...props.modelValue.protocolMappings };
}

watch(() => props.modelValue.protocolMappings, (newMappings) => {
  if (newMappings) {
    const hasChanged = !protocolUrls.value.openai && !protocolUrls.value.anthropic && !protocolUrls.value.google;
    if (hasChanged || JSON.stringify(protocolUrls.value) !== JSON.stringify(newMappings)) {
      multiProtocolEnabled.value = true;
      protocolUrls.value = { ...newMappings };
    }
  } else if (multiProtocolEnabled.value) {
    multiProtocolEnabled.value = false;
    protocolUrls.value = { openai: '', anthropic: '', google: '' };
  }
}, { immediate: false });

const formValue = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
});

watch(multiProtocolEnabled, (enabled) => {
  if (enabled) {
    const allProtocolsEmpty = !protocolUrls.value.openai && !protocolUrls.value.anthropic && !protocolUrls.value.google;
    if (allProtocolsEmpty && formValue.value.baseUrl) {
      protocolUrls.value.openai = formValue.value.baseUrl;
    }
    updateProtocolMappings();
  } else {
    if (protocolUrls.value.openai) {
      formValue.value.baseUrl = protocolUrls.value.openai;
    }
    formValue.value.protocolMappings = null;
    protocolUrls.value = { openai: '', anthropic: '', google: '' };
  }
});

function updateProtocolMappings() {
  const mappings: ProtocolMapping = {};
  if (protocolUrls.value.openai) mappings.openai = protocolUrls.value.openai;
  if (protocolUrls.value.anthropic) mappings.anthropic = protocolUrls.value.anthropic;
  if (protocolUrls.value.google) mappings.google = protocolUrls.value.google;

  const newMappings = Object.keys(mappings).length > 0 ? mappings : null;
  const newBaseUrl = newMappings ? (mappings.openai || mappings.anthropic || mappings.google || '') : '';

  formValue.value.protocolMappings = newMappings;
  formValue.value.baseUrl = newBaseUrl;
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
        if (!value) return true;
        return validateProviderId(value).isValid;
      },
      message: '格式：字母、数字、连字符',
      trigger: 'blur',
    },
  ],
  name: [{ required: true, message: '请输入显示名称', trigger: 'blur' }],
  baseUrl: [
    {
      validator: (_rule: any, value: string) => {
        if (multiProtocolEnabled.value) return true;
        return !value || validateBaseUrl(value).isValid;
      },
      message: '请输入有效的 Base URL',
      trigger: 'blur',
    },
  ],
  apiKey: [
    {
      validator: (_rule: any, value: string) => {
        if (!value) {
          return props.editingId ? true : false
        }
        const validation = validateApiKey(value, formValue.value.id)
        return validation.isValid
      },
      message: '请输入 API Key',
      trigger: 'blur',
    },
  ],
};

function selectPreset(preset: ProviderPreset | null) {
  if (preset) {
    activePresetId.value = preset.id;
    formValue.value.id = preset.id;
    formValue.value.name = preset.name;
    formValue.value.baseUrl = preset.baseUrl;
    formValue.value.description = preset.description;
    showAdvanced.value = false;
    idValidation.value = { isValid: true };
    urlValidation.value = { isValid: true };
  } else {
    activePresetId.value = null;
    formValue.value.id = '';
    formValue.value.name = '';
    formValue.value.baseUrl = '';
    formValue.value.description = '';
    showAdvanced.value = true;

    // Avoid an overly tall modal: once user chooses custom provider,
    // auto-collapse the preset selector section.
    if (!props.editingId) {
      showPresetSelector.value = false
    }
  }
  formValue.value.apiKey = '';
  availableModels.value = [];
  selectedModels.value = [];
  fetchError.value = '';
}

function handleNameInput(value: string) {
  if (!activePresetId.value && !props.editingId) {
    const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!formValue.value.id) {
      formValue.value.id = slug;
    }
  }
}

async function pasteApiKey() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      formValue.value.apiKey = text;
      validateKey();
      message.success('已粘贴');
    }
  } catch (err) {
    message.error('无法读取剪贴板');
  }
}

function handleIdInput(value: string) {
  formValue.value.id = value;
  if (value) validateId();
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

function getFieldStatus(isValid: boolean | undefined, hasValue: string): 'success' | 'error' | undefined {
  if (!hasValue) return undefined;
  return isValid ? 'success' : 'error';
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
  if (formValue.value.apiKey) validateKey();
});

defineExpose({
  validate: () => formRef.value?.validate(),
  getSelectedModels: () => selectedModels.value,
  getSelectedModelsInfo: () => {
    return availableModels.value.filter(model =>
      selectedModels.value.includes(model.id)
    );
  },
  syncProtocolMappings: () => {
    if (multiProtocolEnabled.value) {
      updateProtocolMappings();
    }
  },
});
</script>

<style scoped>
.provider-form-container {
  padding: 0 4px;
}

/* Preset Grid Styles */
.preset-section {
  margin-bottom: 20px;
}

.preset-header {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}

.preset-summary {
  flex: 1;
  min-width: 0;
  text-align: right;
  font-size: 11px;
  color: #888;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.section-label {
  font-size: 12px;
  font-weight: 600;
  color: #666;
  margin-bottom: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.preset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
}

.preset-card {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 10px 12px;
  cursor: pointer;
  transition: all 0.2s ease;
  background: #fff;
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 60px;
}

.preset-card:hover {
  border-color: #18a058;
  background: #f7fbf9;
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.05);
}

.preset-card.active {
  border-color: #18a058;
  background: #eaf7f1;
  box-shadow: 0 0 0 1px #18a058 inset;
}

.custom-card {
  grid-column: span 2;
  background: #f9f9f9;
  border-style: dashed;
}

.custom-card.active {
  border-style: solid;
}

.preset-name {
  font-weight: 600;
  font-size: 13px;
  color: #333;
  margin-bottom: 4px;
}

.preset-tag {
  font-size: 10px;
  color: #888;
  background: #f0f0f0;
  padding: 1px 6px;
  border-radius: 4px;
  align-self: flex-start;
}

.preset-desc {
  font-size: 11px;
  color: #666;
}

/* Form Section Styles */
.form-section {
  margin-bottom: 16px;
  border-radius: 8px;
  border: 1px solid #eee;
  overflow: hidden;
}

.form-section.highlight-section {
  border-color: #d1e7dd;
  background: #fcfdfd;
}

.section-header {
  padding: 10px 16px;
  background: #f9f9f9;
  font-weight: 600;
  font-size: 13px;
  color: #444;
  display: flex;
  align-items: center;
  cursor: pointer;
  user-select: none;
  border-bottom: 1px solid transparent;
}

.section-header:hover {
  background: #f0f0f0;
}

.section-header.is-collapsed {
  border-bottom: none;
}

.section-content {
  padding: 16px;
  border-top: 1px solid #eee;
}

.n-collapse-transition-enter-from .section-content,
.n-collapse-transition-leave-to .section-content {
  border-top-color: transparent;
}

.summary-text {
  margin-left: 8px;
  font-weight: 400;
  color: #888;
  font-size: 12px;
}

/* Connection Actions */
.connection-actions {
  margin: 8px 0;
}

.mini-alert {
  padding: 8px 12px;
  font-size: 12px;
}

/* Field-level feedback styles */
.field-icon {
  font-size: 16px;
  margin-right: 4px;
}

.field-icon--success {
  color: #18a058;
}

.field-icon--error {
  color: #d03050;
}

.field-feedback {
  font-size: 12px;
  line-height: 1.4;
  padding: 4px 0;
}

.field-feedback--success {
  color: #18a058;
}

.field-feedback--error {
  color: #d03050;
}

.field-feedback--warning {
  color: #f0a020;
  background: #fff9e8;
  padding: 8px 12px;
  border-radius: 4px;
  border: 1px solid rgba(240, 160, 32, 0.35);
}

.field-feedback__title {
  font-weight: 500;
  margin-bottom: 2px;
}

.field-feedback__desc {
  font-size: 11px;
  opacity: 0.9;
}

.field-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #666;
  padding: 4px 0;
}

.field-hint__icon {
  font-size: 14px;
  color: #2080f0;
  flex-shrink: 0;
}
</style>

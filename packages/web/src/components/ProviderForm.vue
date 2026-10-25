<template>
  <div class="provider-form-container">
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
        <div class="section-header">
          <span class="section-title">{{ t('providers.form.basic') }}</span>
        </div>

        <div class="section-content">
            <n-form-item :label="t('providers.form.displayName')" path="name">
              <n-input 
                v-model:value="formValue.name" 
                :placeholder="t('providers.form.displayNamePlaceholder')" 
                size="small"
              />
            </n-form-item>

            <n-form-item :label="t('providers.form.providerId')" path="id">
              <n-space vertical style="width: 100%" :size="4">
                <n-input
                  v-model:value="formValue.id"
                  :disabled="!!editingId"
                  :placeholder="t('providers.form.providerIdPlaceholder')"
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
                </n-input>
                <div
                  v-if="idValidation.message"
                  class="field-feedback"
                  :class="idValidation.isValid ? 'field-feedback--success' : 'field-feedback--error'"
                >
                  {{ idValidation.message }}
                </div>
              </n-space>
            </n-form-item>
            
            <n-form-item :label="t('common.description')">
              <n-input 
                v-model:value="formValue.description" 
                :placeholder="t('providers.form.descriptionPlaceholder')" 
                size="small" 
                type="textarea" 
                :autosize="{ minRows: 1, maxRows: 3 }" 
              />
            </n-form-item>

            <n-form-item :label="t('providers.form.multiProtocol')">
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
                  placeholder="https://api.anthropic.com"
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
      </div>

      <div class="form-section highlight-section">
        <div class="section-header">{{ t('providers.apiKey') }}</div>
        <div class="section-content">
          <n-form-item label="API Key" path="apiKey">
            <n-space vertical style="width: 100%" :size="4">
              <n-input-group>
                <n-input
                  v-model:value="formValue.apiKey"
                  type="password"
                  show-password-on="click"
                  :placeholder="editingId ? t('providers.form.apiKeyKeep') : 'sk-...'"
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
                  {{ t('providers.form.paste') }}
                </n-tooltip>
              </n-input-group>
              
              <div
                v-if="editingId && !formValue.apiKey"
                class="field-hint"
              >
                <n-icon :component="InformationCircle" class="field-hint__icon" />
                <span>{{ t('providers.form.keyConfiguredHint') }}</span>
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
                  {{ fetchingModels ? t('providers.form.connecting') : t('providers.form.fetchModels') }}
                </n-button>
              </div>

              <n-collapse-transition :show="Boolean(fetchError)">
                <div class="field-feedback field-feedback--warning">
                  <div class="field-feedback__title">{{ fetchError }}</div>
                  <div class="field-feedback__desc">{{ t('providers.form.fetchModelsFailedHint') }}</div>
                </div>
              </n-collapse-transition>
            </n-space>
          </n-form-item>

          <n-collapse-transition :show="availableModels.length > 0">
            <n-form-item :label="t('providers.form.selectModels')">
              <n-space vertical style="width: 100%" :size="6">
                <n-select
                  v-model:value="selectedModels"
                  :options="modelOptions"
                  multiple
                  filterable
                  :placeholder="t('providers.form.selectModelsPlaceholder')"
                  max-tag-count="responsive"
                  size="small"
                />
                <n-text depth="3" style="font-size: 11px">
                  {{ t('providers.form.modelSummary', { found: availableModels.length, added: addedModelCount, selected: selectedModels.length }) }}
                </n-text>
              </n-space>
            </n-form-item>
          </n-collapse-transition>
        </div>
      </div>

      <div class="form-section">
        <n-form-item :label="t('providers.form.enableNow')" :show-feedback="false" style="margin-bottom: 0;">
          <n-switch v-model:value="formValue.enabled" size="small" />
        </n-form-item>
      </div>

    </n-form>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NForm,
  NFormItem,
  NInput,
  NSwitch,
  NSpace,
  NButton,
  NSelect,
  NText,
  useMessage,
  NIcon,
  NInputGroup,
  NTooltip,
  NCollapseTransition,
} from 'naive-ui';
import { 
  ClipboardOutline, 
  LinkOutline,
  CheckmarkCircle,
  CloseCircle,
  InformationCircle,
} from '@vicons/ionicons5';
import {
  validateProviderId,
  validateBaseUrl,
  validateApiKey
} from '@/utils/provider-validation';
import { providerApi, type ModelInfo } from '@/api/provider';
import type { ProtocolMapping } from '@/types';

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
  existingModelIdentifiers?: string[];
}

const props = defineProps<Props>();
const emit = defineEmits<{
  'update:modelValue': [value: Props['modelValue']];
}>();

const message = useMessage();
const { t } = useI18n();
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

const modelOptions = computed(() => {
  return availableModels.value.map(model => ({
    label: model.name,
    value: model.id,
  }));
});

const addedModelCount = computed(() => {
  const existingModelIdentifiers = new Set(props.existingModelIdentifiers ?? []);
  return availableModels.value.filter(model => existingModelIdentifiers.has(model.id)).length;
});

const rules = computed(() => ({
  id: [
    { required: true, message: t('providers.form.idRule'), trigger: 'blur' },
    {
      validator: (_rule: any, value: string) => {
        if (!value) return true;
        return validateProviderId(value).isValid;
      },
      message: t('providers.form.idFormat'),
      trigger: 'blur',
    },
  ],
  name: [{ required: true, message: t('providers.form.nameRequired'), trigger: 'blur' }],
  baseUrl: [
    {
      validator: (_rule: any, value: string) => {
        if (multiProtocolEnabled.value) return true;
        return !value || validateBaseUrl(value).isValid;
      },
      message: t('providers.form.baseUrlInvalid'),
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
      message: t('providers.form.apiKeyRequired'),
      trigger: 'blur',
    },
  ],
}));

async function pasteApiKey() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      formValue.value.apiKey = text;
      validateKey();
      message.success(t('providers.form.pasted'));
    }
  } catch (err) {
    message.error(t('providers.form.clipboardDenied'));
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
    message.warning(t('providers.form.needUrlAndKey'));
    return;
  }

  try {
    fetchingModels.value = true;
    fetchError.value = '';
    const result = await providerApi.fetchModels(baseUrlToUse, formValue.value.apiKey);

    if (result.success) {
      availableModels.value = result.models;
      const existingModelIdentifiers = new Set(props.existingModelIdentifiers ?? []);
      selectedModels.value = result.models
        .filter(model => existingModelIdentifiers.has(model.id))
        .map(model => model.id);
      fetchError.value = '';
      message.success(result.message);
    } else {
      availableModels.value = [];
      fetchError.value = result.message;
    }
  } catch (error: any) {
    availableModels.value = [];
    fetchError.value = error.message || t('providers.form.fetchModelsFailed');
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
  border-bottom: 1px solid transparent;
}

.section-content {
  padding: 16px;
  border-top: 1px solid #eee;
}

.connection-actions {
  margin: 8px 0;
}

.mini-alert {
  padding: 8px 12px;
  font-size: 12px;
}

.field-icon {
  font-size: 16px;
  margin-right: 4px;
}

.field-icon--success {
  color: var(--color-primary);
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
  color: var(--color-primary);
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

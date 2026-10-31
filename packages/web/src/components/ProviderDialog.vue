<template>
  <n-modal
    :show="show"
    preset="card"
    class="provider-dialog"
    :auto-focus="false"
    :closable="false"
    :mask-closable="!submitting"
    :style="{ width: '860px', maxWidth: '94vw' }"
    :segmented="{ content: true, footer: true }"
    @update:show="handleShowChange"
  >
    <template #header>
      <div class="dialog-header">
        <h2 class="dialog-title">{{ isEdit ? t('providers.editProvider') : t('providers.addProvider') }}</h2>
        <p class="dialog-subtitle">{{ isEdit ? form.id : t('providers.form.dialogSubtitle') }}</p>
      </div>
    </template>
    <template #header-extra>
      <n-button
        quaternary
        circle
        size="small"
        :aria-label="t('common.cancel')"
        :disabled="submitting"
        @click="handleShowChange(false)"
      >
        <template #icon><n-icon :component="CloseOutline" /></template>
      </n-button>
    </template>

    <div class="dialog-body">
      <n-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-placement="top"
        size="medium"
        class="dialog-form"
        @submit.prevent
      >
        <section class="dialog-section">
          <header class="section-head">
            <h3>{{ t('providers.form.basic') }}</h3>
            <p>{{ t('providers.form.basicHint') }}</p>
          </header>

          <div class="field-row">
            <n-form-item :label="t('providers.form.displayName')" path="name" class="field">
              <n-input v-model:value="form.name" :placeholder="t('providers.form.displayNamePlaceholder')" />
            </n-form-item>

            <n-form-item :label="t('providers.form.providerId')" path="id" class="field">
              <n-input
                v-model:value="form.id"
                :disabled="isEdit"
                :placeholder="t('providers.form.providerIdPlaceholder')"
                :status="idStatus"
              >
                <template #suffix>
                  <n-icon v-if="idOk" :component="CheckmarkCircle" class="field-ok" />
                </template>
              </n-input>
            </n-form-item>
          </div>

          <n-form-item :label="t('common.description')" path="description">
            <n-input
              v-model:value="form.description"
              type="textarea"
              :autosize="{ minRows: 1, maxRows: 3 }"
              :placeholder="t('providers.form.descriptionPlaceholder')"
            />
          </n-form-item>

          <p v-if="isEdit" class="field-note">{{ t('providers.form.idLockedHint') }}</p>
        </section>

        <section class="dialog-section">
          <header class="section-head section-head--aside">
            <div>
              <h3>{{ t('providers.form.sectionConnection') }}</h3>
              <p>{{ t('providers.form.connectionHint') }}</p>
            </div>
            <n-radio-group v-model:value="form.protocolMode" size="small" name="provider-protocol-mode">
              <n-radio-button value="single">{{ t('providers.form.protocolSingle') }}</n-radio-button>
              <n-radio-button value="multi">{{ t('providers.form.protocolMulti') }}</n-radio-button>
            </n-radio-group>
          </header>

          <n-form-item v-if="form.protocolMode === 'single'" label="Base URL" path="baseUrl" class="connection-url">
            <n-input v-model:value="form.baseUrl" placeholder="https://api.example.com/v1" :status="baseUrlStatus">
              <template #suffix>
                <n-icon v-if="baseUrlOk" :component="CheckmarkCircle" class="field-ok" />
              </template>
            </n-input>
          </n-form-item>

          <n-form-item v-else :label="t('providers.form.protocolUrls')" path="protocolUrls" class="connection-url">
            <div class="protocol-grid">
              <div v-for="protocol in PROTOCOLS" :key="protocol.key" class="protocol-field">
                <span class="protocol-name">{{ protocol.label }}</span>
                <n-input
                  v-model:value="form.protocolUrls[protocol.key]"
                  :placeholder="protocol.placeholder"
                  size="small"
                  :status="protocolStatus(protocol.key)"
                  @blur="touchProtocol(protocol.key)"
                />
              </div>
              <p class="field-note">{{ t('providers.form.protocolMultiHint') }}</p>
            </div>
          </n-form-item>

          <n-form-item label="API Key" path="apiKey">
            <n-input-group>
              <n-input
                v-model:value="form.apiKey"
                :disabled="loadingKey"
                type="password"
                show-password-on="click"
                :placeholder="isEdit ? t('providers.form.apiKeyKeep') : 'sk-...'"
                :status="apiKeyStatus"
              >
                <template #suffix>
                  <n-icon v-if="apiKeyOk" :component="CheckmarkCircle" class="field-ok" />
                </template>
              </n-input>
              <n-button :aria-label="t('providers.form.paste')" :disabled="loadingKey" @click="pasteApiKey">
                <template #icon><n-icon :component="ClipboardOutline" /></template>
              </n-button>
            </n-input-group>
          </n-form-item>
          <p v-if="keyNote" class="field-note">{{ keyNote }}</p>
        </section>

        <section class="dialog-section">
          <header class="section-head section-head--aside">
            <div>
              <h3>{{ t('providers.form.selectModels') }}</h3>
              <p>{{ t('providers.form.modelsDescription') }}</p>
            </div>
            <Transition name="model-action" mode="out-in">
            <span v-if="fetchedOnce && discovered.length" key="choose" class="model-action">
            <n-popover trigger="click" placement="bottom-end" :style="{ width: 'min(520px, 90vw)' }">
              <template #trigger>
                <n-button size="tiny" type="primary" secondary>{{ t('providers.form.chooseModels') }}</n-button>
              </template>
            <div class="model-picker">
            <div class="model-toolbar">
              <n-button text type="primary" size="small" :loading="fetching" :disabled="!canFetchModels" @click="fetchModels">
                {{ t('providers.form.refreshModels') }}
              </n-button>
              <n-input
                v-model:value="modelSearch"
                size="small"
                clearable
                :placeholder="t('providers.form.searchModels')"
                :aria-label="t('providers.form.searchModels')"
                class="model-search"
              >
                <template #prefix><n-icon :component="SearchOutline" /></template>
              </n-input>
              <n-button text type="primary" size="small" @click="toggleVisibleModels">
                {{ allVisibleSelected ? t('providers.form.clearVisible') : t('providers.form.selectVisible') }}
              </n-button>
            </div>

            <div class="model-list" role="group" :aria-label="t('providers.form.selectModels')">
              <div
                v-for="model in filteredModels"
                :key="model.id"
                class="model-row"
                :class="{ 'model-row--existing': isExistingModel(model.id), 'model-row--on': isSelectedModel(model.id) }"
                @click="toggleModel(model.id)"
              >
                <n-checkbox
                  :checked="isSelectedModel(model.id)"
                  :disabled="isExistingModel(model.id)"
                  :aria-label="model.name || model.id"
                  @update:checked="toggleModel(model.id)"
                  @click.stop
                />
                <span class="model-text">
                  <span class="model-name">{{ model.name || model.id }}</span>
                  <code v-if="model.name && model.name !== model.id" class="model-id">{{ model.id }}</code>
                </span>
                <span v-if="isExistingModel(model.id)" class="model-badge">
                  {{ t('providers.form.modelAlreadyAdded') }}
                </span>
              </div>
              <p v-if="!filteredModels.length" class="model-empty">{{ t('providers.form.noMatchingModels') }}</p>
            </div>

            </div>
            </n-popover>
            </span>
            <span v-else key="fetch" class="model-action">
            <n-button
              size="tiny"
              type="primary"
              secondary
              :loading="fetching"
              :disabled="!canFetchModels"
              @click="fetchModels"
            >
              <template #icon><n-icon :component="CloudDownloadOutline" /></template>
              {{ fetchedOnce ? t('providers.form.refreshModels') : t('providers.form.fetchModels') }}
            </n-button>
            </span>
            </Transition>
          </header>

          <div class="model-state">
          <p v-if="!canFetchModels && !fetching && !loadingKey && !(isEdit && !form.apiKey.trim())" class="field-note">{{ fetchBlockedNote }}</p>
          <div v-if="fetching" class="model-loading">
            <n-skeleton height="34px" :sharp="false" />
          </div>

          <div v-else-if="fetchError" class="model-error" role="alert">
            <n-icon :component="AlertCircleOutline" class="model-error__icon" />
            <div>
              <p class="model-error__title">{{ fetchError }}</p>
              <p class="model-error__desc">{{ t('providers.form.fetchModelsFailedHint') }}</p>
            </div>
          </div>

          <div v-else-if="!fetchedOnce" class="model-idle">
            <n-icon :component="CubeOutline" />
            <span>{{ t('providers.form.modelsIdleHint') }}</span>
          </div>

          <div v-else-if="!discovered.length" class="model-idle">
            <n-icon :component="CubeOutline" />
            <span>{{ t('providers.form.noAvailableModels') }}</span>
          </div>

          <div v-else class="model-picker-summary">
            <p class="model-summary">
              {{ t('providers.form.modelSummary', {
                found: discovered.length,
                added: existingCount,
                selected: toAddCount,
              }) }}
            </p>
          </div>
          </div>
        </section>

        <section class="dialog-section dialog-section--switch">
          <div>
            <h3>{{ t('providers.form.enableNow') }}</h3>
            <p>{{ t('providers.form.enableHint') }}</p>
          </div>
          <n-switch v-model:value="form.enabled" size="medium" />
        </section>
      </n-form>
    </div>

    <template #footer>
      <div class="dialog-footer">
        <p class="footer-summary" aria-live="polite">{{ footerSummary }}</p>
        <div class="footer-actions">
          <n-button :disabled="submitting" @click="handleShowChange(false)">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :loading="submitting" :disabled="loadingKey" @click="submit">
            {{ isEdit ? t('common.update') : t('common.create') }}
          </n-button>
        </div>
      </div>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NButton,
  NCheckbox,
  NForm,
  NFormItem,
  NIcon,
  NInputGroup,
  NInput,
  NModal,
  NPopover,
  NRadioButton,
  NRadioGroup,
  NSkeleton,
  NSwitch,
  useDialog,
  useMessage,
} from 'naive-ui'
import {
  AlertCircleOutline,
  CheckmarkCircle,
  ClipboardOutline,
  CloseOutline,
  CloudDownloadOutline,
  CubeOutline,
  SearchOutline,
} from '@vicons/ionicons5'
import { modelApi } from '@/api/model'
import { extractModelAttributes, providerApi, type ModelInfo } from '@/api/provider'
import { useModelStore } from '@/stores/model'
import type { Provider, UpdateProviderRequest } from '@/types'
import {
  validateApiKey,
  validateBaseUrl,
  validateProviderId,
} from '@/utils/provider-validation'
import {
  PROTOCOL_KEYS,
  modelsToCreate,
  resolveApiKeyPayload,
  resolveConnection,
  splitProtocolMappings,
  type ConnectionResult,
  type EmptyProtocolUrls,
  type ProtocolKey,
  type ProtocolMode,
} from '@/utils/provider-dialog'

const props = defineProps<{
  show: boolean
  provider: Provider | null
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  saved: []
}>()

const { t } = useI18n()
const message = useMessage()
const dialogApi = useDialog()
const modelStore = useModelStore()

const PROTOCOLS: Array<{ key: ProtocolKey; label: string; placeholder: string }> = [
  { key: 'openai', label: 'OpenAI', placeholder: 'https://api.openai.com/v1' },
  { key: 'anthropic', label: 'Anthropic', placeholder: 'https://api.anthropic.com' },
  { key: 'google', label: 'Google', placeholder: 'https://generativelanguage.googleapis.com/v1' },
]

const formRef = ref()
const submitting = ref(false)
const loadingKey = ref(false)
const originalApiKey = ref('')
let keyLoadVersion = 0
const fetching = ref(false)
const fetchError = ref('')
const fetchedOnce = ref(false)
const discovered = ref<ModelInfo[]>([])
const selectedModels = ref<string[]>([])
const modelSearch = ref('')
const touchedProtocols = ref<Set<ProtocolKey>>(new Set())
let fetchVersion = 0

const isEdit = computed(() => !!props.provider)

function createForm(protocolMode: ProtocolMode = 'single', urls?: EmptyProtocolUrls) {
  return reactive({
    id: '',
    name: '',
    description: '',
    baseUrl: '',
    apiKey: '',
    enabled: true,
    protocolMode,
    protocolUrls: urls || { openai: '', anthropic: '', google: '' },
  })
}

const form = ref(createForm())

watch(
  () => form.value.protocolMode,
  mode => {
    if (mode === 'multi') {
      if (PROTOCOL_KEYS.every(key => !form.value.protocolUrls[key].trim())) {
        form.value.protocolUrls.openai = form.value.baseUrl
      }
    } else {
      const url = PROTOCOL_KEYS.map(key => form.value.protocolUrls[key]).find(url => url.trim())
      if (url) form.value.baseUrl = url
    }
  },
  { flush: 'sync' }
)

watch(
  () => props.show,
  async visible => {
    const version = ++keyLoadVersion
    loadingKey.value = false
    originalApiKey.value = ''
    if (!visible) {
      form.value.apiKey = ''
      return
    }
    const provider = props.provider
    const protocols = splitProtocolMappings(provider?.protocolMappings)
    form.value = createForm(protocols.enabled ? 'multi' : 'single', protocols.urls)
    if (provider) {
      form.value.id = provider.id
      form.value.name = provider.name
      form.value.description = provider.description || ''
      form.value.baseUrl = provider.baseUrl
      form.value.enabled = provider.enabled
    }
    touchedProtocols.value = new Set()
    discovered.value = []
    selectedModels.value = []
    modelSearch.value = ''
    fetchError.value = ''
    fetchedOnce.value = false
    fetching.value = false
    fetchVersion++
    if (provider) {
      loadingKey.value = true
      try {
        const detail = await providerApi.getWithApiKey(provider.id)
        if (version !== keyLoadVersion) return
        originalApiKey.value = detail.apiKey
        form.value.apiKey = detail.apiKey
      } catch (error: any) {
        if (version === keyLoadVersion) message.error(error.message)
      } finally {
        if (version === keyLoadVersion) loadingKey.value = false
      }
    }
  }
)

const idOk = computed(() => !!form.value.id && validateProviderId(form.value.id).isValid)
const idStatus = computed(() => (form.value.id && !idOk.value ? 'error' : undefined))
const baseUrlOk = computed(() => !!form.value.baseUrl && validateBaseUrl(form.value.baseUrl).isValid)
const baseUrlStatus = computed(() => (form.value.baseUrl && !baseUrlOk.value ? 'error' : undefined))
const apiKeyOk = computed(() => !!form.value.apiKey && validateApiKey(form.value.apiKey, form.value.id).isValid)
const apiKeyStatus = computed(() => (form.value.apiKey && !apiKeyOk.value ? 'error' : undefined))

function protocolStatus(key: ProtocolKey) {
  const url = form.value.protocolUrls[key].trim()
  if (!url || !touchedProtocols.value.has(key)) return undefined
  return validateBaseUrl(url).isValid ? undefined : 'error'
}

function touchProtocol(key: ProtocolKey) {
  const next = new Set(touchedProtocols.value)
  next.add(key)
  touchedProtocols.value = next
}

const rules = computed(() => ({
  name: [
    {
      validator: (_rule: unknown, value: string) =>
        value?.trim() ? true : new Error(t('providers.form.nameRequired')),
      trigger: ['input', 'blur'],
    },
  ],
  id: [
    {
      validator: (_rule: unknown, value: string) => {
        if (!value?.trim()) return new Error(t('providers.form.idRule'))
        const result = validateProviderId(value)
        return result.isValid ? true : new Error(result.message)
      },
      trigger: ['input', 'blur'],
    },
  ],
  baseUrl: [
    {
      validator: (_rule: unknown, value: string) => {
        if (form.value.protocolMode === 'multi') return true
        if (!value?.trim()) return new Error(t('providers.baseUrlEmpty'))
        const result = validateBaseUrl(value)
        return result.isValid ? true : new Error(result.message)
      },
      trigger: ['input', 'blur'],
    },
  ],
  protocolUrls: [
    {
      validator: () => {
        if (form.value.protocolMode !== 'multi') return true
        const filled = PROTOCOL_KEYS.map(key => form.value.protocolUrls[key].trim()).filter(Boolean)
        if (!filled.length) return new Error(t('providers.form.protocolAtLeastOne'))
        for (const url of filled) {
          const result = validateBaseUrl(url)
          if (!result.isValid) return new Error(result.message)
        }
        return true
      },
      trigger: ['input', 'blur'],
    },
  ],
  apiKey: [
    {
      validator: (_rule: unknown, value: string) => {
        if (!value?.trim()) {
          return isEdit.value ? true : new Error(t('providers.form.apiKeyRequired'))
        }
        const result = validateApiKey(value, form.value.id)
        return result.isValid ? true : new Error(result.message)
      },
      trigger: ['input', 'blur'],
    },
  ],
}))

const existingIdentifiers = computed(() =>
  isEdit.value
    ? modelStore.models.filter(model => model.providerId === props.provider?.id).map(model => model.modelIdentifier)
    : []
)
const existingSet = computed(() => new Set(existingIdentifiers.value))
const existingCount = computed(() => discovered.value.filter(model => existingSet.value.has(model.id)).length)
const selectedSet = computed(() => new Set(selectedModels.value))
const toAddCount = computed(() => modelsToCreate(discovered.value, selectedSet.value, existingSet.value).length)

const filteredModels = computed(() => {
  const keyword = modelSearch.value.trim().toLowerCase()
  if (!keyword) return discovered.value
  return discovered.value.filter(model =>
    `${model.name || ''} ${model.id}`.toLowerCase().includes(keyword)
  )
})

const allVisibleSelected = computed(
  () =>
    filteredModels.value.length > 0 &&
    filteredModels.value.every(model => isSelectedModel(model.id) || isExistingModel(model.id))
)

const activeUrl = computed(() => {
  const connection = resolveConnection(form.value, url => validateBaseUrl(url).isValid)
  return connection.ok ? connection.baseUrl : ''
})

const canFetchModels = computed(() => !!activeUrl.value && !!form.value.apiKey.trim())

// A changed endpoint invalidates whatever list is on screen: importing models from a stale
// URL would silently attach the wrong models to this provider. The version bump also
// orphans the in-flight request, so its loading flag is cleared here too — the stale
// finally skips it and the fetch button ignores clicks while loading, so nothing but
// closing the dialog (and losing the typed form) could unstick the section.
watch(activeUrl, (url, previous) => {
  if (!previous || url === previous) return
  discovered.value = []
  selectedModels.value = []
  fetchedOnce.value = false
  fetchError.value = ''
  fetching.value = false
  fetchVersion++
})

const fetchBlockedNote = computed(() =>
  isEdit.value && !form.value.apiKey.trim()
    ? t('providers.form.fetchNeedsKey')
    : t('providers.form.needUrlAndKey')
)

const keyNote = computed(() =>
  // Edit mode has nothing to add: the key placeholder already says the stored key is kept.
  isEdit.value ? '' : t('providers.form.keyCreateHint')
)

const footerSummary = computed(() => {
  // Nothing selected is the default state, not a warning — say nothing instead of a label.
  const parts: string[] = []
  if (toAddCount.value) parts.push(t('providers.form.toAddCount', { count: toAddCount.value }))
  if (isEdit.value && form.value.apiKey.trim() && form.value.apiKey.trim() !== originalApiKey.value) parts.push(t('providers.form.keyWillReplace'))
  return parts.join(' · ')
})

function isSelectedModel(id: string) {
  return existingSet.value.has(id) || selectedSet.value.has(id)
}

function isExistingModel(id: string) {
  return existingSet.value.has(id)
}

function toggleModel(id: string) {
  if (isExistingModel(id)) return
  selectedModels.value = selectedSet.value.has(id)
    ? selectedModels.value.filter(model => model !== id)
    : [...selectedModels.value, id]
}

function toggleVisibleModels() {
  const toggleable = filteredModels.value.filter(model => !isExistingModel(model.id)).map(model => model.id)
  if (allVisibleSelected.value) {
    selectedModels.value = selectedModels.value.filter(id => !toggleable.includes(id))
  } else {
    selectedModels.value = Array.from(new Set([...selectedModels.value, ...toggleable]))
  }
}

function handleShowChange(value: boolean) {
  if (!value && submitting.value) return
  emit('update:show', value)
}

async function pasteApiKey() {
  try {
    const text = await navigator.clipboard.readText()
    if (!text) return
    form.value.apiKey = text.trim()
    message.success(t('providers.form.pasted'))
  } catch {
    message.error(t('providers.form.clipboardDenied'))
  }
}

function connectionMessage(result: Exclude<ConnectionResult, { ok: true }>) {
  if (result.issue === 'emptyProtocols') return t('providers.form.protocolAtLeastOne')
  if (result.issue === 'emptyBaseUrl') return t('providers.baseUrlEmpty')
  const validation = validateBaseUrl(
    result.field === 'baseUrl' ? form.value.baseUrl : form.value.protocolUrls[result.field]
  )
  return validation.message || t('providers.form.baseUrlInvalid')
}

async function fetchModels() {
  if (!canFetchModels.value) {
    message.warning(fetchBlockedNote.value)
    return
  }
  const version = ++fetchVersion
  fetching.value = true
  fetchError.value = ''
  try {
    const result = await providerApi.fetchModels(activeUrl.value, form.value.apiKey.trim())
    if (version !== fetchVersion) return
    if (result.success) {
      discovered.value = result.models
      const previouslySelected = new Set(selectedModels.value)
      selectedModels.value = result.models
        .filter(model => previouslySelected.has(model.id) && !existingSet.value.has(model.id))
        .map(model => model.id)
      fetchedOnce.value = true
      modelSearch.value = ''
    } else {
      fetchError.value = result.message
    }
  } catch (error: any) {
    if (version === fetchVersion) fetchError.value = error.message || t('providers.form.fetchModelsFailed')
  } finally {
    if (version === fetchVersion) fetching.value = false
  }
}

function confirmKeyReplacement() {
  return new Promise<boolean>(resolve => {
    dialogApi.warning({
      title: t('providers.apiKeyChangedTitle'),
      content: t('providers.apiKeyChangedContent'),
      positiveText: t('providers.confirmSave'),
      negativeText: t('common.cancel'),
      onPositiveClick: () => resolve(true),
      onNegativeClick: () => resolve(false),
      onClose: () => resolve(false),
    })
  })
}

async function submit() {
  try {
    await formRef.value?.validate()
  } catch {
    message.warning(t('providers.form.validationFailed'))
    return
  }

  const connection = resolveConnection(form.value, url => validateBaseUrl(url).isValid)
  if (!connection.ok) {
    message.error(connectionMessage(connection))
    return
  }

  const apiKey = isEdit.value && form.value.apiKey.trim() === originalApiKey.value
    ? undefined
    : resolveApiKeyPayload(isEdit.value, form.value.apiKey)
  if (isEdit.value && apiKey !== undefined && !(await confirmKeyReplacement())) {
    return
  }

  submitting.value = true
  try {
    const providerId = isEdit.value ? props.provider!.id : form.value.id.trim()
    const toCreate = modelsToCreate(discovered.value, selectedSet.value, existingSet.value)

    if (isEdit.value) {
      const payload: UpdateProviderRequest = {
        name: form.value.name.trim(),
        description: form.value.description?.trim() || null,
        baseUrl: connection.baseUrl,
        protocolMappings: connection.protocolMappings,
        enabled: form.value.enabled,
      }
      if (apiKey !== undefined) payload.apiKey = apiKey
      await providerApi.update(providerId, payload)
    } else {
      await providerApi.create({
        id: providerId,
        name: form.value.name.trim(),
        description: form.value.description?.trim() || null,
        baseUrl: connection.baseUrl,
        protocolMappings: connection.protocolMappings || undefined,
        apiKey: apiKey || '',
        enabled: form.value.enabled,
      })
    }

    if (toCreate.length) {
      try {
        await modelApi.batchCreate(
          toCreate.map(model => ({
            name: model.name || model.id,
            providerId,
            modelIdentifier: model.id,
            enabled: true,
            modelAttributes: extractModelAttributes(model),
          }))
        )
        await modelStore.fetchModels()
        message.success(
          t(isEdit.value ? 'providers.updatedWithModels' : 'providers.createdWithModels', {
            count: toCreate.length,
          })
        )
      } catch (error: any) {
        message.warning(
          t(isEdit.value ? 'providers.updatedModelsPartial' : 'providers.createdModelsPartial', {
            message: error.message,
          })
        )
      }
    } else {
      message.success(t(isEdit.value ? 'providers.updateSuccess' : 'providers.createdManualHint'))
    }

    emit('saved')
    emit('update:show', false)
  } catch (error: any) {
    if (error?.message) message.error(error.message)
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.dialog-header {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dialog-title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  color: var(--color-title);
  letter-spacing: -0.015em;
}

.dialog-subtitle {
  margin: 0;
  font-size: 12px;
  color: #6b7a73;
  font-variant-numeric: tabular-nums;
}

.provider-dialog :deep(.n-card-header) {
  padding: 18px 22px 14px;
  border-bottom: 1px solid #eef1ef;
}

.provider-dialog :deep(.n-card__content) {
  padding: 0;
  max-height: min(62vh, 620px);
  overflow-y: auto;
  overflow-x: hidden;
}

.provider-dialog :deep(.n-card__footer) {
  padding: 12px 22px;
  border-top: 1px solid #eef1ef;
}

.dialog-body {
  padding: 4px 22px 18px;
}

.dialog-section + .dialog-section {
  margin-top: 6px;
  padding-top: 18px;
}

/* The enable row trails the flow; whitespace separates it, no rule line. */
.dialog-section + .dialog-section:not(.dialog-section--switch) {
  border-top: 1px solid #f0f2f1;
}

.section-head {
  margin-bottom: 12px;
}

.section-head h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-title);
}

.section-head p {
  margin: 3px 0 0;
  font-size: 12px;
  color: #75827c;
}

.section-head--aside {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.field-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 14px;
}

.dialog-form :deep(.n-form-item) {
  margin-bottom: 4px;
}

.field-row :deep(.n-form-item-feedback-wrapper),
.connection-url :deep(.n-form-item-feedback-wrapper) {
  min-height: 12px;
}

.dialog-form :deep(.n-form-item-label) {
  font-size: 12px;
  color: #52605a;
  padding-top: 0;
}

.field-note {
  margin: 2px 0 10px;
  font-size: 12px;
  line-height: 1.5;
  color: #75827c;
}

.field-ok {
  color: var(--color-primary);
  font-size: 15px;
}

.protocol-grid {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.protocol-field {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
}

.protocol-name {
  font-size: 12px;
  color: #52605a;
}

.protocol-field .field-note {
  margin: 0;
}

.model-loading,
.model-idle,
.model-empty {
  color: #7a857f;
  font-size: 12px;
}

.model-action {
  display: inline-flex;
  flex-shrink: 0;
}

.model-action-enter-active,
.model-action-leave-active {
  transition: opacity 140ms ease, transform 140ms ease;
}

.model-action-enter-from,
.model-action-leave-to {
  opacity: 0;
  transform: translateY(3px);
}

.model-state {
  height: 68px;
  overflow-y: auto;
}

.model-picker-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 52px;
}

.model-picker-summary .model-summary {
  margin: 0;
}

.model-loading {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.model-idle {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px;
  border: 1px dashed #dde3e0;
  border-radius: var(--radius-sm);
  background: #fbfcfb;
}

.model-error {
  display: flex;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(240, 160, 32, 0.35);
  background: #fff9ec;
  color: #a06a12;
}

.model-error__icon {
  font-size: 17px;
  margin-top: 1px;
  flex-shrink: 0;
}

.model-error__title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
}

.model-error__desc {
  margin: 2px 0 0;
  font-size: 11px;
  opacity: 0.9;
}

.model-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}

.model-search {
  flex: 1;
  min-width: 120px;
}

.model-summary {
  margin: 0 0 6px;
  font-size: 11px;
  color: #75827c;
  font-variant-numeric: tabular-nums;
}

.model-list {
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid #e6eae8;
  border-radius: var(--radius-sm);
  background: #fff;
}

.model-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  cursor: pointer;
  transition: background-color 140ms ease;
}

.model-row + .model-row {
  border-top: 1px solid #f1f3f2;
}

.model-row:hover:not(.model-row--existing) {
  background: #f4f8f6;
}

.model-row:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}

.model-row--on {
  background: rgba(15, 107, 74, 0.05);
}

.model-row--existing {
  cursor: not-allowed;
  background: #fafbfa;
}

.model-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.model-name {
  font-size: 13px;
  color: #2f3a35;
  overflow-wrap: anywhere;
}

.model-id {
  font-size: 11px;
  color: #818c86;
  overflow-wrap: anywhere;
}

.model-badge {
  margin-left: auto;
  flex-shrink: 0;
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(15, 107, 40, 0.08);
  color: var(--color-primary);
  font-size: 11px;
}

.model-empty {
  padding: 14px;
  text-align: center;
}

.dialog-section--switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.dialog-section--switch h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-title);
}

.dialog-section--switch p {
  margin: 3px 0 0;
  font-size: 12px;
  color: #75827c;
}

.dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

.footer-summary {
  margin: 0;
  font-size: 12px;
  color: #52605a;
}

.footer-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

@media (max-width: 720px) {
  .field-row {
    grid-template-columns: minmax(0, 1fr);
  }

  .section-head--aside {
    flex-direction: column;
    align-items: flex-start;
  }

  .protocol-field {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .model-action-enter-active,
  .model-action-leave-active {
    transition: none;
  }

  .model-row {
    transition: none;
  }
}
</style>

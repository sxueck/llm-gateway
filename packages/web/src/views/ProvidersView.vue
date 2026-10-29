<template>
  <div class="providers-view">
    <div class="providers-stack">
      <PageHeader
        eyebrow="MODEL MANAGEMENT"
        :title="t('providers.title')"
        :subtitle="t('providers.subtitle')"
      >
        <template #actions>
          <n-button @click="testAllProviders" :loading="isTestingAll">
            <template #icon>
              <n-icon><SpeedTestIcon /></n-icon>
            </template>
            {{ t('providers.speedTest') }}
          </n-button>
          <n-dropdown :options="exportOptions" @select="handleExportSelect">
            <n-button>
              <template #icon>
                <n-icon><DownloadIcon /></n-icon>
              </template>
              {{ t('providers.export') }}
            </n-button>
          </n-dropdown>
          <n-upload :show-file-list="false" accept=".json" @change="handleImportFile">
            <n-button>
              <template #icon>
                <n-icon><UploadIcon /></n-icon>
              </template>
              {{ t('providers.import') }}
            </n-button>
          </n-upload>
          <n-button type="primary" @click="showModal = true">{{ t('providers.addProvider') }}</n-button>
        </template>
      </PageHeader>

      <n-card class="table-card">
        <template #header>
          <span class="table-card-title">{{ t('providers.list') }} ({{ enabledProviderCount }}/{{ providerStore.providers.length }})</span>
        </template>
        <template #header-extra>
          <n-input
            v-model:value="searchQuery"
            class="provider-search"
            :placeholder="t('providers.searchPlaceholder')"
            clearable
            round
          >
            <template #prefix>
              <n-icon :component="SearchOutline" />
            </template>
          </n-input>
        </template>
        <n-data-table
          class="providers-table"
          flex-height
          :columns="columns"
          :data="filteredProviders"
          :loading="providerStore.loading"
          :pagination="pagination"
          :scroll-x="900"
          :bordered="false"
          size="small"
          :single-line="false"
        />
      </n-card>
    </div>

    <n-modal
      v-model:show="showModal"
      preset="card"
      :title="editingId ? t('providers.editProvider') : t('providers.addProvider')"
      class="provider-modal"
      :style="{ width: '800px', maxWidth: '92vw', maxHeight: '90vh' }"
      :segmented="{
        content: 'soft',
        footer: 'soft'
      }"
    >
      <div class="modal-content-wrapper">
        <div class="modal-content">
          <ProviderForm
            ref="formRef"
            v-model="formValue"
            :editing-id="editingId"
            :existing-model-identifiers="existingModelIdentifiers"
          />
        </div>
      </div>
      <template #footer>
        <n-space justify="end" :size="8">
          <n-button @click="showModal = false" size="small">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" size="small" :loading="submitting" @click="handleSubmit">
            {{ editingId ? t('common.update') : t('common.create') }}
          </n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, h, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  useMessage,
  useDialog,
  NSpace,
  NButton,
  NDataTable,
  NCard,
  NModal,
  NTag,
  NPopconfirm,
  NDropdown,
  NUpload,
  NIcon,
  NInput,
  type UploadFileInfo,
  type PaginationProps
} from 'naive-ui'
import {
  Download as DownloadIcon,
  CloudUpload as UploadIcon,
  FlashOutline as SpeedTestIcon,
  SearchOutline
} from '@vicons/ionicons5'
import { EditOutlined, DeleteOutlined, KeyboardCommandKeyOutlined } from '@vicons/material'
import { useProviderStore } from '@/stores/provider'
import { useModelStore } from '@/stores/model'
import { providerApi, extractModelAttributes } from '@/api/provider'
import { modelApi } from '@/api/model'
import type { Provider } from '@/types'
import type { ProviderFormValue } from '@/types/provider'
import { createDefaultProviderForm } from '@/types/provider'
import ProviderForm from '@/components/ProviderForm.vue'
import PageHeader from '@/components/PageHeader.vue'
import { downloadProvidersConfig, parseImportFile } from '@/utils/provider-export'

const message = useMessage()
const { t } = useI18n()
const dialog = useDialog()
const providerStore = useProviderStore()
const modelStore = useModelStore()

const showModal = ref(false)
const formRef = ref()
const submitting = ref(false)
const editingId = ref<string | null>(null)
const searchQuery = ref('')

const pagination = reactive<PaginationProps>({
  page: 1,
  pageSize: 20,
  itemCount: 0,
  pageSizes: [10, 20, 50],
  showSizePicker: true,
  prefix: info => t('common.totalCount', { count: info.itemCount }),
  onChange: page => {
    pagination.page = page
  },
  onUpdatePageSize: pageSize => {
    pagination.pageSize = pageSize
    pagination.page = 1
  }
})

const enabledProviderCount = computed(() => providerStore.providers.filter(provider => provider.enabled).length)

const filteredProviders = computed(() => {
  const keyword = searchQuery.value.trim().toLowerCase()
  if (!keyword) return providerStore.providers
  return providerStore.providers.filter(provider =>
    [provider.id, provider.name, provider.baseUrl, provider.description].some(
      field => field && field.toLowerCase().includes(keyword)
    )
  )
})

// Client-side pagination: keep the page within range after deletes/imports shrink the list.
watch([filteredProviders, () => pagination.pageSize], () => {
  const maxPage = Math.max(
    1,
    Math.ceil(filteredProviders.value.length / (pagination.pageSize ?? 10))
  )
  if ((pagination.page ?? 1) > maxPage) pagination.page = maxPage
})

const exportOptions = computed(() => [
  {
    label: t('providers.exportAll'),
    key: 'all'
  },
  {
    label: t('providers.exportEnabled'),
    key: 'enabled'
  }
])

const formValue = ref<ProviderFormValue>(createDefaultProviderForm())

const existingModelIdentifiers = computed(() =>
  modelStore.models
    .filter(model => model.providerId === editingId.value)
    .map(model => model.modelIdentifier)
)

const originalApiKey = ref('')
const apiKeyChanged = ref(false)

const latencies = ref<Record<string, number | null>>({})
const testingStates = ref<Record<string, boolean>>({})
const isTestingAll = ref(false)
const inFlightTests = new Map<string, Promise<void>>()

const columns = computed(() => [
  { title: 'ID', key: 'id', width: 100, ellipsis: { tooltip: true } },
  { title: t('common.name'), key: 'name', width: 150, ellipsis: { tooltip: true } },
  { title: t('common.description'), key: 'description', ellipsis: { tooltip: true } },
  { title: 'Base URL', key: 'baseUrl', width: 220, ellipsis: { tooltip: true } },
  {
    title: t('providers.latency'),
    key: 'latency',
    width: 120,
    render: (row: Provider) => {
      const isTesting = testingStates.value[row.id]
      const latency = latencies.value[row.id]

      if (isTesting) {
        return h('span', { style: 'color: #999; font-size: 12px' }, t('providers.speedTesting'))
      }

      if (latency === undefined || latency === null) {
        return h('span', { style: 'color: #ccc' }, '-')
      }

      // Primary green for good
      let color = '#0f6b4a'
      let bgColor = 'rgba(15, 107, 74, 0.08)'

      // Warm Gold/Bronze for warning
      if (latency > 500) {
        color = '#B89D6A'
        bgColor = 'rgba(184, 157, 106, 0.12)'
      }

      // Muted Red for error/slow
      if (latency > 1500) {
        color = '#D62F2F'
        bgColor = 'rgba(214, 47, 47, 0.08)'
      }

      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: '64px',
            padding: '2px 8px',
            borderRadius: '999px',
            backgroundColor: bgColor,
            color,
            fontFamily:
              'MiSans, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            fontSize: '12px',
            fontWeight: 500
          }
        },
        `${latency}ms`
      )
    }
  },
  {
    title: t('common.status'),
    key: 'enabled',
    render: (row: Provider) =>
      h(
        NTag,
        { type: row.enabled ? 'success' : 'default' },
        { default: () => (row.enabled ? t('common.enabled') : t('common.disabled')) }
      )
  },
  {
    title: t('common.actions'),
    key: 'actions',
    width: 150,
    render: (row: Provider) =>
      h(
        NSpace,
        { size: 6 },
        {
          default: () => [
            h(
              NButton,
              {
                'size': 'small',
                'quaternary': true,
                'circle': true,
                'disabled': !!testingStates.value[row.id],
                'aria-label': t('providers.speedTest'),
                'onClick': () => handleTest(row.id)
              },
              {
                icon: () => h(NIcon, null, { default: () => h(KeyboardCommandKeyOutlined) })
              }
            ),
            h(
              NButton,
              {
                'size': 'small',
                'quaternary': true,
                'circle': true,
                'aria-label': t('common.edit'),
                'onClick': () => handleEdit(row)
              },
              {
                icon: () => h(NIcon, null, { default: () => h(EditOutlined) })
              }
            ),
            h(
              NPopconfirm,
              {
                onPositiveClick: () => handleDelete(row.id)
              },
              {
                trigger: () =>
                  h(
                    NButton,
                    {
                      'size': 'small',
                      'quaternary': true,
                      'circle': true,
                      'aria-label': t('common.delete'),
                      'onClick': () => {}
                    },
                    {
                      icon: () => h(NIcon, null, { default: () => h(DeleteOutlined) })
                    }
                  ),
                default: () => t('providers.deleteConfirm')
              }
            )
          ]
        }
      )
  }
])

async function handleEdit(provider: Provider) {
  editingId.value = provider.id
  apiKeyChanged.value = false

  try {
    const [fullProvider] = await Promise.all([
      providerApi.getById(provider.id, true),
      modelStore.fetchModels(),
    ])
    originalApiKey.value = fullProvider.apiKey || ''

    formValue.value = {
      id: fullProvider.id,
      name: fullProvider.name,
      description: fullProvider.description || '',
      baseUrl: fullProvider.baseUrl,
      protocolMappings: fullProvider.protocolMappings || null,
      apiKey: fullProvider.apiKey || '',
      enabled: fullProvider.enabled
    }
  } catch (error: any) {
    message.error(t('providers.loadFailed', { message: error.message }))
    return
  }

  showModal.value = true
}

async function handleTest(id: string, showToast = true) {
  const inFlight = inFlightTests.get(id)
  if (inFlight) {
    return inFlight
  }

  testingStates.value[id] = true
  const task = (async () => {
    try {
      const result = await providerApi.test(id)
      const latency = typeof result.latencyMs === 'number' ? Math.round(result.latencyMs) : null

      if (result.success) {
        latencies.value[id] = latency
        if (showToast) {
          const latencyText = latency !== null ? ` (${t('providers.latencyValue', { ms: latency })})` : ''
          message.success(`${result.message}${latencyText}`)
        }
      } else {
        latencies.value[id] = null
        if (showToast) {
          message.error(result.message)
        }
      }
    } catch (error: any) {
      latencies.value[id] = null
      if (showToast) {
        message.error(error.message)
      }
    } finally {
      testingStates.value[id] = false
      inFlightTests.delete(id)
    }
  })()

  inFlightTests.set(id, task)
  return task
}

async function testAllProviders() {
  const providers = providerStore.providers.filter(p => p.enabled)
  if (providers.length === 0) {
    message.warning(t('providers.noEnabled'))
    return
  }

  isTestingAll.value = true
  message.loading(t('providers.testingAll'), { duration: 2000 })

  try {
    await Promise.all(providers.map(p => handleTest(p.id, false)))
    message.success(t('providers.testDone'))
  } finally {
    isTestingAll.value = false
  }
}

async function handleDelete(id: string) {
  try {
    await providerApi.delete(id)
    message.success(t('providers.deleted'))
    await providerStore.fetchProviders()
  } catch (error: any) {
    message.error(error.message)
  }
}

async function handleSubmit() {
  try {
    formRef.value?.syncProtocolMappings?.()

    await formRef.value?.validate()

    if (editingId.value && formValue.value.apiKey !== originalApiKey.value) {
      apiKeyChanged.value = true
      const confirmed = await new Promise<boolean>(resolve => {
        dialog.warning({
          title: t('providers.apiKeyChangedTitle'),
          content: t('providers.apiKeyChangedContent'),
          positiveText: t('providers.confirmSave'),
          negativeText: t('common.cancel'),
          onPositiveClick: () => {
            resolve(true)
          },
          onNegativeClick: () => {
            resolve(false)
          },
          onClose: () => {
            resolve(false)
          }
        })
      })

      if (!confirmed) {
        return
      }
    }

    submitting.value = true

    if (editingId.value) {
      const updateData: any = {
        name: formValue.value.name,
        description: formValue.value.description,
        baseUrl: formValue.value.baseUrl,
        protocolMappings: formValue.value.protocolMappings,
        enabled: formValue.value.enabled
      }
      if (formValue.value.apiKey !== originalApiKey.value) {
        updateData.apiKey = formValue.value.apiKey
      }
      await providerApi.update(editingId.value, updateData)

      const selectedModelsInfo = formRef.value?.getSelectedModelsInfo?.() || []
      if (selectedModelsInfo.length > 0) {
        const existing = modelStore.models.filter(m => m.providerId === formValue.value.id)
        const modelsToCreate = selectedModelsInfo
          .filter((model: any) => !existing.some(e => e.modelIdentifier === model.id))
          .map((model: any) => ({
            name: model.name || model.id,
            providerId: formValue.value.id,
            modelIdentifier: model.id,
            enabled: true,
            modelAttributes: extractModelAttributes(model),
          }))

        if (modelsToCreate.length > 0) {
          try {
            await modelApi.batchCreate(modelsToCreate)
            await modelStore.fetchModels()
            message.success(t('providers.updatedWithModels', { count: modelsToCreate.length }))
          } catch (error: any) {
            message.warning(t('providers.updatedModelsPartial', { message: error.message }))
          }
        } else {
          message.success(t('providers.updateSuccess'))
        }
      } else {
        message.success(t('providers.updateSuccess'))
      }
    } else {
      const selectedModelsInfo = formRef.value?.getSelectedModelsInfo?.() || []

      await providerApi.create({
        ...formValue.value,
        protocolMappings: formValue.value.protocolMappings || undefined
      })

      if (selectedModelsInfo.length > 0) {
        const modelsToCreate = selectedModelsInfo.map((model: any) => ({
          name: model.name || model.id,
          providerId: formValue.value.id,
          modelIdentifier: model.id,
          enabled: true,
          modelAttributes: extractModelAttributes(model),
        }))

        try {
          await modelApi.batchCreate(modelsToCreate)
          await modelStore.fetchModels()
          message.success(t('providers.createdWithModels', { count: selectedModelsInfo.length }))
        } catch (error: any) {
          message.warning(t('providers.createdModelsPartial', { message: error.message }))
        }
      } else {
        message.success(t('providers.createdManualHint'))
      }
    }

    showModal.value = false
    resetForm()
    await providerStore.fetchProviders()
  } catch (error: any) {
    if (error.message) {
      message.error(error.message)
    }
  } finally {
    submitting.value = false
  }
}

function resetForm() {
  editingId.value = null
  originalApiKey.value = ''
  apiKeyChanged.value = false
  formValue.value = createDefaultProviderForm()
}

function handleExportSelect(key: string) {
  const providers =
    key === 'enabled' ? providerStore.providers.filter(p => p.enabled) : providerStore.providers

  if (providers.length === 0) {
    message.warning(t('providers.nothingToExport'))
    return
  }

  downloadProvidersConfig(providers)
  message.success(t('providers.exported', { count: providers.length }))
}

async function handleImportFile(data: {
  file: Required<UploadFileInfo>
  fileList: Required<UploadFileInfo>[]
  event?: Event | ProgressEvent<EventTarget>
}) {
  const file = data.file.file

  if (!file) {
    message.error(t('providers.emptyFile'))
    return
  }

  try {
    const { data: importData, validation } = await parseImportFile(file)

    if (!validation.isValid) {
      message.error(t('providers.importFailed', { message: validation.errors.join(', ') }))
      return
    }

    if (validation.warnings.length > 0) {
      message.warning(t('providers.importWarning', { message: validation.warnings.join(', ') }))
    }

    if (!importData) {
      message.error(t('providers.importEmpty'))
      return
    }

    const providersToImport = importData.providers

    dialog.warning({
      title: t('providers.importConfirmTitle'),
      content: t('providers.importConfirmContent', { count: providersToImport.length }),
      positiveText: t('providers.importConfirm'),
      negativeText: t('common.cancel'),
      onPositiveClick: async () => {
        await executeImport(providersToImport)
      }
    })
  } catch (error: any) {
    message.error(t('providers.importFailed', { message: error.message }))
  }
}

async function executeImport(
  providers: Array<{
    id: string
    name: string
    description?: string
    baseUrl: string
    enabled?: boolean
  }>
) {
  try {
    const providersWithDummyKey = providers.map(p => ({
      ...p,
      apiKey: 'PLEASE_SET_YOUR_API_KEY',
      enabled: false
    }))

    const result = await providerApi.batchImport(providersWithDummyKey, true)

    if (result.success) {
      message.success(result.message)

      if (result.results.errors.length > 0) {
        const errorMessages = result.results.errors.map(e => `${e.id}: ${e.error}`).join('\n')
        dialog.error({
          title: t('providers.importPartialTitle'),
          content: errorMessages
        })
      }
    } else {
      message.error(result.message)

      if (result.results.errors.length > 0) {
        const errorMessages = result.results.errors.map(e => `${e.id}: ${e.error}`).join('\n')
        dialog.error({
          title: t('providers.importErrorTitle'),
          content: errorMessages
        })
      }
    }

    await providerStore.fetchProviders()
  } catch (error: any) {
    message.error(t('providers.importFailed', { message: error.message }))
  }
}

watch(showModal, visible => {
  if (!visible) {
    resetForm()
  }
})

onMounted(() => {
  providerStore.fetchProviders()
  modelStore.fetchModels()
})
</script>

<style scoped>
.providers-view {
  max-width: 1400px;
  margin: 0 auto;
  /* n-layout-content 滚动内容层（.n-scrollbar-content）高度是 auto，
     height:100% 解析不了，会把 flex-height 表格压成 0 行；
     改用确定高度：100vh - 72px 页头 - 8px/24px 上下内边距。 */
  height: calc(100vh - 104px);
  min-height: 480px;
  display: flex;
  flex-direction: column;
}

.providers-stack {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 页头与概览不参与压缩，剩下的高度全给表格卡片 */
.providers-stack > * {
  flex-shrink: 0;
}

.table-card {
  flex: 1 1 auto;
  /* 不设 min-height：卡片只拿到“剩下”的高度，行多时在表格内部滚动 + 翻页 */
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #ffffff;
  border-radius: 12px;
  border: 1px solid #e6e6e6;
  overflow: hidden;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.04);
}

.table-card :deep(.n-card__content) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.providers-table {
  flex: 1;
  min-height: 0;
}

.table-card-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-title);
  letter-spacing: -0.015em;
}

.provider-search {
  width: 260px;
}

.table-card :deep(.n-data-table) {
  background: transparent;
}

.table-card :deep(.n-data-table-th) {
  background: #fafafa;
  font-weight: 600;
  font-size: 12px;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  border-bottom: 1px solid #e8e8e8;
  padding: 10px 12px;
}

.table-card :deep(.n-data-table-tr:last-child .n-data-table-td) {
  border-bottom: none;
}

.table-card :deep(.n-data-table-tr:hover .n-data-table-td) {
  background-color: #f7fbf9 !important;
}

.providers-view :deep(.n-button--primary-type) {
  background-color: var(--color-primary);
  border-color: var(--color-primary);
}

.providers-view :deep(.n-button--primary-type:hover),
.providers-view :deep(.n-button--primary-type:focus) {
  background-color: var(--color-primary-hover);
  border-color: var(--color-primary-hover);
}

.providers-view :deep(.n-button--primary-type:pressed) {
  background-color: var(--color-primary-pressed);
  border-color: var(--color-primary-pressed);
}

.providers-view :deep(.n-button:not(.n-button--primary-type):not(.n-button--quaternary-type):hover),
.providers-view
  :deep(.n-button:not(.n-button--primary-type):not(.n-button--quaternary-type):focus) {
  color: var(--color-primary);
  border-color: var(--color-primary);
  background-color: #f7fbf9;
}

.table-card :deep(.n-button.n-button--quaternary-type.n-button--circle-shape:hover) {
  background: #d4e9e2;
  color: var(--color-primary);
}

.table-card :deep(.n-button.n-button--quaternary-type.n-button--circle-shape:hover .n-icon) {
  color: var(--color-primary);
}

.table-card :deep(.n-button.n-button--quaternary-type.n-button--circle-shape .n-icon) {
  color: #555;
  font-size: 16px;
  transition: color 0.2s;
}

.table-card :deep(.n-button.n-button--quaternary-type.n-button--circle-shape:disabled) {
  opacity: 0.4;
  cursor: not-allowed;
}

.provider-modal :deep(.n-card) {
  background: #ffffff;
  border-radius: 8px;
  border: 1px solid #e8e8e8;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.provider-modal :deep(.n-card__header) {
  padding: 16px 20px;
  border-bottom: 1px solid #e8e8e8;
  flex-shrink: 0;
}

.provider-modal :deep(.n-card__content) {
  padding: 0;
  overflow: hidden;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.modal-content-wrapper {
  max-height: calc(90vh - 180px);
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.provider-modal :deep(.n-card__footer) {
  padding: 12px 20px;
  border-top: 1px solid #e8e8e8;
  background: #ffffff;
  flex-shrink: 0;
}

.modal-content {
  min-height: 200px;
  padding: 16px 20px;
}
</style>

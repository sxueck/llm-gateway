<template>
  <div class="providers-view">
    <n-space vertical :size="12">
      <n-space justify="space-between" align="center">
        <div>
          <h2 class="page-title">提供商管理</h2>
          <p class="page-subtitle">配置和管理 AI 模型提供商,包括 API 密钥、Base URL 等信息。支持导入导出配置</p>
        </div>
        <n-space :size="8">
          <n-dropdown :options="exportOptions" @select="handleExportSelect">
            <n-button size="small">
              <template #icon>
                <n-icon><DownloadIcon /></n-icon>
              </template>
              导出
            </n-button>
          </n-dropdown>
          <n-upload
            :show-file-list="false"
            accept=".json"
            @change="handleImportFile"
          >
            <n-button size="small">
              <template #icon>
                <n-icon><UploadIcon /></n-icon>
              </template>
              导入
            </n-button>
          </n-upload>
          <n-button type="primary" size="small" @click="showModal = true">
            添加提供商
          </n-button>
        </n-space>
      </n-space>

      <ProviderOverview :providers="providerStore.providers" />

      <n-card class="table-card">
        <n-data-table
          :columns="columns"
          :data="providerStore.providers"
          :loading="providerStore.loading"
          :pagination="{ pageSize: 10 }"
          :bordered="false"
          size="small"
          :single-line="false"
        />
      </n-card>
    </n-space>

    <n-modal
      v-model:show="showModal"
      preset="card"
      :title="editingId ? '编辑提供商' : '添加提供商'"
      class="provider-modal"
      :style="{ width: '950px', maxHeight: '85vh' }"
      :segmented="{
        content: 'soft',
        footer: 'soft'
      }"
    >
      <div class="modal-content-wrapper">
        <div class="modal-content">
          <n-tabs v-if="!editingId" v-model:value="activeTab" type="line" size="small">
            <n-tab-pane name="preset" tab="选择预设">
              <ProviderPresetSelector v-model="selectedPreset" />
              <n-space justify="end" style="margin-top: 12px">
                <n-button @click="usePreset" :disabled="!selectedPreset" type="primary" size="small">
                  使用此预设
                </n-button>
              </n-space>
            </n-tab-pane>
            <n-tab-pane name="custom" tab="自定义配置">
              <ProviderForm ref="formRef" v-model="formValue" :editing-id="editingId" />
            </n-tab-pane>
          </n-tabs>
          <ProviderForm v-else ref="formRef" v-model="formValue" :editing-id="editingId" />
        </div>
      </div>
      <template #footer>
        <n-space justify="end" :size="8">
          <n-button @click="showModal = false" size="small">取消</n-button>
          <n-button
            v-if="!editingId && activeTab === 'custom'"
            type="primary"
            size="small"
            :loading="submitting"
            @click="handleSubmit"
          >
            创建
          </n-button>
          <n-button
            v-if="editingId"
            type="primary"
            size="small"
            :loading="submitting"
            @click="handleSubmit"
          >
            更新
          </n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, h, onMounted } from 'vue';
import { useMessage, useDialog, NSpace, NButton, NDataTable, NCard, NModal, NTag, NPopconfirm, NTabs, NTabPane, NDropdown, NUpload, NIcon, type UploadFileInfo } from 'naive-ui';
import { Download as DownloadIcon, CloudUpload as UploadIcon } from '@vicons/ionicons5';
import { EditOutlined, DeleteOutlined, KeyboardCommandKeyOutlined } from '@vicons/material';
import { useProviderStore } from '@/stores/provider';
import { useModelStore } from '@/stores/model';
import { providerApi } from '@/api/provider';
import { modelApi } from '@/api/model';
import type { Provider } from '@/types';
import ProviderPresetSelector from '@/components/ProviderPresetSelector.vue';
import ProviderForm from '@/components/ProviderForm.vue';
import ProviderOverview from '@/components/ProviderOverview.vue';
import type { ProviderPreset } from '@/constants/providers';
import { downloadProvidersConfig, parseImportFile } from '@/utils/provider-export';

const message = useMessage();
const dialog = useDialog();
const providerStore = useProviderStore();
const modelStore = useModelStore();

const showModal = ref(false);
const formRef = ref();
const submitting = ref(false);
const editingId = ref<string | null>(null);
const activeTab = ref('preset');
const selectedPreset = ref<ProviderPreset | null>(null);

const exportOptions = [
  {
    label: '导出所有提供商',
    key: 'all',
  },
  {
    label: '仅导出已启用的提供商',
    key: 'enabled',
  },
];

const formValue = ref({
  id: '',
  name: '',
  baseUrl: '',
  protocolMappings: null as any,
  apiKey: '',
  enabled: true,
});

const originalApiKey = ref('');
const apiKeyChanged = ref(false);



const columns = [
  { title: 'ID', key: 'id' },
  { title: '名称', key: 'name' },
  { title: 'Base URL', key: 'baseUrl' },
  {
    title: '状态',
    key: 'enabled',
    render: (row: Provider) => h(NTag, { type: row.enabled ? 'success' : 'default' }, { default: () => row.enabled ? '启用' : '禁用' }),
  },
  {
    title: '操作',
    key: 'actions',
    width: 150,
    render: (row: Provider) => h(NSpace, { size: 6 }, {
      default: () => [
        h(NButton, {
          size: 'small',
          quaternary: true,
          circle: true,
          onClick: () => handleTest(row.id),
        }, {
          icon: () => h(NIcon, null, { default: () => h(KeyboardCommandKeyOutlined) }),
        }),
        h(NButton, {
          size: 'small',
          quaternary: true,
          circle: true,
          onClick: () => handleEdit(row),
        }, {
          icon: () => h(NIcon, null, { default: () => h(EditOutlined) }),
        }),
        h(NPopconfirm, {
          onPositiveClick: () => handleDelete(row.id),
        }, {
          trigger: () => h(NButton, {
            size: 'small',
            quaternary: true,
            circle: true,
          }, {
            icon: () => h(NIcon, null, { default: () => h(DeleteOutlined) }),
          }),
          default: () => '确定删除此提供商吗？',
        }),
      ],
    }),
  },
];

async function handleEdit(provider: Provider) {
  editingId.value = provider.id;
  apiKeyChanged.value = false;

  try {
    const fullProvider = await providerApi.getById(provider.id, true);
    originalApiKey.value = fullProvider.apiKey || '';

    formValue.value = {
      id: fullProvider.id,
      name: fullProvider.name,
      baseUrl: fullProvider.baseUrl,
      protocolMappings: fullProvider.protocolMappings || null,
      apiKey: fullProvider.apiKey || '',
      enabled: fullProvider.enabled,
    };
  } catch (error: any) {
    message.error('获取提供商信息失败: ' + error.message);
    return;
  }

  showModal.value = true;
}

async function handleTest(id: string) {
  try {
    const result = await providerApi.test(id);
    if (result.success) {
      message.success(result.message);
    } else {
      message.error(result.message);
    }
  } catch (error: any) {
    message.error(error.message);
  }
}

async function handleDelete(id: string) {
  try {
    await providerApi.delete(id);
    message.success('删除成功');
    await providerStore.fetchProviders();
  } catch (error: any) {
    message.error(error.message);
  }
}

async function handleSubmit() {
  try {
    // 在提交前同步 protocolMappings
    formRef.value?.syncProtocolMappings?.();

    await formRef.value?.validate();

    if (editingId.value && formValue.value.apiKey !== originalApiKey.value) {
      apiKeyChanged.value = true;
      const confirmed = await new Promise<boolean>((resolve) => {
        dialog.warning({
          title: 'API Key 已变更',
          content: '检测到您修改了 API Key，确定要保存新的密钥吗？',
          positiveText: '确定保存',
          negativeText: '取消',
          onPositiveClick: () => {
            resolve(true);
          },
          onNegativeClick: () => {
            resolve(false);
          },
          onClose: () => {
            resolve(false);
          },
        });
      });

      if (!confirmed) {
        return;
      }
    }

    submitting.value = true;

    if (editingId.value) {
      const updateData: any = {
        name: formValue.value.name,
        baseUrl: formValue.value.baseUrl,
        protocolMappings: formValue.value.protocolMappings,
        enabled: formValue.value.enabled,
      };
      if (formValue.value.apiKey !== originalApiKey.value) {
        updateData.apiKey = formValue.value.apiKey;
      }
      await providerApi.update(editingId.value, updateData);

      const selectedModelsInfo = formRef.value?.getSelectedModelsInfo?.() || [];
      if (selectedModelsInfo.length > 0) {
        const existing = modelStore.models.filter(m => m.providerId === formValue.value.id);
        const modelsToCreate = selectedModelsInfo
          .filter((model: any) => !existing.some(e => e.modelIdentifier === model.id))
          .map((model: any) => ({
            name: model.name || model.id,
            providerId: formValue.value.id,
            modelIdentifier: model.id,
            enabled: true,
          }));

        if (modelsToCreate.length > 0) {
          try {
            await modelApi.batchCreate(modelsToCreate);
            await modelStore.fetchModels();
            message.success(`更新成功，新增 ${modelsToCreate.length} 个模型`);
          } catch (error: any) {
            message.warning(`提供商更新成功，但部分模型创建失败: ${error.message}`);
          }
        } else {
          message.success('更新成功');
        }
      } else {
        message.success('更新成功');
      }
    } else {
      const selectedModelsInfo = formRef.value?.getSelectedModelsInfo?.() || [];

      await providerApi.create(formValue.value);

      if (selectedModelsInfo.length > 0) {
        const modelsToCreate = selectedModelsInfo.map((model: any) => ({
          name: model.name || model.id,
          providerId: formValue.value.id,
          modelIdentifier: model.id,
          enabled: true,
        }));

        try {
          await modelApi.batchCreate(modelsToCreate);
          // 刷新模型列表以确保新创建的模型能被其他页面看到
          await modelStore.fetchModels();
          message.success(`创建成功，已添加 ${selectedModelsInfo.length} 个模型`);
        } catch (error: any) {
          message.warning(`提供商创建成功，但部分模型创建失败: ${error.message}`);
        }
      } else {
        message.success('创建成功，您可以在模型管理页面使用"批量添加"功能手动添加模型');
      }
    }

    showModal.value = false;
    resetForm();
    await providerStore.fetchProviders();
  } catch (error: any) {
    if (error.message) {
      message.error(error.message);
    }
  } finally {
    submitting.value = false;
  }
}

function resetForm() {
  editingId.value = null;
  activeTab.value = 'preset';
  selectedPreset.value = null;
  originalApiKey.value = '';
  apiKeyChanged.value = false;
  formValue.value = {
    id: '',
    name: '',
    baseUrl: '',
    protocolMappings: null,
    apiKey: '',
    enabled: true,
  };
}

function usePreset() {
  if (!selectedPreset.value) return;

  formValue.value = {
    id: selectedPreset.value.id,
    name: selectedPreset.value.name,
    baseUrl: selectedPreset.value.baseUrl,
    protocolMappings: null,
    apiKey: '',
    enabled: true,
  };
  activeTab.value = 'custom';
}

function handleExportSelect(key: string) {
  const providers = key === 'enabled'
    ? providerStore.providers.filter(p => p.enabled)
    : providerStore.providers;

  if (providers.length === 0) {
    message.warning('没有可导出的提供商');
    return;
  }

  downloadProvidersConfig(providers);
  message.success(`已导出 ${providers.length} 个提供商配置`);
}

async function handleImportFile(data: { file: Required<UploadFileInfo>; fileList: Required<UploadFileInfo>[]; event?: Event | ProgressEvent<EventTarget> }) {
  const file = data.file.file;

  if (!file) {
    message.error('文件为空，无法导入');
    return;
  }

  try {
    const { data: importData, validation } = await parseImportFile(file);

    if (!validation.isValid) {
      message.error(`导入失败: ${validation.errors.join(', ')}`);
      return;
    }

    if (validation.warnings.length > 0) {
      message.warning(`导入警告: ${validation.warnings.join(', ')}`);
    }

    if (!importData) {
      message.error('导入数据为空');
      return;
    }

    const providersToImport = importData.providers;

    dialog.warning({
      title: '确认导入',
      content: `即将导入 ${providersToImport.length} 个提供商配置。\n\n注意：导入的提供商需要您手动设置 API Key，因为安全原因导出文件中不包含 API Key。\n\n已存在的提供商将被跳过。`,
      positiveText: '确认导入',
      negativeText: '取消',
      onPositiveClick: async () => {
        await executeImport(providersToImport);
      },
    });
  } catch (error: any) {
    message.error(`导入失败: ${error.message}`);
  }
}

async function executeImport(providers: Array<{ id: string; name: string; baseUrl: string; enabled?: boolean }>) {
  try {
    const providersWithDummyKey = providers.map(p => ({
      ...p,
      apiKey: 'PLEASE_SET_YOUR_API_KEY',
      enabled: false,
    }));

    const result = await providerApi.batchImport(providersWithDummyKey, true);

    if (result.success) {
      message.success(result.message);

      if (result.results.errors.length > 0) {
        const errorMessages = result.results.errors.map(e => `${e.id}: ${e.error}`).join('\n');
        dialog.error({
          title: '部分导入失败',
          content: errorMessages,
        });
      }
    } else {
      message.error(result.message);

      if (result.results.errors.length > 0) {
        const errorMessages = result.results.errors.map(e => `${e.id}: ${e.error}`).join('\n');
        dialog.error({
          title: '导入错误详情',
          content: errorMessages,
        });
      }
    }

    await providerStore.fetchProviders();
  } catch (error: any) {
    message.error(`导入失败: ${error.message}`);
  }
}

onMounted(() => {
  providerStore.fetchProviders();
});
</script>

<style scoped>
@import '@/styles/table.css';
.providers-view {
  max-width: 1400px;
  margin: 0 auto;
}

.page-title {
  font-size: 24px;
  font-weight: 600;
  color: #1a1a1a;
  margin: 0;
  letter-spacing: -0.02em;
}

.page-subtitle {
  font-size: 14px;
  color: #8c8c8c;
  margin: 4px 0 0 0;
  font-weight: 400;
}

.table-card {
  background: #ffffff;
  border-radius: 16px;
  border: none;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
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

.table-card :deep(.n-button.n-button--quaternary-type.n-button--circle-shape) {
  width: 28px;
  height: 28px;
  transition: all 0.2s ease;
}

.table-card :deep(.n-button.n-button--quaternary-type.n-button--circle-shape:hover) {
  background: rgba(15, 107, 74, 0.08);
  color: #0f6b4a;
}

.table-card :deep(.n-button.n-button--quaternary-type.n-button--circle-shape:hover .n-icon) {
  color: #0f6b4a;
}

.table-card :deep(.n-button.n-button--quaternary-type.n-button--circle-shape .n-icon) {
  color: #666;
  font-size: 16px;
}

.table-card :deep(.n-button.n-button--quaternary-type.n-button--circle-shape:disabled) {
  opacity: 0.4;
  cursor: not-allowed;
}

.provider-modal :deep(.n-card) {
  background: #ffffff;
  border-radius: 8px;
  border: 1px solid #e8e8e8;
}

.provider-modal :deep(.n-card__header) {
  padding: 16px 20px;
  border-bottom: 1px solid #e8e8e8;
}

.provider-modal :deep(.n-card__content) {
  padding: 0;
  overflow: hidden;
}

.modal-content-wrapper {
  max-height: calc(85vh - 180px);
  overflow-y: auto;
  overflow-x: hidden;
}

.modal-content-wrapper::-webkit-scrollbar {
  width: 6px;
}

.modal-content-wrapper::-webkit-scrollbar-track {
  background: #f0f0f0;
  border-radius: 3px;
}

.modal-content-wrapper::-webkit-scrollbar-thumb {
  background: #d0d0d0;
  border-radius: 3px;
}

.modal-content-wrapper::-webkit-scrollbar-thumb:hover {
  background: #b0b0b0;
}

.provider-modal :deep(.n-card__footer) {
  padding: 12px 20px;
  border-top: 1px solid #e8e8e8;
  background: #ffffff;
}

.modal-content {
  min-height: 200px;
  padding: 16px 20px;
}

.provider-modal :deep(.n-tabs-nav) {
  padding: 0;
}

.provider-modal :deep(.n-tabs-tab) {
  padding: 8px 16px;
  font-size: 13px;
}
</style>


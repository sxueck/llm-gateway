<template>
  <div>
    <n-space vertical :size="12">
      <n-space justify="space-between" align="center">
        <div>
          <h2 class="page-title">智能路由</h2>
          <p class="page-subtitle">智能路由通过负载均衡或故障转移配置,将请求智能分发到多个实际模型,提高可用性和性能</p>
        </div>
        <n-space :size="8">
          <n-button type="primary" size="small" @click="handleCreateModalOpen">
            <template #icon>
              <n-icon><AddOutline /></n-icon>
            </template>
            创建智能路由
          </n-button>
          <n-button size="small" @click="handleRefresh">
            <template #icon>
              <n-icon><RefreshOutline /></n-icon>
            </template>
            刷新
          </n-button>
        </n-space>
      </n-space>

      <n-alert type="info">
        智能路由作为统一入口,请求会根据配置的策略分发到目标模型。实际请求仍会通过目标模型匹配的 Portkey 网关路由规则进行转发。
      </n-alert>

      <n-card class="table-card">
        <n-data-table
          :columns="columns"
          :data="configs"
          :loading="loading"
          :pagination="{ pageSize: 10 }"
          :bordered="false"
          size="small"
          :single-line="false"
        />
      </n-card>
    </n-space>

    <n-modal v-model:show="showCreateModal" preset="card" :title="editingId ? '编辑智能路由' : '创建智能路由'" style="width: 700px">
      <VirtualModelWizard
        v-model:config-type="configType"
        v-model:form-value="formValue"
        :provider-options="providerOptions"
        :get-model-options-by-provider="getModelOptionsByProvider"
        :status-code-options="statusCodeOptions"
        @save="handleSave"
        @cancel="handleCancel"
        :saving="saving"
        :is-editing="!!editingId"
      />
    </n-modal>

    <n-modal v-model:show="showPreviewModal" preset="card" title="配置预览" style="width: 700px">
      <div class="code-preview">
        <n-code :code="previewConfig" />
      </div>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showPreviewModal = false">关闭</n-button>
          <n-button type="primary" @click="handleCopyConfig">
            <template #icon>
              <n-icon><CopyOutline /></n-icon>
            </template>
            复制配置
          </n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, h, onMounted } from 'vue';
import {
  useMessage,
  NSpace,
  NCard,
  NButton,
  NIcon,
  NDataTable,
  NModal,
  NCode,
  NTag,
  NPopconfirm,
  NAlert,
} from 'naive-ui';
import {
  AddOutline,
  RefreshOutline,
  CopyOutline,
} from '@vicons/ionicons5';
import { EditOutlined, DeleteOutlined, VisibilityOutlined } from '@vicons/material';
import { useProviderStore } from '@/stores/provider';
import { useModelStore } from '@/stores/model';
import { configApi } from '@/api/config';
import VirtualModelWizard from '@/components/VirtualModelWizard.vue';
import { copyToClipboard } from '@/utils/common';

const message = useMessage();
const providerStore = useProviderStore();
const modelStore = useModelStore();

const loading = ref(false);
const saving = ref(false);
const showCreateModal = ref(false);
const showPreviewModal = ref(false);
const configType = ref<'loadbalance' | 'fallback'>('loadbalance');
const configs = ref<any[]>([]);
const previewConfig = ref('');
const editingId = ref<string | null>(null);

interface Target {
  providerId: string;
  modelId?: string;
  weight?: number;
  onStatusCodes?: number[];
}

const formValue = ref({
  name: '',
  description: '',
  targets: [] as Target[],
  createVirtualModel: true,
  virtualModelName: '',
  modelAttributes: undefined as any,
});

const statusCodeOptions = [
  { label: '429 - 请求过多', value: 429 },
  { label: '500 - 服务器错误', value: 500 },
  { label: '502 - 网关错误', value: 502 },
  { label: '503 - 服务不可用', value: 503 },
  { label: '504 - 网关超时', value: 504 },
];

const providerOptions = computed(() => {
  return providerStore.providers
    .filter(p => p.enabled)
    .map(p => ({
      label: p.name,
      value: p.id,
    }));
});

function getModelOptionsByProvider(providerId: string) {
  if (!providerId) return [];
  return modelStore.models
    .filter(m => m.providerId === providerId && m.enabled && !m.isVirtual)
    .map(m => ({
      label: m.name,
      value: m.id,
    }));
}

const columns = [
  { title: '智能路由名称', key: 'name' },
  { title: '类型', key: 'type', render: (row: any) => h(NTag, { type: row.type === 'loadbalance' ? 'info' : 'warning' }, { default: () => row.type === 'loadbalance' ? '负载均衡' : '故障转移' }) },
  { title: '目标数量', key: 'targetCount' },
  { title: '描述', key: 'description', ellipsis: { tooltip: true } },
  {
    title: '操作',
    key: 'actions',
    width: 150,
    render: (row: any) => h(NSpace, { size: 6 }, {
      default: () => [
        h(NButton, {
          size: 'small',
          quaternary: true,
          circle: true,
          onClick: () => handlePreview(row),
        }, {
          icon: () => h(NIcon, null, { default: () => h(VisibilityOutlined) }),
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
          default: () => '确定删除此智能路由？',
        }),
      ],
    }),
  },
];



function generatePortkeyConfig() {
  const config: any = {
    strategy: {
      mode: configType.value,
    },
    targets: formValue.value.targets.map(target => {
      const targetConfig: any = {
        provider: target.providerId,
      };

      if (configType.value === 'loadbalance' && target.weight !== undefined) {
        targetConfig.weight = target.weight;
      }

      if (target.modelId) {
        const model = modelStore.models.find(m => m.id === target.modelId);
        if (model) {
          targetConfig.override_params = {
            model: model.modelIdentifier,
          };
        }
      }

      if (configType.value === 'fallback' && target.onStatusCodes && target.onStatusCodes.length > 0) {
        targetConfig.on_status_codes = target.onStatusCodes;
      }

      return targetConfig;
    }),
  };

  return config;
}

async function handleSave() {
  try {
    saving.value = true;
    const config = generatePortkeyConfig();

    if (editingId.value) {
      await configApi.updateRoutingConfig(editingId.value, {
        name: formValue.value.virtualModelName || formValue.value.name,
        description: formValue.value.description,
        type: configType.value,
        config: config,
        virtualModelName: formValue.value.virtualModelName,
        modelAttributes: formValue.value.modelAttributes,
      });
      message.success('虚拟模型已更新');
    } else {
      const result = await configApi.createRoutingConfig({
        name: formValue.value.virtualModelName,
        description: formValue.value.description,
        type: configType.value,
        config: config,
        createVirtualModel: formValue.value.createVirtualModel,
        virtualModelName: formValue.value.virtualModelName,
        modelAttributes: formValue.value.modelAttributes,
      });

      if (result.virtualModel) {
        message.success(`智能路由 "${result.virtualModel.name}" 已创建`);
      } else {
        message.success('智能路由已创建');
      }
    }

    showCreateModal.value = false;
    resetForm();
    await loadConfigs();
    await modelStore.fetchModels();
  } catch (error: any) {
    message.error(error.message);
  } finally {
    saving.value = false;
  }
}

function handleEdit(row: any) {
  editingId.value = row.id;
  configType.value = row.type;

  const virtualModel = modelStore.models.find(m => m.routingConfigId === row.id && m.isVirtual);

  formValue.value = {
    name: row.name,
    description: row.description || '',
    targets: row.config.targets.map((target: any) => {
      const model = modelStore.models.find(m => m.modelIdentifier === target.override_params?.model);
      return {
        providerId: target.provider,
        modelId: model?.id || '',
        weight: target.weight,
        onStatusCodes: target.on_status_codes || [],
      };
    }),
    createVirtualModel: true,
    virtualModelName: virtualModel?.name || '',
    modelAttributes: virtualModel?.modelAttributes || undefined,
  };

  showCreateModal.value = true;
}

function handleCancel() {
  showCreateModal.value = false;
  resetForm();
}

function handlePreview(row: any) {
  previewConfig.value = JSON.stringify(row.config, null, 2);
  showPreviewModal.value = true;
}

async function handleDelete(id: string) {
  try {
    await configApi.deleteRoutingConfig(id);
    message.success('智能路由已删除');
    await loadConfigs();
  } catch (error: any) {
    message.error(error.message);
  }
}

function handleCopyConfig() {
  copyToClipboard(previewConfig.value);
}

function resetForm() {
  editingId.value = null;
  formValue.value = {
    name: '',
    description: '',
    targets: [],
    createVirtualModel: true,
    virtualModelName: '',
    modelAttributes: undefined,
  };
  configType.value = 'loadbalance';
}

async function loadConfigs() {
  try {
    loading.value = true;
    const result = await configApi.getRoutingConfigs();
    configs.value = result.configs
      .filter(c => c.type === 'loadbalance' || c.type === 'fallback')
      .map(c => ({
        ...c,
        targetCount: c.config.targets?.length || 0,
      }));
  } catch (error: any) {
    message.error(error.message);
  } finally {
    loading.value = false;
  }
}

async function refreshData() {
  await Promise.all([
    providerStore.fetchProviders(),
    modelStore.fetchModels(),
  ]);
}

function handleCreateModalOpen() {
  showCreateModal.value = true;
  refreshData();
}

async function handleRefresh() {
  await refreshData();
  await loadConfigs();
}

onMounted(async () => {
  await refreshData();
  loadConfigs();
});

</script>



<style scoped>
.page-title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  color: #1a1a1a;
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

.table-card :deep(.n-data-table-td) {
  padding: 10px 12px;
  border-bottom: 1px solid #f0f0f0;
  font-size: 13px;
  color: #333;
}

.table-card :deep(.n-data-table-tr:hover .n-data-table-td) {
  background: #fafafa;
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

.code-preview {
  max-height: 420px;
  overflow: auto;
}
</style>

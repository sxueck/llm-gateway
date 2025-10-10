<template>
  <div>
    <n-space vertical :size="24">
      <n-card title="路由配置管理">
        <template #header-extra>
          <n-space>
            <n-button type="primary" @click="handleCreateModalOpen">
              <template #icon>
                <n-icon><AddOutline /></n-icon>
              </template>
              创建配置
            </n-button>
            <n-button @click="handleRefresh">
              <template #icon>
                <n-icon><RefreshOutline /></n-icon>
              </template>
              刷新
            </n-button>
          </n-space>
        </template>

        <n-data-table
          :columns="columns"
          :data="configs"
          :loading="loading"
          :pagination="{ pageSize: 10 }"
        />
      </n-card>
    </n-space>

    <n-modal v-model:show="showCreateModal" preset="card" :title="editingId ? '编辑路由配置' : '创建路由配置'" style="width: 700px">
      <RoutingConfigWizard
        v-model:config-type="configType"
        v-model:form-value="formValue"
        :provider-options="providerOptions"
        :get-model-options-by-provider="getModelOptionsByProvider"
        :status-code-options="statusCodeOptions"
        @save="handleSave"
        @cancel="showCreateModal = false"
        :saving="saving"
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
} from 'naive-ui';
import {
  AddOutline,
  RefreshOutline,
  CopyOutline,
  EyeOutline,
  TrashOutline,
} from '@vicons/ionicons5';
import { useProviderStore } from '@/stores/provider';
import { useModelStore } from '@/stores/model';
import { configApi } from '@/api/config';
import RoutingConfigWizard from '@/components/RoutingConfigWizard.vue';

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
  createVirtualModel: false,
  virtualModelName: '',
  providerId: '',
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
    .filter(m => m.providerId === providerId && m.enabled)
    .map(m => ({
      label: m.name,
      value: m.id,
    }));
}

const columns = [
  { title: '配置名称', key: 'name' },
  { title: '类型', key: 'type', render: (row: any) => h(NTag, { type: row.type === 'loadbalance' ? 'info' : 'warning' }, { default: () => row.type === 'loadbalance' ? '负载均衡' : '故障转移' }) },
  { title: '目标数量', key: 'targetCount' },
  { title: '描述', key: 'description', ellipsis: { tooltip: true } },
  {
    title: '操作',
    key: 'actions',
    render: (row: any) => h(NSpace, null, {
      default: () => [
        h(NButton, { text: true, onClick: () => handlePreview(row) }, { default: () => '预览', icon: () => h(NIcon, null, { default: () => h(EyeOutline) }) }),
        h(NButton, { text: true, onClick: () => handleEdit(row) }, { default: () => '编辑' }),
        h(NPopconfirm, { onPositiveClick: () => handleDelete(row.id) }, {
          default: () => '确定删除此配置？',
          trigger: () => h(NButton, { text: true, type: 'error' }, { default: () => '删除', icon: () => h(NIcon, null, { default: () => h(TrashOutline) }) }),
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
        name: formValue.value.name,
        description: formValue.value.description,
        type: configType.value,
        config: config,
        virtualModelName: formValue.value.virtualModelName,
      });
      message.success('配置已更新');
    } else {
      const result = await configApi.createRoutingConfig({
        name: formValue.value.name,
        description: formValue.value.description,
        type: configType.value,
        config: config,
        createVirtualModel: formValue.value.createVirtualModel,
        virtualModelName: formValue.value.virtualModelName,
        providerId: formValue.value.providerId,
      });

      if (result.virtualModel) {
        message.success(`配置已保存，虚拟模型 "${result.virtualModel.name}" 已创建`);
      } else {
        message.success('配置已保存');
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

function handlePreview(row: any) {
  previewConfig.value = JSON.stringify(row.config, null, 2);
  showPreviewModal.value = true;
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
    createVirtualModel: !!virtualModel,
    virtualModelName: virtualModel?.name || '',
    providerId: virtualModel?.providerId || '',
  };

  showCreateModal.value = true;
}

async function handleDelete(id: string) {
  try {
    await configApi.deleteRoutingConfig(id);
    message.success('配置已删除');
    await loadConfigs();
  } catch (error: any) {
    message.error(error.message);
  }
}

function handleCopyConfig() {
  navigator.clipboard.writeText(previewConfig.value);
  message.success('配置已复制到剪贴板');
}

function resetForm() {
  editingId.value = null;
  formValue.value = {
    name: '',
    description: '',
    targets: [],
    createVirtualModel: false,
    virtualModelName: '',
    providerId: '',
  };
}

async function loadConfigs() {
  try {
    loading.value = true;
    const result = await configApi.getRoutingConfigs();
    configs.value = result.configs.map(c => ({
      ...c,
      targetCount: c.config.targets?.length || 0,
    }));
  } catch (error: any) {
    message.error(error.message);
  } finally {
    loading.value = false;
  }
}

// 刷新数据的函数
async function refreshData() {
  await Promise.all([
    providerStore.fetchProviders(),
    modelStore.fetchModels(),
  ]);
}

function handleCreateModalOpen() {
  resetForm();
  showCreateModal.value = true;
  refreshData();
}

// 刷新所有数据
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
.code-preview {
  max-height: 420px;
  overflow: auto;
}
</style>


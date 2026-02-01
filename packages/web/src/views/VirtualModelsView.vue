<template>
  <div class="virtual-models-view">
    <n-space vertical :size="24">
      <n-space justify="space-between" align="center">
        <div>
          <h2 class="page-title">智能路由</h2>
          <p class="page-subtitle">通过负载均衡或故障转移配置，将请求智能分发到多个实际模型，提高可用性和性能</p>
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

      <div v-if="loading" class="loading-state">
        <n-spin size="large" />
      </div>

      <div v-else-if="configs.length === 0" class="empty-state">
        <n-empty description="暂无智能路由配置">
          <template #extra>
            <n-button size="small" @click="handleCreateModalOpen">
              创建第一个路由
            </n-button>
          </template>
        </n-empty>
      </div>

      <n-grid v-else x-gap="16" y-gap="16" cols="1 640:2 960:3 1280:4" responsive="screen">
        <n-grid-item v-for="config in configs" :key="config.id">
          <RoutingConfigCard
            :config="config"
            :providers="providerStore.providers"
            :models="modelStore.models"
            @edit="handleEdit"
            @preview="handlePreview"
            @delete="handleDelete"
          />
        </n-grid-item>
      </n-grid>
    </n-space>

    <n-modal
      v-model:show="showCreateModal"
      preset="card"
      :title="editingId ? '编辑智能路由' : '创建智能路由'"
      class="virtual-model-modal"
      :style="{ width: '1000px', maxHeight: '90vh' }"
      :segmented="{
        content: 'soft',
        footer: 'soft'
      }"
    >
        <div class="modal-content-wrapper-no-padding">
          <RoutingConfigEditor
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
        </div>
      </n-modal>

    <n-modal
      v-model:show="showPreviewModal"
      preset="card"
      title="配置预览"
      class="preview-modal"
      :style="{ width: '700px', maxHeight: '85vh' }"
      :segmented="{
        content: 'soft',
        footer: 'soft'
      }"
    >
      <div class="modal-content-wrapper">
        <div class="code-preview">
          <n-code :code="previewConfig" />
        </div>
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
import { ref, computed, onMounted } from 'vue';
import {
  useMessage,
  NSpace,
  NButton,
  NIcon,
  NModal,
  NCode,
  NGrid,
  NGridItem,
  NSpin,
  NEmpty,
} from 'naive-ui';
import {
  AddOutline,
  RefreshOutline,
  CopyOutline,
} from '@vicons/ionicons5';
import { useProviderStore } from '@/stores/provider';
import { useModelStore } from '@/stores/model';
import { configApi } from '@/api/config';
import RoutingConfigEditor from '@/components/RoutingConfigEditor.vue';
import RoutingConfigCard from '@/components/RoutingConfigCard.vue';
import { copyToClipboard } from '@/utils/common';
import { createDefaultVirtualModelForm, type VirtualModelFormValue, type RoutingConfigType } from '@/types/virtual-model';

const message = useMessage();
const providerStore = useProviderStore();
const modelStore = useModelStore();

const loading = ref(false);
const saving = ref(false);
const showCreateModal = ref(false);
const showPreviewModal = ref(false);
const configType = ref<RoutingConfigType>('loadbalance');
const configs = ref<any[]>([]);
const previewConfig = ref('');
const editingId = ref<string | null>(null);

const formValue = ref<VirtualModelFormValue>(createDefaultVirtualModelForm());

const statusCodeOptions = [
  { label: '401 - 未授权', value: 401 },
  { label: '403 - 禁止访问', value: 403 },
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
      value: m.modelIdentifier,
    }));
}

function generateRoutingConfig() {
  const strategy: any = {
    mode: configType.value,
  };

  // Hash 模式的特殊配置
  if (configType.value === 'hash') {
    strategy.hashSource = formValue.value.hashSource || 'virtualKey';
  }

  // Affinity 模式的特殊配置
  if (configType.value === 'affinity') {
    // 将秒转换为毫秒
    strategy.affinityTTL = (formValue.value.affinityTTLSeconds || 300) * 1000;
  }

  const config: any = {
    strategy,
    targets: formValue.value.targets.map(target => {
      const targetConfig: any = {
        provider: target.providerId,
      };

      // loadbalance, hash, affinity 模式都支持权重
      if (['loadbalance', 'hash', 'affinity'].includes(configType.value) && target.weight !== undefined) {
        targetConfig.weight = target.weight;
      }

      if (target.modelName) {
        targetConfig.override_params = {
          model: target.modelName,
        };
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
    const config = generateRoutingConfig();

    if (editingId.value) {
      await configApi.updateRoutingConfig(editingId.value, {
        name: formValue.value.virtualModelName || formValue.value.name,
        description: formValue.value.description,
        type: configType.value,
        config: config,
        virtualModelName: formValue.value.virtualModelName,
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
    targets: row.config.targets.map((target: any) => ({
      providerId: target.provider,
      modelName: target.override_params?.model || '',
      weight: target.weight,
      onStatusCodes: target.on_status_codes || [],
    })),
    createVirtualModel: true,
    virtualModelName: virtualModel?.name || '',
    hashSource: row.config.strategy?.hashSource || 'virtualKey',
    affinityTTLSeconds: row.config.strategy?.affinityTTL ? row.config.strategy.affinityTTL / 1000 : 300,
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
  formValue.value = createDefaultVirtualModelForm();
  configType.value = 'loadbalance';
}

async function loadConfigs() {
  try {
    loading.value = true;
    const result = await configApi.getRoutingConfigs();
    configs.value = result.configs
      .filter(c => ['loadbalance', 'fallback', 'hash', 'affinity'].includes(c.type))
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
.virtual-models-view {
  max-width: 1400px;
  margin: 0 auto;
}

.page-title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  color: #1e3932;
  letter-spacing: -0.02em;
}

.page-subtitle {
  font-size: 14px;
  color: #8c8c8c;
  margin: 4px 0 0 0;
  font-weight: 400;
}

.loading-state,
.empty-state {
  padding: 40px;
  display: flex;
  justify-content: center;
  align-items: center;
}

.code-preview {
  max-height: 420px;
  overflow: auto;
}
.virtual-model-modal :deep(.n-card__content),
.preview-modal :deep(.n-card__content) {
  padding: 0;
  overflow: hidden;
}

    .modal-content-wrapper-no-padding {
  height: auto;
  max-height: calc(90vh - 140px);
  overflow: hidden;
}

.modal-content-wrapper {
  max-height: calc(85vh - 180px);
  overflow-y: auto;
  overflow-x: hidden;
  padding: 16px 20px;
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

.virtual-model-modal :deep(.n-card__footer),
.preview-modal :deep(.n-card__footer) {
  padding: 12px 20px;
  border-top: 1px solid #e8e8e8;
  background: #ffffff;
}
</style>

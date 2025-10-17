<template>
  <div class="compression-management">
    <n-space vertical :size="16">
      <n-space justify="space-between" align="center">
        <div>
          <h2 style="margin: 0; font-size: 20px; font-weight: 600;">上下文压缩管理</h2>
          <p style="margin: 4px 0 0 0; color: rgba(0, 0, 0, 0.45); font-size: 13px;">
            为模型配置上下文压缩策略,控制长对话的 Token 消耗
          </p>
        </div>
        <n-space :size="8">
          <n-button @click="handleRefresh" :loading="loading" size="small">
            <template #icon>
              <n-icon><RefreshOutline /></n-icon>
            </template>
            刷新
          </n-button>
          <n-button type="primary" @click="handleCreate" size="small">
            <template #icon>
              <n-icon><AddOutline /></n-icon>
            </template>
            配置压缩
          </n-button>
        </n-space>
      </n-space>

      <n-card class="table-card">
        <n-data-table
          :columns="columns"
          :data="filteredModels"
          :loading="loading"
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
      title="配置上下文压缩"
      :style="{ width: '700px' }"
    >
      <n-scrollbar style="max-height: 600px; padding-right: 12px;">
        <n-space vertical :size="16">
          <n-form-item v-if="!editingModel" label="选择模型" :show-feedback="false">
            <n-select
              v-model:value="selectedModelId"
              :options="virtualModelOptions"
              placeholder="选择要配置压缩的模型"
              filterable
            />
          </n-form-item>

          <n-alert v-if="editingModel" type="info" :bordered="false" size="small">
            模型: {{ editingModel?.name || '' }}
          </n-alert>

          <CompressionConfigEditor v-model="compressionConfig" :models="allModels" />
        </n-space>
      </n-scrollbar>
      <template #footer>
        <n-space justify="end" :size="8">
          <n-button @click="showModal = false" size="small">取消</n-button>
          <n-button type="primary" :loading="submitting" @click="handleSubmit" size="small">
            保存
          </n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, h, computed, onMounted } from 'vue';
import { useMessage, NSpace, NButton, NDataTable, NCard, NModal, NTag, NPopconfirm, NScrollbar, NIcon, NAlert, NSelect, NFormItem } from 'naive-ui';
import { EditOutlined, DeleteOutlined } from '@vicons/material';
import { RefreshOutline, AddOutline } from '@vicons/ionicons5';
import { useModelStore } from '@/stores/model';
import { modelApi } from '@/api/model';
import CompressionConfigEditor from '@/components/CompressionConfigEditor.vue';
import type { Model, CompressionConfig } from '@/types';

const message = useMessage();
const modelStore = useModelStore();

const loading = ref(false);
const showModal = ref(false);
const submitting = ref(false);
const editingModel = ref<Model | null>(null);
const selectedModelId = ref<string | null>(null);
const compressionConfig = ref<CompressionConfig | null>(null);

const allModels = computed(() => modelStore.models);

const virtualModels = computed(() => {
  return allModels.value.filter(m => m.isVirtual);
});

const filteredModels = computed(() => {
  return virtualModels.value.filter(m => m.compressionConfig && m.compressionConfig.enabled);
});

const virtualModelOptions = computed(() => {
  return virtualModels.value.map(m => ({
    label: m.name,
    value: m.id,
  }));
});

const columns = computed(() => [
  {
    title: '模型名称',
    key: 'name',
    width: 200,
  },
  {
    title: '状态',
    key: 'enabled',
    width: 80,
    render: (row: Model) => {
      return h(NTag, {
        type: row.enabled ? 'success' : 'default',
        size: 'small',
      }, {
        default: () => row.enabled ? '启用' : '禁用'
      });
    },
  },
  {
    title: 'Token 阈值',
    key: 'maxTokens',
    width: 120,
    render: (row: Model) => {
      return row.compressionConfig?.maxTokens?.toLocaleString() || '-';
    },
  },
  {
    title: '最小消息数',
    key: 'minMessages',
    width: 120,
    render: (row: Model) => {
      return row.compressionConfig?.minMessages || '-';
    },
  },
  {
    title: '保留 Token',
    key: 'keepRecentTokens',
    width: 120,
    render: (row: Model) => {
      return row.compressionConfig?.keepRecentTokens?.toLocaleString() || '-';
    },
  },
  {
    title: '压缩比例',
    key: 'compressionRatio',
    width: 100,
    render: (row: Model) => {
      const ratio = row.compressionConfig?.compressionRatio;
      return ratio ? `${(ratio * 100).toFixed(0)}%` : '-';
    },
  },
  {
    title: '摘要模型',
    key: 'summaryModel',
    ellipsis: {
      tooltip: true,
    },
    render: (row: Model) => {
      if (!row.compressionConfig?.summaryModelId) {
        return '简单压缩';
      }
      const model = allModels.value.find(m => m.id === row.compressionConfig?.summaryModelId);
      return model?.name || '未知模型';
    },
  },
  {
    title: '操作',
    key: 'actions',
    width: 200,
    render: (row: Model) => {
      return h(NSpace, { size: 4 }, {
        default: () => [
          h(
            NButton,
            {
              size: 'small',
              onClick: () => handleEdit(row),
              style: {
                borderRadius: '8px',
              },
            },
            {
              default: () => '编辑',
              icon: () => h(NIcon, null, { default: () => h(EditOutlined) }),
            }
          ),
          h(
            NPopconfirm,
            {
              onPositiveClick: () => handleDelete(row.id),
            },
            {
              default: () => '确定要删除此压缩配置吗?',
              trigger: () => h(
                NButton,
                {
                  size: 'small',
                  type: 'error',
                  text: true,
                },
                {
                  default: () => '删除',
                  icon: () => h(NIcon, null, { default: () => h(DeleteOutlined) }),
                }
              ),
            }
          ),
        ],
      });
    },
  },
]);

async function handleRefresh() {
  loading.value = true;
  try {
    await modelStore.fetchModels();
  } finally {
    loading.value = false;
  }
}

function handleCreate() {
  if (virtualModels.value.length === 0) {
    message.warning('没有可用的虚拟模型');
    return;
  }

  editingModel.value = null;
  selectedModelId.value = null;
  compressionConfig.value = {
    enabled: true,
    maxTokens: 30000,
    minMessages: 4,
    keepRecentTokens: 10000,
    compressionRatio: 0.3,
    summaryModelId: undefined,
    summaryPrompt: '',
  };
  showModal.value = true;
}

function handleEdit(model: Model) {
  editingModel.value = model;
  selectedModelId.value = null;
  if (model.compressionConfig) {
    compressionConfig.value = { ...model.compressionConfig };
  } else {
    compressionConfig.value = null;
  }
  showModal.value = true;
}

async function handleSubmit() {
  const targetModelId = editingModel.value?.id || selectedModelId.value;

  if (!targetModelId) {
    message.error('请选择模型');
    return;
  }

  try {
    submitting.value = true;
    await modelApi.update(targetModelId, {
      compressionConfig: compressionConfig.value,
    });

    const successMsg = editingModel.value ? '更新成功' : '创建成功';
    message.success(successMsg);

    showModal.value = false;
    await modelStore.fetchModels();
  } catch (error: any) {
    const errorMsg = editingModel.value ? '更新失败' : '创建失败';
    message.error(error.message || errorMsg);
  } finally {
    submitting.value = false;
  }
}

async function handleDelete(modelId: string) {
  try {
    await modelApi.update(modelId, {
      compressionConfig: null,
    });
    message.success('删除成功');
    await modelStore.fetchModels();
  } catch (error: any) {
    message.error(error.message || '删除失败');
  }
}

onMounted(() => {
  handleRefresh();
});
</script>

<style scoped>
.compression-management {
  padding: 24px;
}

.table-card {
  border-radius: 8px;
}
</style>


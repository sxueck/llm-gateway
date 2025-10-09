<template>
  <div class="models-view">
    <n-space vertical :size="12">
      <n-space justify="space-between" align="center">
        <h2 class="page-title">模型列表</h2>
        <n-button type="primary" size="small" @click="showModal = true">
          添加模型
        </n-button>
      </n-space>

      <n-card class="table-card">
        <n-data-table
          :columns="columns"
          :data="modelStore.models"
          :loading="modelStore.loading"
          :pagination="{ pageSize: 10 }"
          :bordered="false"
          size="small"
        />
      </n-card>
    </n-space>

    <n-modal
      v-model:show="showModal"
      preset="card"
      :title="editingId ? '编辑模型' : '添加模型'"
      class="model-modal"
      :style="{ width: '750px' }"
    >
      <n-scrollbar style="max-height: 65vh; padding-right: 12px;">
        <n-form ref="formRef" :model="formValue" :rules="rules" label-placement="left" label-width="100" size="small">
          <n-form-item label="模型名称" path="name">
            <n-input v-model:value="formValue.name" placeholder="如: GPT-4" size="small" />
          </n-form-item>
          <n-form-item label="所属提供商" path="providerId">
            <n-select v-model:value="formValue.providerId" :options="providerOptions" placeholder="选择提供商" size="small" />
          </n-form-item>
          <n-form-item label="模型标识符" path="modelIdentifier">
            <n-input
              v-model:value="formValue.modelIdentifier"
              placeholder="如: gpt-4, claude-3-opus"
              size="small"
            />
          </n-form-item>
          <n-form-item label="启用">
            <n-switch v-model:value="formValue.enabled" size="small" />
          </n-form-item>

          <n-divider style="margin: 12px 0 8px 0;">
            <n-space :size="8" align="center">
              <span>模型属性配置</span>
              <n-button
                size="tiny"
                type="primary"
                secondary
                @click.stop="showLiteLLMSelector = true"
              >
                从 LiteLLM 搜索
              </n-button>
            </n-space>
          </n-divider>

          <ModelAttributesEditor v-model="formValue.modelAttributes" />
        </n-form>
      </n-scrollbar>
      <template #footer>
        <n-space justify="end" :size="8">
          <n-button @click="showModal = false" size="small">取消</n-button>
          <n-button type="primary" :loading="submitting" @click="handleSubmit" size="small">
            {{ editingId ? '更新' : '创建' }}
          </n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal
      v-model:show="showLiteLLMSelector"
      preset="card"
      title="从 LiteLLM 预设库搜索模型"
      :style="{ width: '800px' }"
    >
      <LiteLLMPresetSelector @select="handleLiteLLMSelect" />
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, h, computed, onMounted } from 'vue';
import { useMessage, NSpace, NButton, NDataTable, NCard, NModal, NForm, NFormItem, NInput, NSelect, NSwitch, NTag, NPopconfirm, NDivider, NScrollbar } from 'naive-ui';
import { useModelStore } from '@/stores/model';
import { useProviderStore } from '@/stores/provider';
import { modelApi } from '@/api/model';
import { litellmPresetsApi } from '@/api/litellm-presets';
import ModelAttributesEditor from '@/components/ModelAttributesEditor.vue';
import LiteLLMPresetSelector from '@/components/LiteLLMPresetSelector.vue';
import type { Model, ModelAttributes } from '@/types';
import type { LiteLLMSearchResult } from '@/api/litellm-presets';

const message = useMessage();
const modelStore = useModelStore();
const providerStore = useProviderStore();

const showModal = ref(false);
const showLiteLLMSelector = ref(false);
const formRef = ref();
const submitting = ref(false);
const editingId = ref<string | null>(null);

const formValue = ref<{
  name: string;
  providerId: string;
  modelIdentifier: string;
  enabled: boolean;
  modelAttributes?: ModelAttributes;
}>({
  name: '',
  providerId: '',
  modelIdentifier: '',
  enabled: true,
  modelAttributes: undefined,
});

const rules = {
  name: [{ required: true, message: '请输入模型名称', trigger: 'blur' }],
  providerId: [{ required: true, message: '请选择提供商', trigger: 'change' }],
  modelIdentifier: [{ required: true, message: '请输入模型标识符', trigger: 'blur' }],
};

const providerOptions = computed(() => {
  return providerStore.providers
    .filter(p => p.enabled)
    .map(p => ({
      label: p.name,
      value: p.id,
    }));
});

const columns = [
  {
    title: '模型名称',
    key: 'name',
    render: (row: Model) => {
      if (row.isVirtual) {
        return h(NSpace, { align: 'center', size: 4 }, {
          default: () => [
            h('span', row.name),
            h(NTag, { type: 'info', size: 'small', round: true }, { default: () => '虚拟' }),
          ],
        });
      }
      return row.name;
    },
  },
  { title: '所属提供商', key: 'providerName' },
  { title: '模型标识符', key: 'modelIdentifier' },
  {
    title: '状态',
    key: 'enabled',
    render: (row: Model) => h(NTag, { type: row.enabled ? 'success' : 'default' }, { default: () => row.enabled ? '启用' : '禁用' }),
  },
  {
    title: '绑定密钥数',
    key: 'virtualKeyCount',
    render: (row: Model) => row.virtualKeyCount || 0,
  },
  {
    title: '操作',
    key: 'actions',
    render: (row: Model) => h(NSpace, null, {
      default: () => [
        h(NButton, { size: 'small', onClick: () => handleEdit(row), disabled: row.isVirtual }, { default: () => '编辑' }),
        h(NPopconfirm, {
          onPositiveClick: () => handleDelete(row.id),
        }, {
          trigger: () => h(NButton, { size: 'small', type: 'error' }, { default: () => '删除' }),
          default: () => row.isVirtual ? '确定删除此虚拟模型吗？删除后关联的路由配置将失效。' : '确定删除此模型吗？',
        }),
      ],
    }),
  },
];

function handleEdit(model: Model) {
  editingId.value = model.id;
  formValue.value = {
    name: model.name,
    providerId: model.providerId,
    modelIdentifier: model.modelIdentifier,
    enabled: model.enabled,
    modelAttributes: model.modelAttributes || undefined,
  };
  showModal.value = true;
}

async function handleDelete(id: string) {
  try {
    await modelApi.delete(id);
    message.success('删除成功');
    await modelStore.fetchModels();
  } catch (error: any) {
    message.error(error.message);
  }
}

async function handleSubmit() {
  try {
    await formRef.value?.validate();
    submitting.value = true;

    if (editingId.value) {
      await modelApi.update(editingId.value, {
        name: formValue.value.name,
        modelIdentifier: formValue.value.modelIdentifier,
        enabled: formValue.value.enabled,
        modelAttributes: formValue.value.modelAttributes,
      });
      message.success('更新成功');
    } else {
      await modelApi.create(formValue.value);
      message.success('创建成功');
    }

    showModal.value = false;
    resetForm();
    await modelStore.fetchModels();
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
  formValue.value = {
    name: '',
    providerId: '',
    modelIdentifier: '',
    enabled: true,
    modelAttributes: undefined,
  };
}



async function handleLiteLLMSelect(result: LiteLLMSearchResult) {
  try {
    const detail = await litellmPresetsApi.getModelDetail(result.modelName);

    if (!formValue.value.modelIdentifier) {
      formValue.value.modelIdentifier = result.modelName;
    }

    if (!formValue.value.name) {
      formValue.value.name = result.modelName;
    }

    formValue.value.modelAttributes = {
      ...formValue.value.modelAttributes,
      ...detail.attributes,
    };

    showLiteLLMSelector.value = false;
    message.success(`已应用 ${result.modelName} 的预设属性`);
  } catch (error: any) {
    message.error(error.message || '应用预设失败');
  }
}

onMounted(async () => {
  await Promise.all([
    modelStore.fetchModels(),
    providerStore.fetchProviders(),
  ]);
});
</script>

<style scoped>
.models-view {
  max-width: 1400px;
  margin: 0 auto;
}

.page-title {
  font-size: 20px;
  font-weight: 600;
  color: #262626;
  margin: 0;
}

.table-card {
  background: #ffffff;
  border-radius: 8px;
  border: 1px solid #e8e8e8;
  overflow-x: auto;
}

.model-modal :deep(.n-card) {
  background: #ffffff;
  border-radius: 8px;
  border: 1px solid #e8e8e8;
}

.model-modal :deep(.n-card__header) {
  padding: 16px 20px;
  border-bottom: 1px solid #e8e8e8;
}

.model-modal :deep(.n-card__content) {
  padding: 16px 20px;
  max-height: calc(50vh - 140px);
  overflow-y: auto;
}

.model-modal :deep(.n-card__content)::-webkit-scrollbar {
  width: 6px;
}

.model-modal :deep(.n-card__content)::-webkit-scrollbar-track {
  background: #f0f0f0;
  border-radius: 3px;
}

.model-modal :deep(.n-card__content)::-webkit-scrollbar-thumb {
  background: #d0d0d0;
  border-radius: 3px;
}

.model-modal :deep(.n-card__content)::-webkit-scrollbar-thumb:hover {
  background: #b0b0b0;
}

.model-modal :deep(.n-card__footer) {
  padding: 12px 20px;
  border-top: 1px solid #e8e8e8;
}
</style>


<template>
  <div class="models-view">
    <n-space vertical :size="12">
      <n-space justify="space-between" align="center">
        <div>
          <h2 class="page-title">{{ t('models.title') }}</h2>
          <p class="page-subtitle">{{ t('models.subtitle') }}</p>
        </div>
        <n-space :size="8">
          <n-button type="primary" size="small" @click="showModal = true">
            {{ t('models.addModel') }}
          </n-button>
          <n-button size="small" @click="showBatchModal = true">
            {{ t('models.batchAdd') }}
          </n-button>
        </n-space>
      </n-space>

      <n-card class="table-card">
        <template #header>
          <n-space justify="space-between" align="center">
            <n-space :size="12" align="center">
              <span style="font-size: 13px; color: #666;">{{ t('models.itemsPerPage') }}</span>
              <n-select
                v-model:value="pageSize"
                :options="pageSizeOptions"
                size="small"
                style="width: 100px;"
              />
            </n-space>
            <n-space :size="12" align="center">
              <span style="font-size: 13px; color: #666;">{{ t('models.groupByProvider') }}</span>
              <n-switch v-model:value="groupByProvider" size="small" />
            </n-space>
          </n-space>
        </template>

        <div v-if="groupByProvider">
          <div v-for="group in groupedModels" :key="group.providerId" class="provider-group">
            <div class="provider-group-header">
              <span class="provider-name">{{ group.providerName }}</span>
              <span class="model-count">{{ t('models.modelCount', { count: group.models.length }) }}</span>
            </div>
            <n-data-table
              :columns="columns"
              :data="group.models"
              :loading="modelStore.loading"
              :pagination="false"
              :bordered="false"
              size="small"
            />
          </div>
        </div>

        <n-data-table
          v-else
          :columns="columns"
          :data="modelStore.models"
          :loading="modelStore.loading"
          :pagination="paginationConfig"
          :bordered="false"
          size="small"
          :max-height="calculateTableHeight()"
        />
      </n-card>
    </n-space>

    <n-modal
      v-model:show="showModal"
      preset="card"
      :title="editingId ? t('models.editModel') : t('models.addModel')"
      class="model-modal"
      :style="{ width: '750px' }"
    >
      <n-scrollbar style="max-height: 65vh; padding-right: 12px;">
        <n-form ref="formRef" :model="formValue" :rules="rules" label-placement="left" label-width="100" size="small">
          <n-form-item :label="t('models.modelName')" path="name">
            <n-input v-model:value="formValue.name" :placeholder="t('models.modelNamePlaceholder')" size="small" />
          </n-form-item>
          <n-form-item :label="t('models.provider')" path="providerId">
            <n-select v-model:value="formValue.providerId" :options="providerOptions" :placeholder="t('models.selectProvider')" size="small" />
          </n-form-item>
          <n-form-item :label="t('models.modelId')" path="modelIdentifier">
            <n-input
              v-model:value="formValue.modelIdentifier"
              :placeholder="t('models.modelIdPlaceholder')"
              size="small"
            />
          </n-form-item>
          <n-form-item :label="t('common.enabled')">
            <n-switch v-model:value="formValue.enabled" size="small" />
          </n-form-item>

          <n-divider style="margin: 12px 0 8px 0;">
            <n-space :size="8" align="center">
              <span>{{ t('models.modelAttributes') }}</span>
              <n-button
                size="tiny"
                @click.stop="showLiteLLMSelector = true"
              >
                {{ t('models.searchFromLiteLLM') }}
              </n-button>
            </n-space>
          </n-divider>

          <ModelAttributesEditor v-model="formValue.modelAttributes" />
        </n-form>
      </n-scrollbar>
      <template #footer>
        <n-space justify="end" :size="8">
          <n-button @click="showModal = false" size="small">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :loading="submitting" @click="handleSubmit" size="small">
            {{ editingId ? t('common.update') : t('common.create') }}
          </n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal
      v-model:show="showLiteLLMSelector"
      preset="card"
      :title="t('models.searchFromLiteLLMTitle')"
      :style="{ width: '800px' }"
    >
      <LiteLLMPresetSelector @select="handleLiteLLMSelect" />
    </n-modal>

    <n-modal
      v-model:show="showBatchModal"
      preset="card"
      :title="t('models.batchAddTitle')"
      :style="{ width: '900px' }"
    >
      <n-space vertical :size="16">
        <n-form-item :label="t('models.selectProvider')" :rule="{ required: true, message: t('validation.providerRequired') }">
          <n-select
            v-model:value="batchProviderId"
            :options="providerOptions"
            :placeholder="t('models.selectProvider')"
            size="small"
          />
        </n-form-item>

        <BatchModelAdder
          v-if="batchProviderId"
          ref="batchAdderRef"
          :provider-id="batchProviderId"
          @create="handleBatchCreate"
        />
      </n-space>

      <template #footer>
        <n-space justify="end" :size="8">
          <n-button @click="closeBatchModal" size="small">{{ t('common.cancel') }}</n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal
      v-model:show="showTestModal"
      preset="card"
      :title="t('models.testModel')"
      :style="{ width: '700px' }"
    >
      <ModelTester v-if="testingModel" :model="testingModel" />
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, h, computed, onMounted } from 'vue';
import { useMessage, NSpace, NButton, NDataTable, NCard, NModal, NForm, NFormItem, NInput, NSelect, NSwitch, NTag, NPopconfirm, NDivider, NScrollbar, NIcon } from 'naive-ui';
import { EditOutlined, DeleteOutlined, KeyboardCommandKeyOutlined } from '@vicons/material';
import { useI18n } from 'vue-i18n';
import { useModelStore } from '@/stores/model';
import { useProviderStore } from '@/stores/provider';
import { modelApi } from '@/api/model';
import { litellmPresetsApi } from '@/api/litellm-presets';
import ModelAttributesEditor from '@/components/ModelAttributesEditor.vue';
import LiteLLMPresetSelector from '@/components/LiteLLMPresetSelector.vue';
import BatchModelAdder from '@/components/BatchModelAdder.vue';
import ModelTester from '@/components/ModelTester.vue';
import type { Model, ModelAttributes } from '@/types';
import type { LiteLLMSearchResult } from '@/api/litellm-presets';

const { t } = useI18n();
const message = useMessage();
const modelStore = useModelStore();
const providerStore = useProviderStore();

const showModal = ref(false);
const showLiteLLMSelector = ref(false);
const showBatchModal = ref(false);
const showTestModal = ref(false);
const formRef = ref();
const batchAdderRef = ref();
const submitting = ref(false);
const editingId = ref<string | null>(null);
const batchProviderId = ref<string>('');
const testingModel = ref<Model | null>(null);
const pageSize = ref(20);
const groupByProvider = ref(false);

const pageSizeOptions = [
  { label: t('models.pageSizeOptions.10'), value: 10 },
  { label: t('models.pageSizeOptions.20'), value: 20 },
  { label: t('models.pageSizeOptions.50'), value: 50 },
  { label: t('models.pageSizeOptions.100'), value: 100 },
];

const paginationConfig = computed(() => ({
  pageSize: pageSize.value,
}));

const groupedModels = computed(() => {
  if (!groupByProvider.value) {
    return [];
  }

  const groups = new Map<string, { providerId: string; providerName: string; models: Model[] }>();

  modelStore.models.forEach(model => {
    const providerId = model.providerId || 'virtual';
    const providerName = model.providerName || t('models.virtualModel');

    if (!groups.has(providerId)) {
      groups.set(providerId, {
        providerId,
        providerName,
        models: [],
      });
    }

    groups.get(providerId)!.models.push(model);
  });

  return Array.from(groups.values()).sort((a, b) => {
    if (a.providerId === 'virtual') return 1;
    if (b.providerId === 'virtual') return -1;
    return a.providerName.localeCompare(b.providerName);
  });
});

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

const rules = computed(() => ({
  name: [{ required: true, message: t('validation.modelNameRequired'), trigger: 'blur' }],
  providerId: [{ required: true, message: t('validation.providerRequired'), trigger: 'change' }],
  modelIdentifier: [{ required: true, message: t('validation.modelIdRequired'), trigger: 'blur' }],
}));

const providerOptions = computed(() => {
  return providerStore.providers
    .filter(p => p.enabled)
    .map(p => ({
      label: p.name,
      value: p.id,
    }));
});

const columns = computed(() => [
  {
    title: t('models.modelName'),
    key: 'name',
    render: (row: Model) => {
      if (row.isVirtual) {
        const tags: any[] = [];
        if (row.expertRoutingId) {
          tags.push(h(NTag, { type: 'warning', size: 'small', round: true }, { default: () => t('models.expertModel') }));
        } else {
          tags.push(h(NTag, { type: 'info', size: 'small', round: true }, { default: () => t('menu.virtualModels') }));
        }
        return h(NSpace, { align: 'center', size: 4 }, {
          default: () => [
            h('span', row.name),
            ...tags,
          ],
        });
      }
      return row.name;
    },
  },
  { title: t('models.provider'), key: 'providerName' },
  { title: t('models.modelId'), key: 'modelIdentifier' },
  {
    title: t('models.routingGateway'),
    key: 'routingGateway',
    render: (row: Model) => {
      if (row.isVirtual) {
        return h('span', { style: { color: '#999' } }, '-');
      }
      if (row.routingGateway) {
        return h(NTag, { type: 'success', size: 'small' }, {
          default: () => row.routingGateway!.name
        });
      }
      return h('span', { style: { color: '#999' } }, t('models.notConfigured'));
    },
  },
  {
    title: t('common.status'),
    key: 'enabled',
    render: (row: Model) => h(NTag, { type: row.enabled ? 'success' : 'default' }, { default: () => row.enabled ? t('common.enabled') : t('common.disabled') }),
  },
  {
    title: t('models.virtualKeyCount'),
    key: 'virtualKeyCount',
    render: (row: Model) => row.virtualKeyCount || 0,
  },
  {
    title: t('common.actions'),
    key: 'actions',
    width: 150,
    render: (row: Model) => h(NSpace, { size: 6 }, {
      default: () => [
        h(NButton, {
          size: 'small',
          quaternary: true,
          circle: true,
          onClick: () => handleTest(row),
          disabled: row.isVirtual,
        }, {
          icon: () => h(NIcon, null, { default: () => h(KeyboardCommandKeyOutlined) }),
        }),
        h(NButton, {
          size: 'small',
          quaternary: true,
          circle: true,
          onClick: () => handleEdit(row),
          disabled: row.isVirtual,
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
          default: () => row.isVirtual ? t('models.deleteVirtualModelConfirm') : t('models.deleteConfirm'),
        }),
      ],
    }),
  },
]);

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
    message.success(t('models.deleteSuccess'));
    await modelStore.fetchModels();
  } catch (error: any) {
    message.error(error.message);
  }
}

async function handleSubmit() {
  try {
    await formRef.value?.validate();
    submitting.value = true;

    const payload = {
      name: formValue.value.name,
      modelIdentifier: formValue.value.modelIdentifier,
      enabled: formValue.value.enabled,
      modelAttributes: formValue.value.modelAttributes,
    };

    if (editingId.value) {
      await modelApi.update(editingId.value, payload);
      message.success(t('models.updateSuccess'));
    } else {
      await modelApi.create({
        ...payload,
        providerId: formValue.value.providerId,
      });
      message.success(t('models.createSuccess'));
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
    message.success(t('models.presetApplied', { modelName: result.modelName }));
  } catch (error: any) {
    message.error(error.message || t('models.presetApplyFailed'));
  }
}

async function handleBatchCreate(models: any[]) {
  try {
    const modelsToCreate = models.map(model => ({
      name: model.name,
      providerId: batchProviderId.value,
      modelIdentifier: model.modelIdentifier,
      enabled: model.enabled,
      modelAttributes: undefined,
    }));

    await modelApi.batchCreate(modelsToCreate);
    message.success(t('models.batchCreateSuccess', { count: modelsToCreate.length }));

    closeBatchModal();
    await modelStore.fetchModels();
  } catch (error: any) {
    message.error(error.message || t('models.batchCreateFailed'));
  }
}

function closeBatchModal() {
  showBatchModal.value = false;
  batchProviderId.value = '';
  batchAdderRef.value?.clearModels();
}

function handleTest(model: Model) {
  if (model.isVirtual) {
    message.warning(t('models.testWarning'));
    return;
  }
  testingModel.value = model;
  showTestModal.value = true;
}

function calculateTableHeight() {
  const rowHeight = 42;
  const headerHeight = 42;
  const paginationHeight = 48;
  const margin = 20;
  
  return pageSize.value * rowHeight + headerHeight + paginationHeight + margin;
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

.table-card :deep(.n-card__header) {
  padding: 16px 20px;
  border-bottom: 1px solid #e8e8e8;
}

.provider-group {
  margin-bottom: 24px;
}

.provider-group:last-child {
  margin-bottom: 0;
}

.provider-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: #f5f5f5;
  border-radius: 8px;
  margin-bottom: 12px;
}

.provider-name {
  font-size: 14px;
  font-weight: 600;
  color: #262626;
}

.model-count {
  font-size: 12px;
  color: #8c8c8c;
}
</style>


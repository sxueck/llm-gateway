<template>
  <div>
    <n-card :title="t('promptManagement.title')">
      <template #header-extra>
        <n-space :size="8">
          <n-input
            v-model:value="searchQuery"
            :placeholder="t('promptManagement.searchPlaceholder')"
            clearable
            size="small"
            style="width: 250px;"
          >
            <template #prefix>
              <n-icon><SearchOutline /></n-icon>
            </template>
          </n-input>
          <n-button type="primary" size="small" @click="handleRefresh">
            <template #icon>
              <n-icon><RefreshOutline /></n-icon>
            </template>
            {{ t('common.refresh') }}
          </n-button>
        </n-space>
      </template>

      <n-data-table
        :columns="columns"
        :data="filteredModels"
        :pagination="pagination"
        :loading="loading"
        size="small"
      />
    </n-card>

    <n-modal
      v-model:show="showModal"
      preset="card"
      :title="editingModel ? t('promptManagement.editPrompt') : t('promptManagement.createPrompt')"
      :style="{ width: '600px' }"
    >
      <n-scrollbar style="max-height: 500px; padding-right: 12px;">
        <n-space vertical :size="16">
          <n-alert type="info" :bordered="false" size="small">
            {{ t('promptManagement.modelInfo', { name: editingModel?.name || '' }) }}
          </n-alert>

          <PromptConfigEditor v-model="promptConfig" />
        </n-space>
      </n-scrollbar>
      <template #footer>
        <n-space justify="end" :size="8">
          <n-button @click="showModal = false" size="small">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :loading="submitting" @click="handleSubmit" size="small">
            {{ t('common.save') }}
          </n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, h, computed, onMounted } from 'vue';
import { useMessage, NSpace, NButton, NDataTable, NCard, NModal, NInput, NTag, NPopconfirm, NScrollbar, NIcon, NAlert } from 'naive-ui';
import { EditOutlined, DeleteOutlined } from '@vicons/material';
import { SearchOutline, RefreshOutline } from '@vicons/ionicons5';
import { useI18n } from 'vue-i18n';
import { useModelStore } from '@/stores/model';
import { modelApi } from '@/api/model';
import PromptConfigEditor from '@/components/PromptConfigEditor.vue';
import type { Model, PromptConfig } from '@/types';

const { t } = useI18n();
const message = useMessage();
const modelStore = useModelStore();

const loading = ref(false);
const showModal = ref(false);
const submitting = ref(false);
const searchQuery = ref('');
const editingModel = ref<Model | null>(null);
const promptConfig = ref<PromptConfig | null>(null);

const pagination = {
  pageSize: 10,
};

const virtualModels = computed(() => {
  return modelStore.models.filter(m => m.isVirtual);
});

const filteredModels = computed(() => {
  if (!searchQuery.value) {
    return virtualModels.value;
  }
  const query = searchQuery.value.toLowerCase();
  return virtualModels.value.filter(m =>
    m.name.toLowerCase().includes(query) ||
    m.modelIdentifier.toLowerCase().includes(query)
  );
});

const columns = computed(() => [
  {
    title: t('promptManagement.modelName'),
    key: 'name',
    width: 200,
  },
  {
    title: t('promptManagement.modelIdentifier'),
    key: 'modelIdentifier',
    width: 200,
  },
  {
    title: t('promptManagement.promptStatus'),
    key: 'promptStatus',
    width: 120,
    render: (row: Model) => {
      if (row.promptConfig && row.promptConfig.enabled) {
        return h(NTag, { type: 'success', size: 'small' }, { default: () => t('promptManagement.enabled') });
      }
      return h(NTag, { type: 'default', size: 'small' }, { default: () => t('promptManagement.disabled') });
    },
  },
  {
    title: t('promptManagement.operationType'),
    key: 'operationType',
    width: 120,
    render: (row: Model) => {
      if (!row.promptConfig || !row.promptConfig.enabled) {
        return '-';
      }
      const typeMap: Record<string, string> = {
        replace: 'Replace',
        prepend: 'Prepend',
        system: 'System',
      };
      return typeMap[row.promptConfig.operationType] || '-';
    },
  },
  {
    title: t('promptManagement.templatePreview'),
    key: 'templatePreview',
    ellipsis: {
      tooltip: true,
    },
    render: (row: Model) => {
      if (!row.promptConfig || !row.promptConfig.enabled) {
        return '-';
      }
      const content = row.promptConfig.operationType === 'system'
        ? row.promptConfig.systemMessage
        : row.promptConfig.templateContent;
      return content || '-';
    },
  },
  {
    title: t('common.actions'),
    key: 'actions',
    width: 150,
    render: (row: Model) => {
      return h(NSpace, { size: 4 }, {
        default: () => [
          h(
            NButton,
            {
              size: 'small',
              type: 'primary',
              text: true,
              onClick: () => handleEdit(row),
            },
            {
              default: () => t('common.edit'),
              icon: () => h(NIcon, null, { default: () => h(EditOutlined) }),
            }
          ),
          row.promptConfig && row.promptConfig.enabled
            ? h(
                NPopconfirm,
                {
                  onPositiveClick: () => handleDisable(row.id),
                },
                {
                  default: () => t('promptManagement.confirmDisable'),
                  trigger: () => h(
                    NButton,
                    {
                      size: 'small',
                      type: 'error',
                      text: true,
                    },
                    {
                      default: () => t('promptManagement.disable'),
                      icon: () => h(NIcon, null, { default: () => h(DeleteOutlined) }),
                    }
                  ),
                }
              )
            : null,
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

function handleEdit(model: Model) {
  editingModel.value = model;
  promptConfig.value = model.promptConfig ? { ...model.promptConfig } : {
    operationType: 'prepend',
    templateContent: '',
    systemMessage: '',
    enabled: true,
  };
  showModal.value = true;
}

async function handleSubmit() {
  if (!editingModel.value) return;

  try {
    submitting.value = true;
    await modelApi.update(editingModel.value.id, {
      promptConfig: promptConfig.value,
    });
    message.success(t('promptManagement.updateSuccess'));
    showModal.value = false;
    await modelStore.fetchModels();
  } catch (error: any) {
    message.error(error.message || t('promptManagement.updateFailed'));
  } finally {
    submitting.value = false;
  }
}

async function handleDisable(modelId: string) {
  try {
    await modelApi.update(modelId, {
      promptConfig: null,
    });
    message.success(t('promptManagement.disableSuccess'));
    await modelStore.fetchModels();
  } catch (error: any) {
    message.error(error.message || t('promptManagement.disableFailed'));
  }
}

onMounted(() => {
  handleRefresh();
});
</script>


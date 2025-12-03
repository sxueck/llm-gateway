<template>
  <div class="virtual-keys-view">
    <n-space vertical :size="12">
      <n-space justify="space-between" align="center">
        <div>
          <h2 class="page-title">虚拟密钥管理</h2>
          <p class="page-subtitle">创建和管理虚拟 API 密钥,用于访问 LLM Gateway。可以设置过期时间和使用限制</p>
        </div>
        <n-button type="primary" size="small" @click="showModal = true">
          创建虚拟密钥
        </n-button>
      </n-space>

      <n-card class="table-card">
        <n-data-table
          :columns="columns"
          :data="virtualKeyStore.virtualKeys"
          :loading="virtualKeyStore.loading"
          :pagination="{ pageSize: 10 }"
          :bordered="false"
          size="small"
        />
      </n-card>
    </n-space>

    <n-modal
      v-model:show="showModal"
      preset="card"
      :title="editingId ? '编辑虚拟密钥' : '创建虚拟密钥'"
      class="key-modal"
      :style="{ width: '600px', maxHeight: '85vh' }"
      :segmented="{
        content: 'soft',
        footer: 'soft'
      }"
    >
      <div class="modal-form-wrapper">
        <n-form ref="formRef" :model="formValue" :rules="rules" label-placement="left" label-width="90" size="small">
        <n-form-item label="密钥名称" path="name">
          <n-input v-model:value="formValue.name" placeholder="如: 生产环境密钥" size="small" />
        </n-form-item>
        <n-form-item label="关联模型" path="modelIds">
          <n-select
            v-model:value="formValue.modelIds"
            :options="modelOptions"
            placeholder="选择一个或多个模型"
            filterable
            multiple
            clearable
            size="small"
          />
        </n-form-item>
        <n-form-item v-if="!editingId" label="生成方式" path="keyType">
          <n-radio-group v-model:value="formValue.keyType" size="small">
            <n-space :size="12">
              <n-radio value="auto">自动生成</n-radio>
              <n-radio value="custom">自定义</n-radio>
            </n-space>
          </n-radio-group>
        </n-form-item>
        <n-form-item v-if="!editingId && formValue.keyType === 'custom'" label="自定义密钥" path="customKey">
          <n-input v-model:value="formValue.customKey" placeholder="8-64字符,仅支持字母、数字、下划线、连字符" size="small" />
        </n-form-item>
        <n-form-item label="速率限制" path="rateLimit">
          <n-input-number v-model:value="formValue.rateLimit" placeholder="请求/分钟" :min="0" style="width: 100%" size="small" />
        </n-form-item>
        <n-form-item label="启用缓存">
          <n-switch v-model:value="formValue.cacheEnabled" size="small" />
        </n-form-item>
        <n-form-item label="禁用日志">
          <n-switch v-model:value="formValue.disableLogging" size="small" />
        </n-form-item>
        <n-form-item label="动态压缩">
          <n-space vertical :size="4">
            <n-switch v-model:value="formValue.dynamicCompressionEnabled" size="small" />
            <span style="font-size: 12px; color: #999;">自动压缩历史消息中的重复内容,节省 Token</span>
          </n-space>
        </n-form-item>
        <n-form-item label="拦截空温度">
          <n-space vertical :size="4">
            <n-space :size="12" align="center">
              <n-switch v-model:value="formValue.interceptZeroTemperature" size="small" />
              <n-input-number
                v-model:value="formValue.zeroTemperatureReplacement"
                :disabled="!formValue.interceptZeroTemperature"
                :min="0"
                :max="2"
                :step="0.1"
                placeholder="例如: 0.7"
                style="width: 150px"
                size="small"
              />
            </n-space>
            <span style="font-size: 12px; color: #999;">开启后,将传入的 temperature=0 替换为指定值</span>
          </n-space>
        </n-form-item>
        <n-form-item label="启用">
          <n-switch v-model:value="formValue.enabled" size="small" />
        </n-form-item>
      </n-form>
      </div>
      <template #footer>
        <n-space justify="end" :size="8">
          <n-button @click="showModal = false" size="small">取消</n-button>
          <n-button type="primary" :loading="submitting" @click="handleSubmit" size="small">
            {{ editingId ? '更新' : '创建' }}
          </n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal v-model:show="showKeyModal" preset="card" title="虚拟密钥已创建" style="width: 500px">
      <n-space vertical>
        <n-alert type="success">
          密钥创建成功！请妥善保管密钥值。
        </n-alert>
        <n-input-group>
          <n-input :value="createdKeyValue" readonly />
          <n-button @click="copyKey">复制</n-button>
        </n-input-group>
      </n-space>
      <template #footer>
        <n-space justify="end">
          <n-button type="primary" @click="showKeyModal = false">确定</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, h, onMounted, watch } from 'vue';
import {
  useMessage,
  NSpace,
  NButton,
  NDataTable,
  NCard,
  NModal,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSwitch,
  NTag,
  NPopconfirm,
  NSelect,
  NRadioGroup,
  NRadio,
  NAlert,
  NInputGroup,
  NIcon,
} from 'naive-ui';
import { EditOutlined, DeleteOutlined, ContentCopyOutlined } from '@vicons/material';
import { useVirtualKeyStore } from '@/stores/virtual-key';
import { useModelStore } from '@/stores/model';
import { useModelOptions } from '@/composables/useModelOptions';
import { virtualKeyApi } from '@/api/virtual-key';
import type { VirtualKey } from '@/types';
import { copyToClipboard } from '@/utils/common';
import { createDefaultVirtualKeyForm } from '@/types/virtual-key';

const message = useMessage();
const virtualKeyStore = useVirtualKeyStore();
const modelStore = useModelStore();

const showModal = ref(false);
const showKeyModal = ref(false);
const formRef = ref();
const submitting = ref(false);
const editingId = ref<string | null>(null);
const createdKeyValue = ref('');

const formValue = ref(createDefaultVirtualKeyForm());

const { modelOptions } = useModelOptions({
  uniqueByIdentifier: false,
  labelStyle: 'nameWithProvider',
  valueField: 'id',
});

const rules = {
  name: [{ required: true, message: '请输入密钥名称', trigger: 'blur' }],
  modelIds: [
    {
      required: true,
      validator: (_rule: any, value: string[]) => {
        if (!value || value.length === 0) {
          return new Error('请至少选择一个模型');
        }
        return true;
      },
      trigger: 'change',
    },
  ],
  customKey: [
    {
      required: true,
      validator: (_rule: any, value: string) => {
        if (formValue.value.keyType === 'custom' && !value) {
          return new Error('请输入自定义密钥');
        }
        return true;
      },
      trigger: 'blur',
    },
  ],
};

const columns = [
  { title: '名称', key: 'name' },
  { title: '密钥值', key: 'keyValue', ellipsis: { tooltip: true } },
  {
    title: '关联模型',
    key: 'modelIds',
    render: (row: VirtualKey) => {
      const modelIds: string[] = [];
      if (row.modelId) modelIds.push(row.modelId);
      if (row.modelIds && Array.isArray(row.modelIds)) {
        modelIds.push(...row.modelIds);
      }

      const uniqueModelIds = [...new Set(modelIds)];
      if (uniqueModelIds.length === 0) return '-';

      const models = uniqueModelIds.map(id => modelStore.models.find(m => m.id === id)).filter(Boolean);

      return h(NSpace, { size: 4, wrap: true }, {
        default: () => {
          const max = 5;
          const tags = models.slice(0, max).map(model => {
            if (!model) return null;
            if (model.isVirtual) {
              return h(NTag, { type: 'info', size: 'small', round: true }, { default: () => model.name });
            }
            return h(NTag, { type: 'default', size: 'small' }, { default: () => model.name });
          }).filter(Boolean);
          const remaining = models.length - max;
          if (remaining > 0) {
            tags.push(h(NTag, { type: 'default', size: 'small' }, { default: () => `+${remaining}` }));
          }
          return tags;
        },
      });
    },
  },
  {
    title: '状态',
    key: 'enabled',
    render: (row: VirtualKey) => h(NTag, { type: row.enabled ? 'success' : 'default' }, { default: () => row.enabled ? '启用' : '禁用' }),
  },
  {
    title: '缓存',
    key: 'cacheEnabled',
    render: (row: VirtualKey) => {
      if (!row.cacheEnabled) {
        return h(NTag, { type: 'default', size: 'small' }, { default: () => '未启用' });
      }
      return h(NTag, { type: 'success', size: 'small' }, { default: () => '已启用' });
    },
  },
  {
    title: '日志记录',
    key: 'disableLogging',
    render: (row: VirtualKey) => {
      if (row.disableLogging) {
        return h(NTag, { type: 'warning', size: 'small' }, { default: () => '已禁用' });
      }
      return h(NTag, { type: 'success', size: 'small' }, { default: () => '已启用' });
    },
  },
  {
    title: '速率限制',
    key: 'rateLimit',
    render: (row: VirtualKey) => row.rateLimit ? `${row.rateLimit} 请求/分钟` : '-',
  },
  {
    title: '操作',
    key: 'actions',
    width: 150,
    render: (row: VirtualKey) => h(NSpace, { size: 6 }, {
      default: () => [
        h(NButton, {
          size: 'small',
          quaternary: true,
          circle: true,
          onClick: () => copyKeyValue(row.keyValue),
        }, {
          icon: () => h(NIcon, null, { default: () => h(ContentCopyOutlined) }),
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
          default: () => '确定删除此虚拟密钥吗？',
        }),
      ],
    }),
  },
];

function handleEdit(vk: VirtualKey) {
  editingId.value = vk.id;
  const modelIds: string[] = [];
  if (vk.modelId) modelIds.push(vk.modelId);
  if (vk.modelIds && Array.isArray(vk.modelIds)) {
    modelIds.push(...vk.modelIds);
  }

  formValue.value = {
    name: vk.name,
    modelIds: [...new Set(modelIds)],
    keyType: 'auto',
    customKey: '',
    rateLimit: vk.rateLimit || undefined,
    enabled: vk.enabled,
    cacheEnabled: vk.cacheEnabled,
    disableLogging: vk.disableLogging,
    dynamicCompressionEnabled: vk.dynamicCompressionEnabled,
    interceptZeroTemperature: vk.interceptZeroTemperature,
    zeroTemperatureReplacement: vk.zeroTemperatureReplacement || 0.7,
  };
  showModal.value = true;
}

async function handleDelete(id: string) {
  try {
    await virtualKeyApi.delete(id);
    message.success('删除成功');
    await virtualKeyStore.fetchVirtualKeys();
  } catch (error: any) {
    message.error(error.message);
  }
}

async function handleSubmit() {
  try {
    await formRef.value?.validate();
    submitting.value = true;

    if (editingId.value) {
      await virtualKeyApi.update(editingId.value, {
        name: formValue.value.name,
        modelIds: formValue.value.modelIds,
        enabled: formValue.value.enabled,
        rateLimit: formValue.value.rateLimit,
        cacheEnabled: formValue.value.cacheEnabled,
        disableLogging: formValue.value.disableLogging,
        interceptZeroTemperature: formValue.value.interceptZeroTemperature,
        zeroTemperatureReplacement: formValue.value.zeroTemperatureReplacement !== undefined
          ? Number(formValue.value.zeroTemperatureReplacement)
          : undefined,
        dynamicCompressionEnabled: formValue.value.dynamicCompressionEnabled,
      });
      message.success('更新成功');
      showModal.value = false;
    } else {
      const createData = {
        ...formValue.value,
        zeroTemperatureReplacement: formValue.value.zeroTemperatureReplacement !== undefined
          ? Number(formValue.value.zeroTemperatureReplacement)
          : undefined,
      };
      const result = await virtualKeyApi.create(createData);
      createdKeyValue.value = result.keyValue;
      showModal.value = false;
      showKeyModal.value = true;
    }

    resetForm();
    await virtualKeyStore.fetchVirtualKeys();
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
  formValue.value = createDefaultVirtualKeyForm();
}

function copyKeyValue(keyValue: string) {
  copyToClipboard(keyValue);
}

function copyKey() {
  copyToClipboard(createdKeyValue.value);
}

onMounted(async () => {
  await Promise.all([
    virtualKeyStore.fetchVirtualKeys(),
    modelStore.fetchModels(),
  ]);
});

watch(showModal, async (val) => {
  if (val) {
    await modelStore.fetchModels();
  }
});

</script>

<style scoped>
.virtual-keys-view {
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

.key-modal :deep(.n-card) {
  background: #ffffff;
  border-radius: 8px;
  border: 1px solid #e8e8e8;
}

.key-modal :deep(.n-card__header) {
  padding: 16px 20px;
  border-bottom: 1px solid #e8e8e8;
}

.key-modal :deep(.n-card__content) {
  padding: 0;
  overflow: hidden;
}

.modal-form-wrapper {
  max-height: calc(85vh - 180px);
  overflow-y: auto;
  overflow-x: hidden;
  padding: 16px 20px;
}

.modal-form-wrapper::-webkit-scrollbar {
  width: 6px;
}

.modal-form-wrapper::-webkit-scrollbar-track {
  background: #f0f0f0;
  border-radius: 3px;
}

.modal-form-wrapper::-webkit-scrollbar-thumb {
  background: #d0d0d0;
  border-radius: 3px;
}

.modal-form-wrapper::-webkit-scrollbar-thumb:hover {
  background: #b0b0b0;
}

.key-modal :deep(.n-card__footer) {
  padding: 12px 20px;
  border-top: 1px solid #e8e8e8;
  background: #ffffff;
}
</style>


<template>
  <div>
    <n-space vertical :size="24">
      <n-card :title="$t('healthMonitoring.title')">
        <n-space vertical :size="16">
          <!-- 启用持久监控 -->
          <n-space align="center" justify="space-between">
            <div>
              <div>{{ $t('healthMonitoring.enablePersistentMonitoring') }}</div>
              <n-text depth="3" style="font-size: 12px;">{{ $t('healthMonitoring.enablePersistentMonitoringDesc') }}</n-text>
            </div>
            <n-switch :value="persistentMonitoringEnabled" @update:value="onTogglePersistentMonitoring" />
          </n-space>

          <n-alert v-if="!persistentMonitoringEnabled" type="warning">
            {{ $t('healthMonitoring.persistentMonitoringRequired') }}
          </n-alert>

          <!-- 开启公开监控页面 -->
          <n-space align="center" justify="space-between">
            <div>
              <div>{{ $t('healthMonitoring.enablePublicPage') }}</div>
              <n-text depth="3" style="font-size: 12px;">{{ $t('healthMonitoring.enablePublicPageDesc') }}</n-text>
            </div>
            <n-switch :value="healthMonitoringEnabled" :disabled="!persistentMonitoringEnabled" @update:value="onToggleHealthMonitoring" />
          </n-space>

          <n-alert v-if="healthMonitoringEnabled" type="info">
            <template #header>
            </template>
            <n-text style="font-size: 13px;">
              {{ $t('healthMonitoring.publicPageUrlDesc', { url: publicStatusUrl }) }}
            </n-text>
            <div style="margin-top: 8px;">
              <n-button text type="primary" @click="copyStatusUrl">
                {{ $t('common.copy') }}
              </n-button>
              <n-button text type="primary" @click="openStatusPage" style="margin-left: 8px;">
                {{ $t('healthMonitoring.openInNewTab') }}
              </n-button>
            </div>
          </n-alert>

          <n-divider style="margin: 8px 0;" />

          <!-- 监控目标配置 -->
          <div>
            <n-space justify="space-between" align="center" style="margin-bottom: 12px;">
              <div>
                <div style="font-size: 16px; font-weight: 500;">{{ $t('healthMonitoring.monitoredTargets') }}</div>
                <n-text depth="3" style="font-size: 12px;">{{ $t('healthMonitoring.monitoredTargetsDesc') }}</n-text>
              </div>
              <n-button type="primary" @click="showAddTargetModal = true">
                {{ $t('healthMonitoring.addTarget') }}
              </n-button>
            </n-space>

            <n-spin :show="loadingTargets">
              <n-data-table
                :columns="targetColumns"
                :data="healthTargets"
                :pagination="false"
                :bordered="false"
                size="small"
              />
            </n-spin>
          </div>
        </n-space>
      </n-card>
    </n-space>

    <!-- 添加监控目标弹窗 -->
    <n-modal
      v-model:show="showAddTargetModal"
      preset="dialog"
      :title="$t('healthMonitoring.addTarget')"
      :positive-text="$t('common.confirm')"
      :negative-text="$t('common.cancel')"
      @positive-click="handleAddTarget"
    >
      <n-form
        ref="addTargetFormRef"
        :model="addTargetForm"
        label-placement="left"
        label-width="120"
        style="margin-top: 16px;"
      >
        <n-form-item :label="$t('healthMonitoring.targetType')" path="type">
          <n-select
            v-model:value="addTargetForm.type"
            :options="targetTypeOptions"
            @update:value="handleTypeChange"
          />
        </n-form-item>

        <n-form-item :label="$t('healthMonitoring.selectModel')" path="target_id">
          <n-select
            v-model:value="addTargetForm.target_id"
            :options="availableModelsOptions"
            :loading="loadingModels"
            filterable
          />
        </n-form-item>

        <n-form-item :label="$t('healthMonitoring.checkInterval')" path="check_interval_seconds">
          <n-input-number
            v-model:value="addTargetForm.check_interval_seconds"
            :min="60"
            :max="3600"
            :step="60"
            style="width: 100%"
          >
            <template #suffix>{{ $t('healthMonitoring.seconds') }}</template>
          </n-input-number>
        </n-form-item>

        <n-form-item :label="$t('healthMonitoring.checkPrompt')" path="check_prompt">
          <n-input
            v-model:value="addTargetForm.check_prompt"
            type="textarea"
            :rows="2"
            :placeholder="$t('healthMonitoring.checkPromptPlaceholder')"
          />
        </n-form-item>
      </n-form>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import {
  NSpace,
  NCard,
  NSwitch,
  NAlert,
  NText,
  NButton,
  NDivider,
  NDataTable,
  NSpin,
  NModal,
  NForm,
  NFormItem,
  NSelect,
  NInputNumber,
  NInput,
  NTag,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { configApi } from '@/api/config';

const { t } = useI18n();
const message = useMessage();

const healthMonitoringEnabled = ref(false);
const persistentMonitoringEnabled = ref(false);
const loadingTargets = ref(false);
const loadingModels = ref(false);
const healthTargets = ref<any[]>([]);
const showAddTargetModal = ref(false);
const addTargetFormRef = ref();
const availableModels = ref<any[]>([]);
const availableVirtualModels = ref<any[]>([]);

const addTargetForm = ref({
  type: 'model' as 'model' | 'virtual_model',
  target_id: null as string | null,
  check_interval_seconds: 300,
  check_prompt: "Say 'OK'",
});

const publicStatusUrl = computed(() => {
  if (typeof window !== 'undefined') {
    return `${window.location.origin}/status`;
  }
  return '/status';
});

const targetTypeOptions = computed(() => [
  { label: t('healthMonitoring.realModel'), value: 'model' },
  { label: t('healthMonitoring.virtualModel'), value: 'virtual_model' },
]);

const availableModelsOptions = computed(() => {
  const models = addTargetForm.value.type === 'virtual_model'
    ? availableVirtualModels.value
    : availableModels.value;

  return models.map(m => ({
    label: m.name,
    value: m.id,
  }));
});

const targetColumns: DataTableColumns<any> = [
  {
    title: () => t('healthMonitoring.targetName'),
    key: 'name',
  },
  {
    title: () => t('healthMonitoring.targetType'),
    key: 'type',
    render(row) {
      return h(NTag, {
        type: row.type === 'virtual_model' ? 'info' : 'default',
        size: 'small',
      }, {
        default: () => row.type === 'virtual_model'
          ? t('healthMonitoring.virtualModel')
          : t('healthMonitoring.realModel')
      });
    },
  },
  {
    title: () => t('healthMonitoring.checkInterval'),
    key: 'check_interval_seconds',
    render(row) {
      return `${row.check_interval_seconds} ${t('healthMonitoring.seconds')}`;
    },
  },
  {
    title: () => t('common.status'),
    key: 'enabled',
    render(row) {
      return h(NTag, {
        type: row.enabled ? 'success' : 'default',
        size: 'small',
        bordered: false,
      }, {
        default: () => row.enabled ? t('common.enabled') : t('common.disabled')
      });
    },
  },
  {
    title: () => t('common.actions'),
    key: 'actions',
    render(row) {
      return h(NSpace, {}, {
        default: () => [
          h(NButton, {
            size: 'small',
            text: true,
            type: 'primary',
            onClick: () => toggleTargetEnabled(row.id, !row.enabled),
          }, {
            default: () => row.enabled ? t('common.disabled') : t('common.enabled')
          }),
          h(NButton, {
            size: 'small',
            text: true,
            type: 'error',
            onClick: () => deleteTarget(row.id),
          }, {
            default: () => t('common.delete')
          }),
        ]
      });
    },
  },
];

async function onToggleHealthMonitoring(val: boolean) {
  try {
    if (!persistentMonitoringEnabled.value) {
      message.warning(t('healthMonitoring.persistentMonitoringRequired'));
      return;
    }
    await configApi.updateSystemSettings({ healthMonitoringEnabled: val });
    healthMonitoringEnabled.value = val;
    message.success(t('messages.operationSuccess'));
  } catch (e: any) {
    message.error(t('messages.operationFailed'));
  }
}

async function onTogglePersistentMonitoring(val: boolean) {
  try {
    await configApi.updateSystemSettings({ persistentMonitoringEnabled: val });
    persistentMonitoringEnabled.value = val;
    message.success(t('messages.operationSuccess'));
  } catch (e: any) {
    message.error(t('messages.operationFailed'));
  }
}

function copyStatusUrl() {
  navigator.clipboard.writeText(publicStatusUrl.value);
  message.success(t('messages.copied'));
}

function openStatusPage() {
  window.open(publicStatusUrl.value, '_blank');
}

async function loadHealthTargets() {
  try {
    loadingTargets.value = true;
    const response = await configApi.getHealthTargets();
    healthTargets.value = response.targets || [];
  } catch (error: any) {
    message.error(error.message || t('messages.loadFailed'));
  } finally {
    loadingTargets.value = false;
  }
}

async function loadAvailableModels() {
  try {
    loadingModels.value = true;
    // 使用models API获取所有模型
    const response = await fetch('/api/admin/models', {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`,
      },
    });
    if (!response.ok) {
      throw new Error('Failed to load models');
    }
    const data = await response.json();
    const allModels = data.models || [];

    // 过滤出真实模型和虚拟模型
    availableModels.value = allModels.filter((m: any) => !m.isVirtual);
    availableVirtualModels.value = allModels.filter((m: any) => m.isVirtual);
  } catch (error: any) {
    message.error(error.message || t('messages.loadFailed'));
  } finally {
    loadingModels.value = false;
  }
}

function handleTypeChange() {
  addTargetForm.value.target_id = null;
}

async function handleAddTarget() {
  try {
    await configApi.createHealthTarget(addTargetForm.value);
    message.success(t('messages.operationSuccess'));
    showAddTargetModal.value = false;
    await loadHealthTargets();
    // 重置表单
    addTargetForm.value = {
      type: 'model',
      target_id: null,
      check_interval_seconds: 300,
      check_prompt: "Say 'OK'",
    };
  } catch (error: any) {
    message.error(error.message || t('messages.operationFailed'));
    return false;
  }
}

async function toggleTargetEnabled(targetId: string, enabled: boolean) {
  try {
    await configApi.updateHealthTarget(targetId, { enabled });
    message.success(t('messages.operationSuccess'));
    await loadHealthTargets();
  } catch (error: any) {
    message.error(error.message || t('messages.operationFailed'));
  }
}

async function deleteTarget(targetId: string) {
  try {
    await configApi.deleteHealthTarget(targetId);
    message.success(t('messages.operationSuccess'));
    await loadHealthTargets();
  } catch (error: any) {
    message.error(error.message || t('messages.operationFailed'));
  }
}

onMounted(async () => {
  const settings = await configApi.getSystemSettings();
  healthMonitoringEnabled.value = settings.healthMonitoringEnabled || false;
  persistentMonitoringEnabled.value = settings.persistentMonitoringEnabled || false;

  await Promise.all([
    loadHealthTargets(),
    loadAvailableModels(),
  ]);
});
</script>

<style scoped>
</style>

<template>
  <div>
    <n-space vertical :size="24">
      <n-card :title="$t('settings.title')">
        <n-space vertical :size="16">
          <n-space align="center" justify="space-between">
            <div>
              <div>{{ $t('settings.allowRegistration') }}</div>
              <n-text depth="3" style="font-size: 12px;">{{ $t('settings.allowRegistrationDesc') }}</n-text>
            </div>
            <n-switch :value="allowRegistration" @update:value="onToggleAllowRegistration" />
          </n-space>

          <n-divider style="margin: 8px 0;" />

          <n-space align="center" justify="space-between">
            <div>
              <div>{{ $t('settings.enableCors') }}</div>
              <n-text depth="3" style="font-size: 12px;">{{ $t('settings.enableCorsDesc') }}</n-text>
            </div>
            <n-switch :value="corsEnabled" @update:value="onToggleCorsEnabled" />
          </n-space>

          <n-alert type="warning" v-if="corsEnabled">
            <template #header>
              <div style="font-size: 14px; font-weight: 500;">{{ $t('settings.corsWarning.title') }}</div>
            </template>
            <n-text style="font-size: 13px;">{{ $t('settings.corsWarning.content') }}</n-text>
          </n-alert>

          <n-alert type="info" v-else>
            <template #header>
              <div style="font-size: 14px; font-weight: 500;">{{ $t('settings.corsDisabled.title') }}</div>
            </template>
            <n-text style="font-size: 13px;">{{ $t('settings.corsDisabled.content') }}</n-text>
          </n-alert>

          <n-divider style="margin: 8px 0;" />

          <n-space align="center" justify="space-between">
            <div>
              <div>{{ $t('settings.litellmCompat') }}</div>
              <n-text depth="3" style="font-size: 12px;">{{ $t('settings.litellmCompatDesc') }}</n-text>
            </div>
            <n-switch :value="litellmCompatEnabled" @update:value="onToggleLitellmCompat" />
          </n-space>


          <n-divider style="margin: 8px 0;" />

          <n-space vertical :size="8" style="width: 100%;">
            <div>
              <div>{{ $t('settings.publicUrl') }}</div>
              <n-text depth="3" style="font-size: 12px;">{{ $t('settings.publicUrlDesc') }}</n-text>
            </div>
            <n-space :size="8" style="width: 100%;">
              <n-input
                v-model:value="publicUrlInput"
                placeholder="http://example.com:3000"
                style="flex: 1;"
                size="small"
                :disabled="savingPublicUrl"
              />
              <n-button
                type="primary"
                size="small"
                :loading="savingPublicUrl"
                :disabled="!isPublicUrlChanged"
                @click="onSavePublicUrl"
              >
                {{ $t('common.save') }}
              </n-button>
              <n-button
                size="small"
                :disabled="!isPublicUrlChanged"
                @click="onResetPublicUrl"
              >
                {{ $t('common.reset') }}
              </n-button>
            </n-space>
            <n-text depth="3" style="font-size: 12px;">
              {{ $t('settings.publicUrlCurrent', { url: publicUrl }) }}
            </n-text>
          </n-space>


          <n-divider style="margin: 8px 0;" />

          <n-space vertical :size="16">
            <div style="font-size: 14px; font-weight: 500;">
              {{ $t('healthMonitoring.title') }}
            </div>

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

        </n-space>
      </n-card>

      <n-card :title="$t('common.systemInfo')">
        <n-descriptions :column="1" bordered>
          <n-descriptions-item :label="$t('common.currentUser')">
            <n-space>
              <template v-for="user in allUsers" :key="user.id">
                <n-text
                  :type="user.id === authStore.user?.id ? 'primary' : 'default'"
                  :strong="user.id === authStore.user?.id"
                >
                  {{ user.username }}
                </n-text>
                <n-text v-if="user.id !== allUsers[allUsers.length - 1].id" depth="3"> / </n-text>
              </template>
            </n-space>
          </n-descriptions-item>
          <n-descriptions-item :label="$t('common.providerCount')">
            {{ providerStore.providers.length }}
          </n-descriptions-item>
          <n-descriptions-item :label="$t('common.virtualKeyCount')">
            {{ virtualKeyStore.virtualKeys.length }}
          </n-descriptions-item>
          <n-descriptions-item :label="$t('common.enabledKeys')">
            {{ enabledKeysCount }}
          </n-descriptions-item>
        </n-descriptions>
      </n-card>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import { NSpace, NCard, NDescriptions, NDescriptionsItem, NSwitch, NAlert, NText, NDivider, NInput, NButton, NDataTable, NSpin, NModal, NForm, NFormItem, NSelect, NInputNumber, NTag, useMessage, useDialog } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { useProviderStore } from '@/stores/provider';
import { useVirtualKeyStore } from '@/stores/virtual-key';
import type { User } from '@/types';
 
import { configApi } from '@/api/config';
import { authApi } from '@/api/auth';
 
const { t } = useI18n();
const authStore = useAuthStore();
const providerStore = useProviderStore();
const virtualKeyStore = useVirtualKeyStore();
 
const message = useMessage();
const dialog = useDialog();
const allowRegistration = ref(true);
const corsEnabled = ref(true);
const litellmCompatEnabled = ref(false);
const publicUrl = ref('');
const publicUrlInput = ref('');
const savingPublicUrl = ref(false);
const allUsers = ref<User[]>([]);

// Health monitoring state moved from HealthMonitoringSettingsView
const healthMonitoringEnabled = ref(false);
const persistentMonitoringEnabled = ref(false);
const loadingTargets = ref(false);
const loadingModels = ref(false);
const healthTargets = ref<any[]>([]);
const showAddTargetModal = ref(false);
const showEditModal = ref(false);
const addTargetFormRef = ref();
const editFormRef = ref();
const availableModels = ref<any[]>([]);
const availableVirtualModels = ref<any[]>([]);

const addTargetForm = ref({
  type: 'model' as 'model' | 'virtual_model',
  target_id: null as string | null,
  check_interval_seconds: 300,
  check_prompt: "Say 'OK'",
});

const editForm = ref({
  id: '',
  name: '',
  display_title: '',
  check_interval_seconds: 300,
  check_prompt: '',
  enabled: true,
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

  return models.map((m: any) => ({
    label: m?.providerName ? `${m.name}(${m.providerName})` : m.name,
    value: m.id,
  }));
});

const targetColumns: DataTableColumns<any> = [
  {
    title: () => t('healthMonitoring.targetName'),
    key: 'name',
  },
  {
    title: () => '显示标题',
    key: 'display_title',
    render(row) {
      return row.display_title || h(NText, { depth: 3 }, { default: () => '(默认)' });
    },
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
            type: 'info',
            onClick: () => openEditModal(row),
          }, {
            default: () => t('common.edit')
          }),
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

const isPublicUrlChanged = computed(() => {
  return publicUrlInput.value.trim() !== '' && publicUrlInput.value !== publicUrl.value;
});

async function onToggleAllowRegistration(val: boolean) {
  try {
    await configApi.updateSystemSettings({ allowRegistration: val });
    allowRegistration.value = val;
    message.success(t('messages.operationSuccess'));
  } catch (e: any) {
    message.error(t('messages.operationFailed'));
  }
}

async function onToggleCorsEnabled(val: boolean) {
  if (!val) {
    dialog.warning({
      title: t('common.confirm'),
      content: t('settings.corsDisabled.content'),
      positiveText: t('common.confirm'),
      negativeText: t('common.cancel'),
      onPositiveClick: async () => {
        try {
          await configApi.updateSystemSettings({ corsEnabled: val });
          corsEnabled.value = val;
          message.warning(t('messages.operationSuccess'));
        } catch (e: any) {
          message.error(t('messages.operationFailed'));
        }
      }
    });
  } else {
    try {
      await configApi.updateSystemSettings({ corsEnabled: val });
      corsEnabled.value = val;
      message.success(t('messages.operationSuccess'));
    } catch (e: any) {
      message.error(t('messages.operationFailed'));
    }
  }
}

async function onToggleLitellmCompat(val: boolean) {
  try {
    await configApi.updateSystemSettings({ litellmCompatEnabled: val });
    litellmCompatEnabled.value = val;
    message.success(t('messages.operationSuccess'));
  } catch (e: any) {
    message.error(t('messages.operationFailed'));
  }
}

async function onSavePublicUrl() {
  const url = publicUrlInput.value.trim();

  try {
    savingPublicUrl.value = true;
    await configApi.updateSystemSettings({ publicUrl: url });
    publicUrl.value = url;
    message.success(t('messages.operationSuccess'));
  } catch (e: any) {
    message.error(e.message || t('messages.operationFailed'));
  } finally {
    savingPublicUrl.value = false;
  }
}

function onResetPublicUrl() {
  publicUrlInput.value = publicUrl.value;
}

const enabledKeysCount = computed(() => {
  return virtualKeyStore.virtualKeys.filter(k => k.enabled).length;
});

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
    if (!addTargetForm.value.target_id) {
      message.error('请选择目标模型');
      return false;
    }
    await configApi.createHealthTarget({
      type: addTargetForm.value.type,
      target_id: addTargetForm.value.target_id,
      check_interval_seconds: addTargetForm.value.check_interval_seconds,
      check_prompt: addTargetForm.value.check_prompt,
    });
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

function openEditModal(target: any) {
  editForm.value = {
    id: target.id,
    name: target.name,
    display_title: target.display_title || '',
    check_interval_seconds: target.check_interval_seconds,
    check_prompt: target.check_prompt || '',
    enabled: target.enabled === 1 || target.enabled === true,
  };
  showEditModal.value = true;
}

async function handleEditTarget() {
  try {
    const updates: any = {
      display_title: editForm.value.display_title || null,
      check_interval_seconds: editForm.value.check_interval_seconds,
      enabled: editForm.value.enabled,
    };

    if (editForm.value.check_prompt) {
      updates.check_prompt = editForm.value.check_prompt;
    }

    await configApi.updateHealthTarget(editForm.value.id, updates);
    message.success(t('messages.operationSuccess'));
    showEditModal.value = false;
    await loadHealthTargets();
  } catch (error: any) {
    message.error(error.message || t('messages.operationFailed'));
    return false;
  }
}
 
onMounted(async () => {
  const s = await configApi.getSystemSettings();
  allowRegistration.value = s.allowRegistration;
  corsEnabled.value = s.corsEnabled;
  litellmCompatEnabled.value = s.litellmCompatEnabled;
  publicUrl.value = s.publicUrl;
  publicUrlInput.value = s.publicUrl;
  healthMonitoringEnabled.value = s.healthMonitoringEnabled || false;
  persistentMonitoringEnabled.value = s.persistentMonitoringEnabled || false;
  
  try {
    allUsers.value = await authApi.getAllUsers();
  } catch (error) {
    console.error('获取用户列表失败:', error);
  }
  
  await Promise.all([
    providerStore.fetchProviders(),
    virtualKeyStore.fetchVirtualKeys(),
    loadHealthTargets(),
    loadAvailableModels(),
  ]);
});
</script>


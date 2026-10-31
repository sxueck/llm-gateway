<template>
  <div>
    <n-space vertical :size="24">
      <PageHeader
        eyebrow="SETTINGS"
        :title="$t('settings.title')"
        :subtitle="$t('settings.subtitle')"
      />
      <n-card>
        <section class="settings-section" aria-labelledby="settings-registrationSecurity">
          <h2 id="settings-registrationSecurity" class="settings-section-title">{{ $t('settings.registrationSecurity') }}</h2>
          <div class="settings-section-content">
            <n-space class="setting-row" align="center" justify="space-between" :wrap="false">
              <div>
                <div class="setting-label">{{ $t('settings.allowRegistration') }}</div>
                <n-text depth="3" class="setting-description">{{ $t('settings.allowRegistrationDesc') }}</n-text>
              </div>
              <n-switch :value="allowRegistration" @update:value="onToggleAllowRegistration" />
            </n-space>
            <n-space class="setting-row" align="center" justify="space-between" :wrap="false">
              <div>
                <div class="setting-label">{{ $t('settings.enableCors') }}</div>
                <n-text depth="3" class="setting-description">{{ $t('settings.enableCorsDesc') }}</n-text>
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
          </div>
        </section>
        <section class="settings-section" aria-labelledby="settings-apiCompatibility">
          <h2 id="settings-apiCompatibility" class="settings-section-title">{{ $t('settings.apiCompatibility') }}</h2>
          <div class="settings-section-content">
            <n-space class="setting-row" align="center" justify="space-between" :wrap="false">
              <div>
                <div class="setting-label">{{ $t('settings.litellmCompat') }}</div>
                <n-text depth="3" class="setting-description">{{ $t('settings.litellmCompatDesc') }}</n-text>
              </div>
              <n-switch :value="litellmCompatEnabled" @update:value="onToggleLitellmCompat" />
            </n-space>
            <n-space class="setting-row" align="center" justify="space-between" :wrap="false">
              <div>
                <div class="setting-label">{{ $t('settings.streamResume') }}</div>
                <n-text depth="3" class="setting-description">{{ $t('settings.streamResumeDesc') }}</n-text>
              </div>
              <n-switch :value="streamResumeEnabled" @update:value="onToggleStreamResume" />
            </n-space>
            <n-space vertical :size="8" style="width: 100%;">
              <div>
                <div class="setting-label">{{ $t('settings.reasoningEffortSuffixes') }}</div>
                <n-text depth="3" class="setting-description">{{ $t('settings.reasoningEffortSuffixesDesc') }}</n-text>
              </div>
              <n-input
                v-model:value="reasoningEffortSuffixesInput"
                type="textarea"
                :placeholder="$t('settings.reasoningEffortSuffixesPlaceholder')"
                :rows="4"
              />
              <n-space :size="8">
                <n-button
                  type="primary"
                  size="small"
                  :disabled="!isReasoningEffortSuffixesChanged"
                  :loading="savingReasoningEffortSuffixes"
                  @click="onSaveReasoningEffortSuffixes"
                >
                  {{ $t('common.save') }}
                </n-button>
                <n-button
                  size="small"
                  :disabled="!isReasoningEffortSuffixesChanged"
                  @click="onResetReasoningEffortSuffixes"
                >
                  {{ $t('common.reset') }}
                </n-button>
              </n-space>
              <n-text depth="3" class="setting-description">
                {{ $t('settings.reasoningEffortSuffixesDefault') }}
              </n-text>
            </n-space>
          </div>
        </section>
        <section class="settings-section" aria-labelledby="settings-accessConfiguration">
          <h2 id="settings-accessConfiguration" class="settings-section-title">{{ $t('settings.accessConfiguration') }}</h2>
          <div class="settings-section-content">
            <n-space vertical :size="8" style="width: 100%;">
              <div>
                <div class="setting-label">{{ $t('settings.publicUrl') }}</div>
                <n-text depth="3" class="setting-description">{{ $t('settings.publicUrlDesc') }}</n-text>
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
              <n-text depth="3" class="setting-description">
                {{ $t('settings.publicUrlCurrent', { url: publicUrl }) }}
              </n-text>
            </n-space>
            <n-space vertical :size="8" style="width: 100%;">
              <div>
                <div class="setting-label">{{ $t('settings.trafficAnalysisRegion') }}</div>
                <n-text depth="3" class="setting-description">{{ $t('settings.trafficAnalysisRegionDesc') }}</n-text>
              </div>
              <n-select
                v-model:value="trafficAnalysisRegion"
                :options="trafficAnalysisRegionOptions"
                :placeholder="$t('settings.trafficAnalysisRegionPlaceholder')"
                clearable
                filterable
                @update:value="onUpdateTrafficAnalysisRegion"
              />
            </n-space>
            <n-space class="setting-row" align="center" justify="space-between" :wrap="false">
              <div>
                <div class="setting-label">{{ $t('settings.dashboardHideRequestSourceCard') }}</div>
                <n-text depth="3" class="setting-description">{{ $t('settings.dashboardHideRequestSourceCardDesc') }}</n-text>
              </div>
              <n-switch :value="dashboardHideRequestSourceCard" @update:value="onToggleDashboardHideRequestSourceCard" />
            </n-space>
          </div>
        </section>
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
import { computed, onMounted, ref } from 'vue';
import { NSpace, NCard, NDescriptions, NDescriptionsItem, NSwitch, NAlert, NText, NInput, NButton, NSelect, useMessage, useDialog } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import { useProviderStore } from '@/stores/provider';
import { useVirtualKeyStore } from '@/stores/virtual-key';
import type { User } from '@/types';
import { useSystemConfig } from '@/composables/useSystemConfig';
import PageHeader from '@/components/PageHeader.vue';
 
import { configApi } from '@/api/config';
import { authApi } from '@/api/auth';
 
const { t } = useI18n();
const authStore = useAuthStore();
const providerStore = useProviderStore();
const virtualKeyStore = useVirtualKeyStore();
const { dashboardHideRequestSourceCard } = useSystemConfig();
 
const message = useMessage();
const dialog = useDialog();
const allowRegistration = ref(true);
const corsEnabled = ref(true);
const litellmCompatEnabled = ref(false);
const streamResumeEnabled = ref(false);
const publicUrl = ref('');
const publicUrlInput = ref('');
const trafficAnalysisRegion = ref<string | null>(null);
const trafficAnalysisRegionOptions = ref<Array<{ label: string; value: string }>>([]);
const savingPublicUrl = ref(false);
const allUsers = ref<User[]>([]);

const reasoningEffortSuffixesInput = ref('');
const reasoningEffortSuffixesOriginal = ref('');
const savingReasoningEffortSuffixes = ref(false);
const isReasoningEffortSuffixesChanged = computed(() => reasoningEffortSuffixesInput.value !== reasoningEffortSuffixesOriginal.value);

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

async function onToggleStreamResume(val: boolean) {
  try {
    await configApi.updateSystemSettings({ streamResumeEnabled: val });
    streamResumeEnabled.value = val;
    message.success(t('messages.operationSuccess'));
  } catch (e: any) {
    message.error(t('messages.operationFailed'));
  }
}

async function onToggleDashboardHideRequestSourceCard(val: boolean) {
  try {
    await configApi.updateSystemSettings({ dashboardHideRequestSourceCard: val });
    dashboardHideRequestSourceCard.value = val;
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

async function onUpdateTrafficAnalysisRegion(value: string | null) {
  try {
    await configApi.updateSystemSettings({ trafficAnalysisRegion: value });
    trafficAnalysisRegion.value = value;
    message.success(t('messages.operationSuccess'));
  } catch (error: any) {
    message.error(error.message || t('messages.operationFailed'));
  }
}

async function loadTrafficAnalysisRegions() {
  try {
    const regions = await configApi.getTrafficAnalysisRegions();
    trafficAnalysisRegionOptions.value = regions.map(region => ({
      label: `${region.code} - ${region.name}`,
      value: region.code,
    }));
  } catch (error: any) {
    message.error(error.message || t('messages.loadFailed'));
  }
}

async function onSaveReasoningEffortSuffixes() {
  const list = reasoningEffortSuffixesInput.value
    .split('\n')
    .map(s => s.trim())
    .filter(s => s);
  try {
    savingReasoningEffortSuffixes.value = true;
    await configApi.updateSystemSettings({ reasoningEffortModelSuffixes: list });
    reasoningEffortSuffixesOriginal.value = reasoningEffortSuffixesInput.value;
    message.success(t('messages.operationSuccess'));
  } catch (e: any) {
    message.error(e.message || t('messages.operationFailed'));
  } finally {
    savingReasoningEffortSuffixes.value = false;
  }
}

function onResetReasoningEffortSuffixes() {
  reasoningEffortSuffixesInput.value = reasoningEffortSuffixesOriginal.value;
}

const enabledKeysCount = computed(() => {
  return virtualKeyStore.virtualKeys.filter(k => k.enabled).length;
});

onMounted(async () => {
  try {
    const s = await configApi.getSystemSettings();
    allowRegistration.value = s.allowRegistration;
    corsEnabled.value = s.corsEnabled;
    litellmCompatEnabled.value = s.litellmCompatEnabled;
    streamResumeEnabled.value = s.streamResumeEnabled ?? false;
    publicUrl.value = s.publicUrl;
    publicUrlInput.value = s.publicUrl;
    trafficAnalysisRegion.value = s.trafficAnalysisRegion ?? null;
    dashboardHideRequestSourceCard.value = s.dashboardHideRequestSourceCard || false;

    const suffixesText = (s.reasoningEffortModelSuffixes || []).join('\n');
    reasoningEffortSuffixesInput.value = suffixesText;
    reasoningEffortSuffixesOriginal.value = suffixesText;

    try {
      allUsers.value = await authApi.getAllUsers();
    } catch (error) {
      console.error('获取用户列表失败:', error);
    }

    // 并行加载提供商、虚拟密钥、地域列表
    await Promise.all([
      providerStore.fetchProviders(),
      virtualKeyStore.fetchVirtualKeys(),
      loadTrafficAnalysisRegions(),
    ]);
  } catch (error: any) {
    console.error('初始化设置页面失败:', error);
    message.error(error?.message || t('messages.loadFailed'));
  }
});
</script>

<style scoped>
.settings-section + .settings-section {
  border-top: 1px solid var(--color-border, rgba(128, 128, 128, 0.2));
  margin-top: 28px;
  padding-top: 28px;
}

.settings-section-title {
  color: var(--color-title);
  font-size: 16px;
  font-weight: 600;
  line-height: 1.5;
  margin: 0 0 20px;
}

.settings-section-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.setting-label {
  font-size: 14px;
  font-weight: 500;
  line-height: 1.5;
}

.setting-description {
  display: block;
  font-size: 13px;
  line-height: 1.5;
  margin-top: 4px;
}

.setting-row {
  width: 100%;
}

.setting-row :deep(.n-switch) {
  flex-shrink: 0;
}

:deep(.n-card-header__main) {
  color: var(--color-title);
}
</style>

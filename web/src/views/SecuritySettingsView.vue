<template>
  <div>
    <n-space vertical :size="24">
      <n-card :title="$t('settings.security')">
        <n-space vertical :size="16">
          <!-- 反爬虫设置 -->
          <n-space vertical :size="16">
            <div style="font-size: 16px; font-weight: 500;">{{ $t('settings.antiBot.title') }}</div>
            
            <n-space align="center" justify="space-between">
              <div>
                <div>{{ $t('settings.antiBot.enabled') }}</div>
                <n-text depth="3" style="font-size: 12px;">{{ $t('settings.antiBot.enabledDesc') }}</n-text>
              </div>
              <n-switch :value="antiBotEnabled" @update:value="onToggleAntiBotEnabled" />
            </n-space>

            <template v-if="antiBotEnabled">
              <n-alert type="info">
                <template #header>
                  <div style="font-size: 14px; font-weight: 500;">{{ $t('settings.antiBot.enabled_info.title') }}</div>
                </template>
                <n-text style="font-size: 13px;">{{ $t('settings.antiBot.enabled_info.content') }}</n-text>
              </n-alert>

              <n-space align="center" justify="space-between">
                <div>
                  <div>{{ $t('settings.antiBot.logOnly') }}</div>
                  <n-text depth="3" style="font-size: 12px;">{{ $t('settings.antiBot.logOnlyDesc') }}</n-text>
                </div>
                <n-switch :value="antiBotLogOnly" @update:value="onToggleAntiBotLogOnly" />
              </n-space>

              <n-space align="center" justify="space-between">
                <div>
                  <div>{{ $t('settings.antiBot.blockBots') }}</div>
                  <n-text depth="3" style="font-size: 12px;">{{ $t('settings.antiBot.blockBotsDesc') }}</n-text>
                </div>
                <n-switch :value="antiBotBlockBots" @update:value="onToggleAntiBotBlockBots" />
              </n-space>

              <n-space align="center" justify="space-between">
                <div>
                  <div>{{ $t('settings.antiBot.blockSuspicious') }}</div>
                  <n-text depth="3" style="font-size: 12px;">{{ $t('settings.antiBot.blockSuspiciousDesc') }}</n-text>
                </div>
                <n-switch :value="antiBotBlockSuspicious" @update:value="onToggleAntiBotBlockSuspicious" />
              </n-space>

              <n-space align="center" justify="space-between">
                <div>
                  <div>{{ $t('settings.antiBot.logHeaders') }}</div>
                  <n-text depth="3" style="font-size: 12px;">{{ $t('settings.antiBot.logHeadersDesc') }}</n-text>
                </div>
                <n-switch :value="antiBotLogHeaders" @update:value="onToggleAntiBotLogHeaders" />
              </n-space>

              <n-space vertical :size="8" style="width: 100%;">
                <div>
                  <div>{{ $t('settings.antiBot.allowedUserAgents') }}</div>
                  <n-text depth="3" style="font-size: 12px;">{{ $t('settings.antiBot.allowedUserAgentsDesc') }}</n-text>
                </div>
                <n-input
                  v-model:value="antiBotAllowedUa"
                  type="textarea"
                  :placeholder="$t('settings.antiBot.allowedUserAgentsPlaceholder')"
                  :rows="4"
                />
                <n-button
                  type="primary"
                  size="small"
                  @click="onSaveAntiBotAllowedUa"
                  :disabled="!isAntiBotAllowedUaChanged"
                >
                  {{ $t('common.save') }}
                </n-button>
              </n-space>

              <n-space vertical :size="8" style="width: 100%;">
                <div>
                  <div>{{ $t('settings.antiBot.blockedUserAgents') }}</div>
                  <n-text depth="3" style="font-size: 12px;">{{ $t('settings.antiBot.blockedUserAgentsDesc') }}</n-text>
                </div>
                <n-input
                  v-model:value="antiBotBlockedUa"
                  type="textarea"
                  :placeholder="$t('settings.antiBot.blockedUserAgentsPlaceholder')"
                  :rows="4"
                />
                <n-button
                  type="primary"
                  size="small"
                  @click="onSaveAntiBotBlockedUa"
                  :disabled="!isAntiBotBlockedUaChanged"
                >
                  {{ $t('common.save') }}
                </n-button>
              </n-space>

              <n-alert type="warning">
                <template #header>
                  <div style="font-size: 14px; font-weight: 500;">{{ $t('settings.antiBot.warning.title') }}</div>
                </template>
                <n-text style="font-size: 13px;">{{ $t('settings.antiBot.warning.content') }}</n-text>
              </n-alert>
            </template>
          </n-space>
        </n-space>
      </n-card>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NSpace, NCard, NSwitch, NAlert, NText, NInput, NButton, useMessage } from 'naive-ui';
import { useI18n } from 'vue-i18n';

import { configApi } from '@/api/config';
import { handleAsyncOperation } from '@/utils/error-handler';

const { t } = useI18n();

const message = useMessage();
// 反爬虫设置
const antiBotEnabled = ref(false);
const antiBotBlockBots = ref(true);
const antiBotBlockSuspicious = ref(false);
const antiBotLogOnly = ref(true);
const antiBotLogHeaders = ref(false);
const antiBotAllowedUa = ref('');
const antiBotBlockedUa = ref('');
const antiBotAllowedUaOriginal = ref('');
const antiBotBlockedUaOriginal = ref('');

const isAntiBotAllowedUaChanged = computed(() => {
  return antiBotAllowedUa.value !== antiBotAllowedUaOriginal.value;
});

const isAntiBotBlockedUaChanged = computed(() => {
  return antiBotBlockedUa.value !== antiBotBlockedUaOriginal.value;
});

async function onToggleAntiBotEnabled(val: boolean) {
  const result = await handleAsyncOperation(
    () => configApi.updateSystemSettings({ antiBot: { enabled: val } }),
    message,
    t('messages.operationSuccess'),
    t('messages.operationFailed')
  );
  if (result) {
    antiBotEnabled.value = val;
  }
}

async function onToggleAntiBotLogOnly(val: boolean) {
  const result = await handleAsyncOperation(
    () => configApi.updateSystemSettings({ antiBot: { logOnly: val } }),
    message,
    t('messages.operationSuccess'),
    t('messages.operationFailed')
  );
  if (result) {
    antiBotLogOnly.value = val;
  }
}

async function onToggleAntiBotBlockBots(val: boolean) {
  const result = await handleAsyncOperation(
    () => configApi.updateSystemSettings({ antiBot: { blockBots: val } }),
    message,
    t('messages.operationSuccess'),
    t('messages.operationFailed')
  );
  if (result) {
    antiBotBlockBots.value = val;
  }
}

async function onToggleAntiBotBlockSuspicious(val: boolean) {
  const result = await handleAsyncOperation(
    () => configApi.updateSystemSettings({ antiBot: { blockSuspicious: val } }),
    message,
    t('messages.operationSuccess'),
    t('messages.operationFailed')
  );
  if (result) {
    antiBotBlockSuspicious.value = val;
  }
}

async function onToggleAntiBotLogHeaders(val: boolean) {
  const result = await handleAsyncOperation(
    () => configApi.updateSystemSettings({ antiBot: { logHeaders: val } }),
    message,
    t('messages.operationSuccess'),
    t('messages.operationFailed')
  );
  if (result) {
    antiBotLogHeaders.value = val;
  }
}

async function onSaveAntiBotAllowedUa() {
  const list = antiBotAllowedUa.value.split('\n').map(s => s.trim()).filter(s => s);
  const result = await handleAsyncOperation(
    () => configApi.updateSystemSettings({ antiBot: { allowedUserAgents: list } }),
    message,
    t('messages.operationSuccess'),
    t('messages.operationFailed')
  );
  if (result) {
    antiBotAllowedUaOriginal.value = antiBotAllowedUa.value;
  }
}

async function onSaveAntiBotBlockedUa() {
  const list = antiBotBlockedUa.value.split('\n').map(s => s.trim()).filter(s => s);
  const result = await handleAsyncOperation(
    () => configApi.updateSystemSettings({ antiBot: { blockedUserAgents: list } }),
    message,
    t('messages.operationSuccess'),
    t('messages.operationFailed')
  );
  if (result) {
    antiBotBlockedUaOriginal.value = antiBotBlockedUa.value;
  }
}

onMounted(async () => {
  const s = await configApi.getSystemSettings();
  
  // 加载反爬虫配置
  if (s.antiBot) {
    antiBotEnabled.value = s.antiBot.enabled;
    antiBotBlockBots.value = s.antiBot.blockBots;
    antiBotBlockSuspicious.value = s.antiBot.blockSuspicious;
    antiBotLogOnly.value = s.antiBot.logOnly;
    antiBotLogHeaders.value = s.antiBot.logHeaders;
    antiBotAllowedUa.value = s.antiBot.allowedUserAgents.join('\n');
    antiBotBlockedUa.value = s.antiBot.blockedUserAgents.join('\n');
    antiBotAllowedUaOriginal.value = antiBotAllowedUa.value;
    antiBotBlockedUaOriginal.value = antiBotBlockedUa.value;
  }
});
</script>
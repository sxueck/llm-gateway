<template>
  <div>
    <n-space vertical :size="24">
      <n-card title="系统设置">
        <n-space vertical :size="16">
          <n-space align="center" justify="space-between">
            <div>
              <div>允许新用户注册</div>
              <n-text depth="3" style="font-size: 12px;">控制是否允许新用户通过注册页面创建账号</n-text>
            </div>
            <n-switch :value="allowRegistration" @update:value="onToggleAllowRegistration" />
          </n-space>

          <n-divider style="margin: 8px 0;" />

          <n-space align="center" justify="space-between">
            <div>
              <div>启用 CORS 跨域支持</div>
              <n-text depth="3" style="font-size: 12px;">
                允许浏览器端应用跨域访问 API
              </n-text>
            </div>
            <n-switch :value="corsEnabled" @update:value="onToggleCorsEnabled" />
          </n-space>

          <n-alert type="warning" v-if="corsEnabled">
            <template #header>CORS 兼容性提示</template>
            <n-text>
              启用 CORS 后，任何域名的浏览器端应用都可以访问此网关的 API。
              这对于 Open WebUI 等浏览器端应用是必需的，但可能带来安全风险。
              建议仅在需要浏览器端访问时启用，或配置反向代理限制访问来源。
            </n-text>
          </n-alert>

          <n-alert type="info" v-else>
            <template #header>CORS 已禁用</template>
            <n-text>
              当前已禁用 CORS 跨域支持。浏览器端应用（如 Open WebUI）将无法直接访问此网关。
              服务端应用（如 Cursor、VS Code 插件）不受影响。
              如需使用浏览器端应用，请启用 CORS 或通过反向代理配置跨域。
            </n-text>
          </n-alert>
        </n-space>
      </n-card>

      <n-card title="系统信息">
        <n-descriptions :column="1" bordered>
          <n-descriptions-item label="当前用户">
            {{ authStore.user?.username || '-' }}
          </n-descriptions-item>
          <n-descriptions-item label="提供商数量">
            {{ providerStore.providers.length }}
          </n-descriptions-item>
          <n-descriptions-item label="虚拟密钥数量">
            {{ virtualKeyStore.virtualKeys.length }}
          </n-descriptions-item>
          <n-descriptions-item label="启用的密钥">
            {{ enabledKeysCount }}
          </n-descriptions-item>
        </n-descriptions>
      </n-card>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NSpace, NCard, NDescriptions, NDescriptionsItem, NSwitch, NAlert, NText, NDivider, useMessage, useDialog } from 'naive-ui';
import { useAuthStore } from '@/stores/auth';
import { useProviderStore } from '@/stores/provider';
import { useVirtualKeyStore } from '@/stores/virtual-key';

import { configApi } from '@/api/config';

const authStore = useAuthStore();
const providerStore = useProviderStore();
const virtualKeyStore = useVirtualKeyStore();

const message = useMessage();
const dialog = useDialog();
const allowRegistration = ref(true);
const corsEnabled = ref(true);

async function onToggleAllowRegistration(val: boolean) {
  try {
    await configApi.updateSystemSettings({ allowRegistration: val });
    allowRegistration.value = val;
    message.success('设置已保存');
  } catch (e: any) {
    message.error('保存失败');
  }
}

async function onToggleCorsEnabled(val: boolean) {
  if (!val) {
    dialog.warning({
      title: '确认禁用 CORS',
      content: '禁用 CORS 后，浏览器端应用（如 Open WebUI）将无法直接访问此网关。服务端应用不受影响。确定要禁用吗？',
      positiveText: '确定禁用',
      negativeText: '取消',
      onPositiveClick: async () => {
        try {
          await configApi.updateSystemSettings({ corsEnabled: val });
          corsEnabled.value = val;
          message.warning('CORS 已禁用，需要重启服务才能生效');
        } catch (e: any) {
          message.error('保存失败');
        }
      }
    });
  } else {
    try {
      await configApi.updateSystemSettings({ corsEnabled: val });
      corsEnabled.value = val;
      message.success('CORS 已启用，需要重启服务才能生效');
    } catch (e: any) {
      message.error('保存失败');
    }
  }
}

const enabledKeysCount = computed(() => {
  return virtualKeyStore.virtualKeys.filter(k => k.enabled).length;
});

onMounted(async () => {
  const s = await configApi.getSystemSettings();
  allowRegistration.value = s.allowRegistration;
  corsEnabled.value = s.corsEnabled;
  await Promise.all([
    providerStore.fetchProviders(),
    virtualKeyStore.fetchVirtualKeys(),
  ]);
});
</script>


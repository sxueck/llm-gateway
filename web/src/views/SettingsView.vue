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

          <n-divider style="margin: 8px 0;" />

          <n-space align="center" justify="space-between">
            <div>
              <div>LiteLLM 兼容模式</div>
              <n-text depth="3" style="font-size: 12px;">
                开启后可在 RooCode / KiloCode 等工具中选择 LiteLLM 类型，自动复用预设库中的上下文大小和功能支持等配置
              </n-text>
            </div>
            <n-switch :value="litellmCompatEnabled" @update:value="onToggleLitellmCompat" />
          </n-space>

          <n-alert type="info" v-if="litellmCompatEnabled">
            <template #header>LiteLLM 兼容模式已启用</template>
            <n-text>
              已启用 <n-text code>/v1/model/info</n-text> 端点，返回 LiteLLM 格式的模型信息。
              可在 Roo Code、Continue 等支持 LiteLLM 的工具中使用，自动获取模型的上下文窗口大小、功能支持等配置。
            </n-text>
          </n-alert>

          <n-divider style="margin: 8px 0;" />

          <n-space vertical :size="8" style="width: 100%;">
            <div>
              <div>LLM Gateway 公网访问地址</div>
              <n-text depth="3" style="font-size: 12px;">
                用于 Agent 回调的 LLM Gateway 地址，如部署在公网服务器上，请设置为实际的公网地址
              </n-text>
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
                保存
              </n-button>
              <n-button
                size="small"
                :disabled="!isPublicUrlChanged"
                @click="onResetPublicUrl"
              >
                重置
              </n-button>
            </n-space>
            <n-text depth="3" style="font-size: 12px;">
              当前值: {{ publicUrl }}
            </n-text>
          </n-space>

          <n-alert type="info">
            <template #header>配置说明</template>
            <n-text>
              此地址将在生成 Agent 安装脚本时使用，Agent 会通过此地址与 LLM Gateway 通信。
              修改后会立即生效，但已安装的 Agent 需要手动更新配置文件并重启服务。
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
import { NSpace, NCard, NDescriptions, NDescriptionsItem, NSwitch, NAlert, NText, NDivider, NInput, NButton, useMessage, useDialog } from 'naive-ui';
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
const litellmCompatEnabled = ref(false);
const publicUrl = ref('');
const publicUrlInput = ref('');
const savingPublicUrl = ref(false);

const isPublicUrlChanged = computed(() => {
  return publicUrlInput.value.trim() !== '' && publicUrlInput.value !== publicUrl.value;
});

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

async function onToggleLitellmCompat(val: boolean) {
  try {
    await configApi.updateSystemSettings({ litellmCompatEnabled: val });
    litellmCompatEnabled.value = val;
    message.success(val ? 'LiteLLM 兼容模式已启用' : 'LiteLLM 兼容模式已禁用');
  } catch (e: any) {
    message.error('保存失败');
  }
}

async function onSavePublicUrl() {
  const url = publicUrlInput.value.trim();

  try {
    savingPublicUrl.value = true;
    await configApi.updateSystemSettings({ publicUrl: url });
    publicUrl.value = url;
    message.success('LLM Gateway URL 已更新');
  } catch (e: any) {
    message.error(e.message || '保存失败');
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

onMounted(async () => {
  const s = await configApi.getSystemSettings();
  allowRegistration.value = s.allowRegistration;
  corsEnabled.value = s.corsEnabled;
  litellmCompatEnabled.value = s.litellmCompatEnabled;
  publicUrl.value = s.publicUrl;
  publicUrlInput.value = s.publicUrl;
  await Promise.all([
    providerStore.fetchProviders(),
    virtualKeyStore.fetchVirtualKeys(),
  ]);
});
</script>


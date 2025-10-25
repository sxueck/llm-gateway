<template>
  <div>
    <n-space vertical :size="12">
      <div>
        <h2 class="page-title">Gateway 管理</h2>
        <p class="page-subtitle">管理本地 Portkey Gateway 容器的运行状态,查看日志和配置文件</p>
      </div>

      <n-card>
        <template #header>
          <n-space justify="space-between" align="center">
            <span>Portkey Gateway 状态</span>
            <n-button @click="() => refreshStatus()" :loading="loading" size="small">
              <template #icon>
                <n-icon><RefreshOutline /></n-icon>
              </template>
              刷新
            </n-button>
          </n-space>
        </template>

        <n-alert v-if="!portkeyStatus?.running" type="warning" style="margin-bottom: 16px;">
          Gateway 未运行
        </n-alert>

        <n-descriptions :column="2" bordered>
          <n-descriptions-item label="运行状态">
            <n-space align="center">
              <n-tag :type="portkeyStatus?.running ? 'success' : 'error'" :bordered="false">
                {{ portkeyStatus?.running ? '运行中' : '未运行' }}
              </n-tag>
              <n-badge v-if="portkeyStatus?.running" dot processing type="success" />
            </n-space>
          </n-descriptions-item>
          <n-descriptions-item label="容器名称">
            <n-text code>{{ portkeyStatus?.containerName || '-' }}</n-text>
          </n-descriptions-item>
          <n-descriptions-item label="容器 ID">
            <n-text code>{{ portkeyStatus?.containerId?.substring(0, 12) || '-' }}</n-text>
          </n-descriptions-item>
          <n-descriptions-item label="容器状态">
            <n-text>{{ portkeyStatus?.status || '-' }}</n-text>
          </n-descriptions-item>
          <n-descriptions-item label="端口映射">
            <n-text code>{{ portkeyStatus?.ports || '-' }}</n-text>
          </n-descriptions-item>
          <n-descriptions-item label="镜像">
            <n-text code>{{ portkeyStatus?.image || '-' }}</n-text>
          </n-descriptions-item>
          <n-descriptions-item label="Docker 版本" :span="2">
            <n-text code>{{ portkeyStatus?.docker?.version || '-' }}</n-text>
          </n-descriptions-item>
        </n-descriptions>

        <n-divider />

        <n-space>
          <n-button 
            v-if="!portkeyStatus?.running" 
            type="primary" 
            @click="handleStart" 
            :loading="operating"
            :disabled="!portkeyStatus?.docker?.available"
          >
            <template #icon>
              <n-icon><PlayOutline /></n-icon>
            </template>
            启动 Gateway
          </n-button>
          <n-button 
            v-if="portkeyStatus?.running" 
            type="error" 
            @click="handleStop" 
            :loading="operating"
          >
            <template #icon>
              <n-icon><StopOutline /></n-icon>
            </template>
            停止 Gateway
          </n-button>
          <n-button 
            v-if="portkeyStatus?.running" 
            type="warning" 
            @click="handleRestart" 
            :loading="operating"
          >
            <template #icon>
              <n-icon><RefreshOutline /></n-icon>
            </template>
            重启 Gateway
          </n-button>
          <n-button 
            v-if="portkeyStatus?.containerId" 
            @click="showLogs" 
            :loading="loadingLogs"
          >
            <template #icon>
              <n-icon><DocumentTextOutline /></n-icon>
            </template>
            查看日志
          </n-button>
          <n-popconfirm
            v-if="portkeyStatus?.containerId"
            @positive-click="handleRemove"
            negative-text="取消"
            positive-text="确认删除"
          >
            <template #trigger>
              <n-button type="error" ghost :loading="operating">
                <template #icon>
                  <n-icon><TrashOutline /></n-icon>
                </template>
                删除容器
              </n-button>
            </template>
            确定要删除 Portkey Gateway 容器吗？删除后需要重新创建。
          </n-popconfirm>
          <n-popconfirm
            @positive-click="handleRecreate"
            negative-text="取消"
            positive-text="确认重建"
          >
            <template #trigger>
              <n-button type="warning" ghost :loading="operating">
                <template #icon>
                  <n-icon><BuildOutline /></n-icon>
                </template>
                重建容器
              </n-button>
            </template>
            重建将删除现有容器并创建新容器，确定继续吗？
          </n-popconfirm>
        </n-space>
      </n-card>

      <n-card title="配置文件管理">
        <n-space vertical :size="16">
          <n-alert type="info">
            <template #header>
              <div style="font-size: 14px; font-weight: 500;">关于配置文件</div>
            </template>
            <n-text style="font-size: 13px;">
              Portkey Gateway 使用 <n-text code>portkey-config/conf.json</n-text> 作为配置文件。
              当提供商或虚拟密钥发生变化时，系统会自动重新生成配置文件。
              配置文件更新后，需要重启 Gateway 才能生效。
            </n-text>
          </n-alert>

          <n-space>
            <n-button type="primary" @click="handleRegenerateConfig" :loading="regenerating">
              <template #icon>
                <n-icon><RefreshOutline /></n-icon>
              </template>
              重新生成配置文件
            </n-button>
            <n-button @click="showConfigContent" :loading="loadingConfig">
              <template #icon>
                <n-icon><CodeOutline /></n-icon>
              </template>
              查看配置内容
            </n-button>
          </n-space>
        </n-space>
      </n-card>


    </n-space>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import {
  useMessage,
  useDialog,
  NSpace,
  NCard,
  NDescriptions,
  NDescriptionsItem,
  NTag,
  NAlert,
  NButton,
  NIcon,
  NDivider,
  NText,
  NPopconfirm,
  NBadge,
} from 'naive-ui';
import {
  RefreshOutline,
  PlayOutline,
  StopOutline,
  DocumentTextOutline,
  TrashOutline,
  BuildOutline,
  CodeOutline,
} from '@vicons/ionicons5';
import { configApi, type PortkeyStatus } from '@/api/config';

const message = useMessage();
const dialog = useDialog();

const portkeyStatus = ref<PortkeyStatus | null>(null);
const loading = ref(false);
const operating = ref(false);
const loadingLogs = ref(false);
const loadingConfig = ref(false);
const regenerating = ref(false);
const statusCache = ref<{ status: PortkeyStatus | null; timestamp: number } | null>(null);
const CACHE_DURATION = 10000;

async function refreshStatus(forceRefresh = false) {
  const now = Date.now();

  if (!forceRefresh && statusCache.value && (now - statusCache.value.timestamp) < CACHE_DURATION) {
    portkeyStatus.value = statusCache.value.status;
    return;
  }

  try {
    loading.value = true;
    const status = await configApi.getPortkeyStatus();
    portkeyStatus.value = status;
    statusCache.value = { status, timestamp: now };
  } catch (error: any) {
    message.error(error.message);
  } finally {
    loading.value = false;
  }
}

async function handleStart() {
  try {
    operating.value = true;
    const result = await configApi.startPortkey();
    if (result.success) {
      message.success(result.message);
      await refreshStatus(true);
    } else {
      message.error(result.message);
    }
  } catch (error: any) {
    message.error(error.message);
  } finally {
    operating.value = false;
  }
}

async function handleStop() {
  try {
    operating.value = true;
    const result = await configApi.stopPortkey();
    if (result.success) {
      message.success(result.message);
      await refreshStatus(true);
    } else {
      message.error(result.message);
    }
  } catch (error: any) {
    message.error(error.message);
  } finally {
    operating.value = false;
  }
}

async function handleRestart() {
  try {
    operating.value = true;
    message.loading('正在重启 Portkey Gateway...', { duration: 0 });
    const result = await configApi.restartPortkey();
    message.destroyAll();
    if (result.success) {
      message.success(result.message);
      await refreshStatus(true);
    } else {
      message.error(result.message);
    }
  } catch (error: any) {
    message.destroyAll();
    message.error(error.message);
  } finally {
    operating.value = false;
  }
}

async function handleRemove() {
  try {
    operating.value = true;
    const result = await configApi.removePortkey();
    if (result.success) {
      message.success(result.message);
      await refreshStatus(true);
    } else {
      message.error(result.message);
    }
  } catch (error: any) {
    message.error(error.message);
  } finally {
    operating.value = false;
  }
}

async function handleRecreate() {
  try {
    operating.value = true;
    message.loading('正在重建 Portkey Gateway 容器...', { duration: 0 });
    const result = await configApi.recreatePortkey();
    message.destroyAll();
    if (result.success) {
      message.success(result.message);
      await refreshStatus(true);
    } else {
      message.error(result.message);
    }
  } catch (error: any) {
    message.destroyAll();
    message.error(error.message);
  } finally {
    operating.value = false;
  }
}

async function showLogs() {
  try {
    loadingLogs.value = true;
    const result = await configApi.getPortkeyLogs(200);
    if (result.success && result.logs) {
      dialog.info({
        title: 'Portkey Gateway 日志',
        content: result.logs || '',
        positiveText: '关闭',
      });
    } else {
      message.error(result.message || '获取日志失败');
    }
  } catch (error: any) {
    message.error(error.message);
  } finally {
    loadingLogs.value = false;
  }
}

async function showConfigContent() {
  loadingConfig.value = true;
  try {
    const response = await fetch('/portkey-config/conf.json');
    const config = await response.json();
    const configText = JSON.stringify(config, null, 2);

    dialog.info({
      title: '配置文件内容',
      content: configText,
      positiveText: '关闭',
    });
  } catch (error: any) {
    message.error('无法读取配置文件');
  } finally {
    loadingConfig.value = false;
  }
}

async function handleRegenerateConfig() {
  try {
    regenerating.value = true;
    const result = await configApi.regenerateConfig();
    if (result.success) {
      message.success('配置文件已重新生成');
      if (portkeyStatus.value?.running) {
        dialog.warning({
          title: '需要重启 Gateway',
          content: '配置文件已更新，需要重启 Portkey Gateway 以加载新配置。是否立即重启？',
          positiveText: '立即重启',
          negativeText: '稍后手动重启',
          onPositiveClick: async () => {
            await handleRestart();
          },
        });
      }
    } else {
      message.error(result.message);
    }
  } catch (error: any) {
    message.error(error.message);
  } finally {
    regenerating.value = false;
  }
}

onMounted(async () => {
  await refreshStatus();
});
</script>

<style scoped>
.page-title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  color: #1a1a1a;
}

.page-subtitle {
  font-size: 14px;
  color: #8c8c8c;
  margin: 4px 0 0 0;
  font-weight: 400;
}
</style>

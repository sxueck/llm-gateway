<template>
  <div class="portkey-gateways-view">
    <n-space vertical :size="12">
      <div>
        <h2 class="page-title">Portkey 网关</h2>
        <p class="page-subtitle">配置多个 Portkey Gateway 实例,通过路由规则实现智能分发、负载均衡和地区隔离</p>
      </div>

      <n-tabs type="line" animated>
        <n-tab-pane name="gateways" tab="网关管理">
          <n-space vertical :size="12" style="margin-top: 12px;">
            <n-space justify="end" :size="8">
              <n-button @click="loadGateways" :loading="gatewayLoading" size="small">
                <template #icon>
                  <n-icon><RefreshOutline /></n-icon>
                </template>
                刷新
              </n-button>
              <n-button type="primary" size="small" @click="handleCreate">
                <template #icon>
                  <n-icon><AddOutline /></n-icon>
                </template>
                添加网关
              </n-button>
              <n-button type="success" size="small" @click="handleInstallAgent">
                <template #icon>
                  <n-icon><CloudDownloadOutline /></n-icon>
                </template>
                自动安装 Agent
              </n-button>
            </n-space>

            <n-card class="table-card">
              <n-data-table
                :columns="gatewayColumns"
                :data="gateways"
                :loading="gatewayLoading"
                :pagination="{ pageSize: 10 }"
                :bordered="false"
                size="small"
              />
            </n-card>
          </n-space>
        </n-tab-pane>

        <n-tab-pane name="rules" tab="路由规则">
          <n-space vertical :size="12" style="margin-top: 12px;">
            <n-space justify="end" :size="8">
              <n-button @click="loadRules" :loading="ruleLoading" size="small">
                <template #icon>
                  <n-icon><RefreshOutline /></n-icon>
                </template>
                刷新
              </n-button>
              <n-button type="primary" size="small" @click="handleCreateRule">
                <template #icon>
                  <n-icon><AddOutline /></n-icon>
                </template>
                创建规则
              </n-button>
            </n-space>

            <n-card class="table-card">
              <n-data-table
                :columns="ruleColumns"
                :data="rules"
                :loading="ruleLoading"
                :pagination="{ pageSize: 10 }"
                :bordered="false"
                size="small"
              />
            </n-card>
          </n-space>
        </n-tab-pane>
      </n-tabs>
    </n-space>

    <n-modal
      v-model:show="showModal"
      preset="card"
      :title="editingId ? '编辑网关' : '添加网关'"
      style="width: 600px"
    >
      <n-form
        ref="formRef"
        :model="formValue"
        :rules="gatewayFormRules"
        label-placement="left"
        label-width="100"
        size="small"
      >
        <n-form-item label="网关名称" path="name">
          <n-input v-model:value="formValue.name" placeholder="例如: CN Gateway" />
        </n-form-item>
        <n-form-item label="网关 URL" path="url">
          <n-input v-model:value="formValue.url" :placeholder="`http://localhost:${AGENT_DEFAULTS.PORTKEY_PORT}`" />
        </n-form-item>
        <n-form-item label="描述" path="description">
          <n-input
            v-model:value="formValue.description"
            type="textarea"
            placeholder="网关用途说明"
            :rows="2"
          />
        </n-form-item>
        <n-form-item label="容器名称" path="containerName">
          <n-input v-model:value="formValue.containerName" placeholder="portkey-gateway" />
        </n-form-item>
        <n-form-item label="Agent 端口" path="port">
          <n-space :size="8" style="width: 100%">
            <n-input-number v-model:value="formValue.port" :min="1" :max="65535" style="flex: 1" :placeholder="String(AGENT_DEFAULTS.AGENT_PORT)" />
            <n-button @click="generateRandomPort('formValue')">随机端口</n-button>
          </n-space>
          <template #feedback>
            <n-text depth="3" style="font-size: 12px">
              Agent 的监听端口，用于接收来自 LLM Gateway 的请求
            </n-text>
          </template>
        </n-form-item>
        <n-form-item label="设为默认" path="isDefault">
          <n-switch v-model:value="formValue.isDefault" />
        </n-form-item>
        <n-form-item label="启用" path="enabled">
          <n-switch v-model:value="formValue.enabled" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end" :size="8">
          <n-button @click="showModal = false" size="small">取消</n-button>
          <n-button type="primary" size="small" :loading="submitting" @click="handleSubmit">
            {{ editingId ? '更新' : '创建' }}
          </n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal
      v-model:show="showAgentModal"
      preset="card"
      title="生成 Agent 安装脚本"
      style="width: 700px"
    >
      <n-form
        v-if="!installScriptGenerated"
        ref="agentFormRef"
        :model="agentFormValue"
        :rules="agentRules"
        label-placement="left"
        label-width="100"
        size="small"
      >
        <n-alert type="info" style="margin-bottom: 16px">
          <div style="font-size: 13px;">需要在目标服务器执行生成的安装命令（需要 Docker 环境）</div>
        </n-alert>
        <n-form-item label="网关名称" path="name">
          <n-input v-model:value="agentFormValue.name" placeholder="例如: US Gateway" />
        </n-form-item>
        <n-form-item label="服务器地址" path="serverAddress">
          <n-space vertical :size="4" style="width: 100%">
            <n-input
              v-model:value="agentFormValue.serverAddress"
              placeholder="填写 IP 地址或域名，例如: 192.168.1.100"
              @input="updateGatewayUrl"
            />
            <n-text depth="3" style="font-size: 12px">
              只需填写 IP 地址或域名，不含端口号
            </n-text>
          </n-space>
        </n-form-item>
        <n-form-item label="Agent 端口" path="port">
          <n-space :size="8" style="width: 100%">
            <n-input-number
              v-model:value="agentFormValue.port"
              :min="1"
              :max="65535"
              style="flex: 1"
              :placeholder="String(AGENT_DEFAULTS.AGENT_PORT)"
              @update:value="updateGatewayUrl"
            />
            <n-button @click="generateRandomPort('agentFormValue')" size="small">随机端口</n-button>
          </n-space>
          <template #feedback>
            <n-text depth="3" style="font-size: 12px">
              Agent 的监听端口，用于接收来自 LLM Gateway 的请求
            </n-text>
          </template>
        </n-form-item>
        <n-form-item label="Agent URL" path="url">
          <n-input
            v-model:value="agentFormValue.url"
            placeholder="自动生成"
            readonly
          />
          <template #feedback>
            <n-text depth="3" style="font-size: 12px">
              Agent 的完整访问地址，LLM Gateway 将通过此地址与 Agent 通信
            </n-text>
          </template>
        </n-form-item>
        <n-form-item label="描述" path="description">
          <n-input
            v-model:value="agentFormValue.description"
            type="textarea"
            placeholder="网关用途说明"
            :rows="2"
          />
        </n-form-item>
        <n-form-item label="设为默认" path="isDefault">
          <n-switch v-model:value="agentFormValue.isDefault" />
        </n-form-item>
      </n-form>

      <div v-else>
        <n-alert type="success" style="margin-bottom: 16px">
          <template #header>
            <div style="font-size: 14px; font-weight: 500;">安装脚本已生成</div>
          </template>
          <div style="font-size: 13px;">请复制以下命令到目标服务器执行</div>
        </n-alert>

        <n-space vertical :size="12">
          <div>
            <div style="margin-bottom: 8px; font-weight: 500">一键安装命令</div>
            <n-input
              :value="generatedInstallCommand"
              type="textarea"
              readonly
              :rows="3"
              style="font-family: monospace; font-size: 12px"
            />
            <n-space :size="8" style="margin-top: 8px">
              <n-button size="small" @click="copyToClipboard(generatedInstallCommand, '安装命令')">
                <template #icon>
                  <n-icon><CopyOutline /></n-icon>
                </template>
                复制命令
              </n-button>
            </n-space>
          </div>

          <n-divider style="margin: 8px 0" />

          <div>
            <div style="margin-bottom: 8px; font-weight: 500">完整安装脚本</div>
            <n-input
              :value="generatedInstallScript"
              type="textarea"
              readonly
              :rows="10"
              style="font-family: monospace; font-size: 12px"
            />
            <n-space :size="8" style="margin-top: 8px">
              <n-button size="small" @click="copyToClipboard(generatedInstallScript, '安装脚本')">
                <template #icon>
                  <n-icon><CopyOutline /></n-icon>
                </template>
                复制脚本
              </n-button>
              <n-button size="small" @click="downloadScript">
                <template #icon>
                  <n-icon><DownloadOutline /></n-icon>
                </template>
                下载脚本
              </n-button>
            </n-space>
          </div>
        </n-space>
      </div>

      <template #footer>
        <n-space justify="end" :size="8">
          <n-button @click="closeAgentModal" size="small">
            {{ installScriptGenerated ? '关闭' : '取消' }}
          </n-button>
          <n-button
            v-if="!installScriptGenerated"
            type="primary"
            size="small"
            :loading="installing"
            @click="handleGenerateScript"
          >
            生成安装脚本
          </n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal
      v-model:show="showRuleModal"
      preset="card"
      :title="editingRuleId ? '编辑规则' : '创建规则'"
      style="width: 700px"
    >
      <n-form
        ref="ruleFormRef"
        :model="ruleFormValue"
        :rules="ruleFormRules"
        label-placement="left"
        label-width="120"
        size="small"
      >
        <n-form-item label="规则名称" path="name">
          <n-input v-model:value="ruleFormValue.name" placeholder="例如: DeepSeek to CN" />
        </n-form-item>
        <n-form-item label="目标网关" path="portkeyGatewayId">
          <n-select
            v-model:value="ruleFormValue.portkeyGatewayId"
            :options="gatewayOptions"
            placeholder="选择目标网关"
          />
        </n-form-item>
        <n-form-item label="规则类型" path="ruleType">
          <n-select
            v-model:value="ruleFormValue.ruleType"
            :options="ruleTypeOptions"
            placeholder="选择规则类型"
          />
        </n-form-item>
        <n-form-item label="规则值" path="ruleValue">
          <n-input
            v-model:value="ruleFormValue.ruleValue"
            :placeholder="getRuleValuePlaceholder(ruleFormValue.ruleType)"
          />
          <template #feedback>
            <n-text depth="3" style="font-size: 12px">
              {{ getRuleTypeDescription(ruleFormValue.ruleType) }}
            </n-text>
          </template>
        </n-form-item>
        <n-form-item label="优先级" path="priority">
          <n-input-number
            v-model:value="ruleFormValue.priority"
            :min="0"
            :max="1000"
            style="width: 100%"
            placeholder="数值越大优先级越高"
          />
          <template #feedback>
            <n-text depth="3" style="font-size: 12px">
              建议使用 100 的倍数,为后续插入规则预留空间
            </n-text>
          </template>
        </n-form-item>
        <n-form-item label="描述" path="description">
          <n-input
            v-model:value="ruleFormValue.description"
            type="textarea"
            placeholder="规则说明"
            :rows="2"
          />
        </n-form-item>
        <n-form-item label="启用" path="enabled">
          <n-switch v-model:value="ruleFormValue.enabled" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end" :size="8">
          <n-button @click="showRuleModal = false" size="small">取消</n-button>
          <n-button type="primary" size="small" :loading="ruleSubmitting" @click="handleRuleSubmit">
            {{ editingRuleId ? '更新' : '创建' }}
          </n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, h, onMounted, onUnmounted, computed } from 'vue';
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
  NIcon,
  NAlert,
  NText,
  NTabs,
  NTabPane,
  NSelect,
  NDivider,
  type FormInst,
  type FormRules,
} from 'naive-ui';
import {
  RefreshOutline,
  AddOutline,
  CloudDownloadOutline,
  CheckmarkCircleOutline,
  CloseCircleOutline,
  CopyOutline,
  DownloadOutline,
  DocumentTextOutline,
} from '@vicons/ionicons5';
import {
  EditOutlined,
  DeleteOutlined,
} from '@vicons/material';
import { portkeyGatewayApi, routingRuleApi, type PortkeyGateway, type RoutingRule } from '@/api/portkey-gateways';
import { AGENT_DEFAULTS } from '@/constants/agent';

const message = useMessage();

const gatewayLoading = ref(false);
const ruleLoading = ref(false);
const submitting = ref(false);
const ruleSubmitting = ref(false);
const installing = ref(false);
const showModal = ref(false);
const showAgentModal = ref(false);
const showRuleModal = ref(false);
const editingId = ref<string | null>(null);
const editingRuleId = ref<string | null>(null);
const gateways = ref<PortkeyGateway[]>([]);
const rules = ref<RoutingRule[]>([]);

const formRef = ref<FormInst | null>(null);
const agentFormRef = ref<FormInst | null>(null);
const ruleFormRef = ref<FormInst | null>(null);

const formValue = ref<{
  name: string;
  url: string;
  description: string;
  containerName: string;
  port: number;
  isDefault: boolean;
  enabled: boolean;
}>({
  name: '',
  url: '',
  description: '',
  containerName: '',
  port: AGENT_DEFAULTS.AGENT_PORT,
  isDefault: false,
  enabled: true,
});

const agentFormValue = ref<{
  name: string;
  serverAddress: string;
  url: string;
  port: number;
  description: string;
  isDefault: boolean;
}>({
  name: '',
  serverAddress: '',
  url: '',
  port: AGENT_DEFAULTS.AGENT_PORT,
  description: '',
  isDefault: false,
});

const installScriptGenerated = ref(false);
const generatedInstallScript = ref('');
const generatedInstallCommand = ref('');

const ruleFormValue = ref({
  name: '',
  description: '',
  portkeyGatewayId: '',
  ruleType: 'model_name' as 'model_name' | 'provider' | 'region' | 'pattern',
  ruleValue: '',
  priority: 100,
  enabled: true,
});

const gatewayFormRules: FormRules = {
  name: [{ required: true, message: '请输入网关名称', trigger: 'blur' }],
  url: [{ required: true, message: '请输入网关 URL', trigger: 'blur' }],
};

const agentRules: FormRules = {
  name: [{ required: true, message: '请输入网关名称', trigger: 'blur' }],
  serverAddress: [{ required: true, message: '请输入服务器地址', trigger: 'blur' }],
  url: [{ required: true, message: '请输入网关 URL', trigger: 'blur' }],
  port: [{ required: true, type: 'number', message: '请输入端口', trigger: 'blur' }],
};

const ruleFormRules: FormRules = {
  name: [{ required: true, message: '请输入规则名称', trigger: 'blur' }],
  portkeyGatewayId: [{ required: true, message: '请选择目标网关', trigger: 'change' }],
  ruleType: [{ required: true, message: '请选择规则类型', trigger: 'change' }],
  ruleValue: [{ required: true, message: '请输入规则值', trigger: 'blur' }],
  priority: [{ required: true, type: 'number', message: '请输入优先级', trigger: 'blur' }],
};

const ruleTypeOptions = [
  { label: '模型名称匹配', value: 'model_name' },
  { label: '提供商匹配', value: 'provider' },
  { label: '地区匹配', value: 'region' },
  { label: '正则表达式', value: 'pattern' },
];

const gatewayOptions = computed(() => {
  return gateways.value
    .filter(g => g.enabled)
    .map(g => ({
      label: `${g.name} (${g.url})`,
      value: g.id,
    }));
});

function getRuleTypeDescription(ruleType: string): string {
  const descriptions: Record<string, string> = {
    model_name: '支持通配符 *,例如: gpt-4* 匹配所有以 gpt-4 开头的模型',
    provider: '根据提供商名称匹配,例如: DeepSeek',
    region: '根据提供商 base_url 中的关键词匹配,例如: api.deepseek.com',
    pattern: '使用正则表达式匹配,例如: ^gpt-4.*turbo$',
  };
  return descriptions[ruleType] || '';
}

function getRuleValuePlaceholder(ruleType: string): string {
  const placeholders: Record<string, string> = {
    model_name: 'gpt-4*',
    provider: 'DeepSeek',
    region: 'api.deepseek.com',
    pattern: '^gpt-4.*turbo$',
  };
  return placeholders[ruleType] || '';
}

const gatewayLatency = ref<Record<string, number | null>>({});

const gatewayColumns = [
  {
    title: '名称',
    key: 'name',
    ellipsis: { tooltip: true },
  },
  {
    title: 'URL',
    key: 'url',
    ellipsis: { tooltip: true },
  },
  {
    title: '描述',
    key: 'description',
    ellipsis: { tooltip: true },
  },
  {
    title: '实时延迟',
    key: 'latency',
    width: 100,
    render: (row: PortkeyGateway) => {
      const latency = gatewayLatency.value[row.id];
      if (latency === null) {
        return h(NTag, { type: 'error', size: 'small' }, { default: () => '离线' });
      }
      if (latency === undefined) {
        return h(NTag, { type: 'default', size: 'small' }, { default: () => '检测中' });
      }
      const type = latency < 100 ? 'success' : latency < 300 ? 'warning' : 'error';
      return h(NTag, { type, size: 'small' }, { default: () => `${latency}ms` });
    },
  },
  {
    title: '安装状态',
    key: 'installStatus',
    width: 100,
    render: (row: PortkeyGateway) => {
      const statusMap: Record<string, { type: 'success' | 'warning' | 'error' | 'default', text: string }> = {
        pending: { type: 'warning', text: '待安装' },
        installed: { type: 'success', text: '已安装' },
        online: { type: 'success', text: '在线' },
        failed: { type: 'error', text: '安装失败' },
      };
      const status = statusMap[row.installStatus || 'pending'] || { type: 'default', text: '未知' };
      return h(NTag, { type: status.type, size: 'small' }, { default: () => status.text });
    },
  },
  {
    title: '状态',
    key: 'enabled',
    width: 80,
    render: (row: PortkeyGateway) => {
      return h(
        NTag,
        {
          type: row.enabled ? 'success' : 'default',
          size: 'small',
        },
        {
          default: () => (row.enabled ? '启用' : '禁用'),
          icon: () =>
            h(NIcon, null, {
              default: () => h(row.enabled ? CheckmarkCircleOutline : CloseCircleOutline),
            }),
        }
      );
    },
  },
  {
    title: '默认',
    key: 'isDefault',
    width: 80,
    render: (row: PortkeyGateway) => {
      return row.isDefault
        ? h(NTag, { type: 'info', size: 'small' }, { default: () => '默认' })
        : null;
    },
  },
  {
    title: '操作',
    key: 'actions',
    width: 200,
    render: (row: PortkeyGateway) => {
      return h(NSpace, { size: 6 }, {
        default: () => [
          h(NButton, {
            size: 'small',
            quaternary: true,
            circle: true,
            onClick: () => handleEdit(row),
          }, {
            icon: () => h(NIcon, null, { default: () => h(EditOutlined) }),
          }),
          row.apiKey ? h(NButton, {
            size: 'small',
            quaternary: true,
            circle: true,
            onClick: () => handleViewInstallScript(row),
          }, {
            icon: () => h(NIcon, null, { default: () => h(DocumentTextOutline) }),
          }) : null,
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
            default: () => '确定删除此网关吗?',
          }),
        ],
      });
    },
  },
];

const ruleColumns = [
  {
    title: '规则名称',
    key: 'name',
    ellipsis: { tooltip: true },
  },
  {
    title: '规则类型',
    key: 'ruleType',
    width: 120,
    render: (row: RoutingRule) => {
      const typeLabels: Record<string, string> = {
        model_name: '模型名称',
        provider: '提供商',
        region: '地区',
        pattern: '正则',
      };
      return h(
        NTag,
        { type: 'info', size: 'small' },
        { default: () => typeLabels[row.ruleType] || row.ruleType }
      );
    },
  },
  {
    title: '规则值',
    key: 'ruleValue',
    ellipsis: { tooltip: true },
  },
  {
    title: '目标网关',
    key: 'portkeyGatewayId',
    ellipsis: { tooltip: true },
    render: (row: RoutingRule) => {
      const gateway = gateways.value.find(g => g.id === row.portkeyGatewayId);
      return gateway ? gateway.name : row.portkeyGatewayId;
    },
  },
  {
    title: '优先级',
    key: 'priority',
    width: 80,
    sorter: (a: RoutingRule, b: RoutingRule) => b.priority - a.priority,
  },
  {
    title: '状态',
    key: 'enabled',
    width: 80,
    render: (row: RoutingRule) => {
      return h(
        NTag,
        {
          type: row.enabled ? 'success' : 'default',
          size: 'small',
        },
        {
          default: () => (row.enabled ? '启用' : '禁用'),
          icon: () =>
            h(NIcon, null, {
              default: () => h(row.enabled ? CheckmarkCircleOutline : CloseCircleOutline),
            }),
        }
      );
    },
  },
  {
    title: '操作',
    key: 'actions',
    width: 150,
    render: (row: RoutingRule) => {
      return h(NSpace, { size: 6 }, {
        default: () => [
          h(NButton, {
            size: 'small',
            quaternary: true,
            circle: true,
            onClick: () => handleEditRule(row),
          }, {
            icon: () => h(NIcon, null, { default: () => h(EditOutlined) }),
          }),
          h(NPopconfirm, {
            onPositiveClick: () => handleDeleteRule(row.id),
          }, {
            trigger: () => h(NButton, {
              size: 'small',
              quaternary: true,
              circle: true,
            }, {
              icon: () => h(NIcon, null, { default: () => h(DeleteOutlined) }),
            }),
            default: () => '确定删除此规则吗?',
          }),
        ],
      });
    },
  },
];

async function checkGatewayLatency(gateway: PortkeyGateway) {
  try {
    const result = await portkeyGatewayApi.checkHealth(gateway.id);
    if (result.success && result.latency !== null) {
      gatewayLatency.value[gateway.id] = result.latency;
    } else {
      gatewayLatency.value[gateway.id] = null;
    }
  } catch (error) {
    gatewayLatency.value[gateway.id] = null;
  }
}

async function checkAllGatewaysLatency() {
  const promises = gateways.value.map(gateway => checkGatewayLatency(gateway));
  await Promise.all(promises);
}

let latencyCheckInterval: number | null = null;

async function loadGateways() {
  try {
    gatewayLoading.value = true;
    gateways.value = await portkeyGatewayApi.getAll();
    await checkAllGatewaysLatency();
  } catch (error: any) {
    message.error(error.message || '加载网关列表失败');
  } finally {
    gatewayLoading.value = false;
  }
}

async function loadRules() {
  try {
    ruleLoading.value = true;
    rules.value = await routingRuleApi.getAll();
  } catch (error: any) {
    message.error(error.message || '加载规则列表失败');
  } finally {
    ruleLoading.value = false;
  }
}

function handleCreate() {
  editingId.value = null;
  formValue.value = {
    name: '',
    url: '',
    description: '',
    containerName: '',
    port: AGENT_DEFAULTS.AGENT_PORT,
    isDefault: false,
    enabled: true,
  };
  showModal.value = true;
}

function handleEdit(gateway: PortkeyGateway) {
  editingId.value = gateway.id;
  formValue.value = {
    name: gateway.name,
    url: gateway.url,
    description: gateway.description || '',
    containerName: gateway.containerName || '',
    port: gateway.port || AGENT_DEFAULTS.AGENT_PORT,
    isDefault: gateway.isDefault,
    enabled: gateway.enabled,
  };
  showModal.value = true;
}

async function handleSubmit() {
  try {
    await formRef.value?.validate();
    submitting.value = true;

    if (editingId.value) {
      await portkeyGatewayApi.update(editingId.value, formValue.value);
      message.success('网关更新成功');
    } else {
      await portkeyGatewayApi.create(formValue.value);
      message.success('网关创建成功');
    }

    showModal.value = false;
    await loadGateways();
  } catch (error: any) {
    if (error.message) {
      message.error(error.message);
    }
  } finally {
    submitting.value = false;
  }
}

async function handleDelete(id: string) {
  try {
    await portkeyGatewayApi.delete(id);
    message.success('网关删除成功');
    await loadGateways();
  } catch (error: any) {
    message.error(error.message || '删除失败');
  }
}

function handleInstallAgent() {
  agentFormValue.value = {
    name: '',
    serverAddress: '',
    url: '',
    port: AGENT_DEFAULTS.AGENT_PORT,
    description: '',
    isDefault: false,
  };
  installScriptGenerated.value = false;
  generatedInstallScript.value = '';
  generatedInstallCommand.value = '';
  showAgentModal.value = true;
}

function updateGatewayUrl() {
  const { serverAddress, port } = agentFormValue.value;
  if (serverAddress && port) {
    let cleanAddress = serverAddress.trim();
    cleanAddress = cleanAddress.replace(/^https?:\/\//, '');
    cleanAddress = cleanAddress.replace(/:\d+$/, '');
    cleanAddress = cleanAddress.replace(/\/$/, '');

    agentFormValue.value.url = `https://${cleanAddress}:${port}`;
  }
}


async function handleGenerateScript() {
  try {
    await agentFormRef.value?.validate();
    installing.value = true;

    const result = await portkeyGatewayApi.generateInstallScript(agentFormValue.value);

    if (result.success) {
      message.success(result.message || '安装脚本生成成功');
      installScriptGenerated.value = true;
      generatedInstallScript.value = result.installScript || '';
      generatedInstallCommand.value = result.installCommand || '';
      await loadGateways();
    } else {
      message.error(result.message || '生成安装脚本失败');
    }
  } catch (error: any) {
    message.error(error.message || '生成安装脚本失败');
  } finally {
    installing.value = false;
  }
}

function closeAgentModal() {
  showAgentModal.value = false;
  installScriptGenerated.value = false;
  generatedInstallScript.value = '';
  generatedInstallCommand.value = '';
}

function copyToClipboard(text: string, label: string) {
  navigator.clipboard.writeText(text).then(() => {
    message.success(`${label}已复制到剪贴板`);
  }).catch(() => {
    message.error('复制失败，请手动复制');
  });
}

function downloadScript() {
  const blob = new Blob([generatedInstallScript.value], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'install-portkey-gateway.sh';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  message.success('脚本下载成功');
}

async function handleViewInstallScript(gateway: PortkeyGateway) {
  try {
    installing.value = true;
    const result = await portkeyGatewayApi.getInstallScript(gateway.id);

    if (result.success) {
      installScriptGenerated.value = true;
      generatedInstallScript.value = result.installScript || '';
      generatedInstallCommand.value = result.installCommand || '';
      showAgentModal.value = true;
    } else {
      message.error(result.message || '获取安装脚本失败');
    }
  } catch (error: any) {
    message.error(error.message || '获取安装脚本失败');
  } finally {
    installing.value = false;
  }
}

function handleCreateRule() {
  editingRuleId.value = null;
  ruleFormValue.value = {
    name: '',
    description: '',
    portkeyGatewayId: '',
    ruleType: 'model_name',
    ruleValue: '',
    priority: 100,
    enabled: true,
  };
  showRuleModal.value = true;
}

function handleEditRule(rule: RoutingRule) {
  editingRuleId.value = rule.id;
  ruleFormValue.value = {
    name: rule.name,
    description: rule.description || '',
    portkeyGatewayId: rule.portkeyGatewayId,
    ruleType: rule.ruleType,
    ruleValue: rule.ruleValue,
    priority: rule.priority,
    enabled: rule.enabled,
  };
  showRuleModal.value = true;
}

async function handleRuleSubmit() {
  try {
    await ruleFormRef.value?.validate();
    ruleSubmitting.value = true;

    if (editingRuleId.value) {
      await routingRuleApi.update(editingRuleId.value, ruleFormValue.value);
      message.success('规则更新成功');
    } else {
      await routingRuleApi.create(ruleFormValue.value);
      message.success('规则创建成功');
    }

    showRuleModal.value = false;
    await loadRules();
  } catch (error: any) {
    if (error.message) {
      message.error(error.message);
    }
  } finally {
    ruleSubmitting.value = false;
  }
}

async function handleDeleteRule(id: string) {
  try {
    await routingRuleApi.delete(id);
    message.success('规则删除成功');
    await loadRules();
  } catch (error: any) {
    message.error(error.message || '删除失败');
  }
}

function generateRandomPort(targetForm: 'formValue' | 'agentFormValue') {
  const min = 8000;
  const max = 65535;
  const randomPort = Math.floor(Math.random() * (max - min + 1)) + min;

  if (targetForm === 'formValue') {
    formValue.value.port = randomPort;
  } else {
    agentFormValue.value.port = randomPort;
  }

  message.success(`已生成随机端口: ${randomPort}`);
}

onMounted(async () => {
  await Promise.all([loadGateways(), loadRules()]);

  latencyCheckInterval = window.setInterval(() => {
    checkAllGatewaysLatency();
  }, 30000);
});

onUnmounted(() => {
  if (latencyCheckInterval !== null) {
    clearInterval(latencyCheckInterval);
  }
});
</script>

<style scoped>
.portkey-gateways-view {
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
</style>

<template>
  <div>
    <n-space vertical :size="24">
      <n-card :title="t('apiGuide.endpointConfig')">
        <n-space vertical :size="16">
          <n-alert type="info">
            {{ t('apiGuide.endpointConfigDesc') }}
          </n-alert>

          <n-descriptions :column="1" bordered>
            <n-descriptions-item :label="t('apiGuide.gatewayApiAddress')">
              <n-text code>{{ llmGatewayUrl }}</n-text>
              <n-button text @click="copyToClipboard(llmGatewayUrl)" style="margin-left: 8px;">
                {{ t('common.copy') }}
              </n-button>
            </n-descriptions-item>
            <n-descriptions-item :label="t('apiGuide.authMethod')">
              {{ t('apiGuide.authMethodDesc') }}
            </n-descriptions-item>
          </n-descriptions>
        </n-space>
      </n-card>

      <n-card :title="t('apiGuide.onlineApiTest')">
        <n-space vertical :size="16">

          <n-collapse>
            <n-collapse-item :title="t('apiGuide.chatCompletions')" name="chat-completions">
              <n-space vertical :size="16">
                <n-form label-placement="left" label-width="100">
                  <n-form-item :label="t('apiGuide.virtualKey')">
                    <n-select
                      v-model:value="selectedVirtualKey"
                      :options="virtualKeyOptions"
                      :placeholder="t('apiGuide.selectVirtualKey')"
                      clearable
                    />
                  </n-form-item>
                  <n-form-item :label="t('apiGuide.model')">
                    <n-select
                      v-model:value="selectedModel"
                      :options="modelOptions"
                      :placeholder="t('apiGuide.selectModel')"
                      clearable
                      filterable
                    />
                  </n-form-item>
                  <n-form-item :label="t('apiGuide.requestTemplate')">
                    <n-select
                      v-model:value="selectedTemplate"
                      :options="templateOptions"
                      :placeholder="t('apiGuide.selectTemplate')"
                      @update:value="applyTemplate"
                    />
                  </n-form-item>
                </n-form>

                <div>
                  <n-text strong>{{ t('apiGuide.requestBody') }}</n-text>
                  <n-input
                    v-model:value="requestBody"
                    type="textarea"
                    :rows="12"
                    :placeholder="t('apiGuide.inputRequestBody')"
                    style="margin-top: 8px; font-family: monospace;"
                  />
                </div>

                <n-space>
                  <n-button type="primary" @click="sendRequest" :loading="sending" :disabled="!selectedVirtualKey">
                    <template #icon>
                      <n-icon><SendOutline /></n-icon>
                    </template>
                    {{ t('apiGuide.sendRequest') }}
                  </n-button>
                  <n-button @click="clearResponse">
                    {{ t('apiGuide.clearResponse') }}
                  </n-button>
                </n-space>

                <div v-if="response">
                  <n-divider />
                  <n-space vertical :size="12">
                    <n-space align="center">
                      <n-text strong>{{ t('common.responseStatus') }}:</n-text>
                      <n-tag :type="response.status >= 200 && response.status < 300 ? 'success' : 'error'">
                        {{ response.status }} {{ response.statusText }}
                      </n-tag>
                      <n-text depth="3">{{ t('common.responseTime') }}: {{ response.duration }}ms</n-text>
                    </n-space>

                    <div v-if="response.headers">
                      <n-text strong>{{ t('common.responseHeaders') }}</n-text>
                      <pre class="code-block" style="margin-top: 8px;">{{ formatJson(response.headers) }}</pre>
                    </div>

                    <div>
                      <n-text strong>{{ t('common.responseBody') }}</n-text>
                      <pre class="code-block" style="margin-top: 8px;">{{ formatJson(response.data) }}</pre>
                    </div>
                  </n-space>
                </div>
              </n-space>
            </n-collapse-item>

            <n-collapse-item title="GET /models - 获取模型列表" name="models">
              <n-space vertical :size="16">
                <n-form label-placement="left" label-width="100">
                  <n-form-item label="虚拟密钥">
                    <n-select
                      v-model:value="selectedVirtualKeyModels"
                      :options="virtualKeyOptions"
                      placeholder="选择虚拟密钥"
                      clearable
                    />
                  </n-form-item>
                </n-form>

                <n-space>
                  <n-button type="primary" @click="getModels" :loading="gettingModels" :disabled="!selectedVirtualKeyModels">
                    <template #icon>
                      <n-icon><SendOutline /></n-icon>
                    </template>
                    获取模型列表
                  </n-button>
                  <n-button @click="clearModelsResponse">
                    清空响应
                  </n-button>
                </n-space>

                <div v-if="modelsResponse">
                  <n-divider />
                  <n-space vertical :size="12">
                    <n-space align="center">
                      <n-text strong>响应状态:</n-text>
                      <n-tag :type="modelsResponse.status >= 200 && modelsResponse.status < 300 ? 'success' : 'error'">
                        {{ modelsResponse.status }} {{ modelsResponse.statusText }}
                      </n-tag>
                      <n-text depth="3">响应时间: {{ modelsResponse.duration }}ms</n-text>
                    </n-space>

                    <div>
                      <n-text strong>响应体</n-text>
                      <pre class="code-block" style="margin-top: 8px;">{{ formatJson(modelsResponse.data) }}</pre>
                    </div>
                  </n-space>
                </div>
              </n-space>
            </n-collapse-item>
          </n-collapse>
        </n-space>
      </n-card>

      <n-card title="使用示例">
        <n-tabs type="line">
          <n-tab-pane name="curl" tab="cURL">
            <pre class="code-block">{{ curlExample }}</pre>
            <n-button @click="copyToClipboard(curlExample)" style="margin-top: 12px;">
              复制代码
            </n-button>
          </n-tab-pane>

          <n-tab-pane name="python" tab="Python">
            <pre class="code-block">{{ pythonExample }}</pre>
            <n-button @click="copyToClipboard(pythonExample)" style="margin-top: 12px;">
              复制代码
            </n-button>
          </n-tab-pane>

          <n-tab-pane name="javascript" tab="JavaScript">
            <pre class="code-block">{{ javascriptExample }}</pre>
            <n-button @click="copyToClipboard(javascriptExample)" style="margin-top: 12px;">
              复制代码
            </n-button>
          </n-tab-pane>

          <n-tab-pane name="nodejs" tab="Node.js">
            <pre class="code-block">{{ nodejsExample }}</pre>
            <n-button @click="copyToClipboard(nodejsExample)" style="margin-top: 12px;">
              复制代码
            </n-button>
          </n-tab-pane>
        </n-tabs>
      </n-card>

      <n-card title="配置说明">
        <n-space vertical :size="12">
          <div>
            <n-text strong>1. 创建虚拟密钥</n-text>
            <n-text depth="3" style="display: block; margin-top: 8px;">
              在"虚拟密钥"页面创建一个新的虚拟密钥，并关联到相应的提供商。
            </n-text>
          </div>

          <div>
            <n-text strong>2. 配置 API 端点</n-text>
            <n-text depth="3" style="display: block; margin-top: 8px;">
              将您的应用程序的 API 端点设置为：<n-text code>{{ llmGatewayUrl }}</n-text>
            </n-text>
          </div>

          <div>
            <n-text strong>3. 使用虚拟密钥</n-text>
            <n-text depth="3" style="display: block; margin-top: 8px;">
              在请求头中使用虚拟密钥作为 Bearer Token：<n-text code>Authorization: Bearer YOUR_VIRTUAL_KEY</n-text>
            </n-text>
          </div>

          <div>
            <n-text strong>4. 请求流程</n-text>
            <n-text depth="3" style="display: block; margin-top: 8px;">
              客户端 → LLM Gateway (虚拟密钥验证) → Portkey Gateway (提供商路由) → AI 提供商
            </n-text>
          </div>
        </n-space>
      </n-card>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { configApi } from '@/api/config';
import {
  useMessage,
  NSpace,
  NCard,
  NAlert,
  NDescriptions,
  NDescriptionsItem,
  NText,
  NTag,
  NButton,
  NTabs,
  NTabPane,
  NCollapse,
  NCollapseItem,
  NForm,
  NFormItem,
  NSelect,
  NInput,
  NDivider,
  NIcon,
} from 'naive-ui';
import { SendOutline } from '@vicons/ionicons5';
import { useVirtualKeyStore } from '@/stores/virtual-key';
import { useModelStore } from '@/stores/model';
import { formatJson, copyToClipboard } from '@/utils/common';

const { t } = useI18n();
const message = useMessage();
const virtualKeyStore = useVirtualKeyStore();
const modelStore = useModelStore();

const selectedVirtualKey = ref<string | null>(null);
const selectedVirtualKeyModels = ref<string | null>(null);
const selectedModel = ref<string | null>(null);
const selectedTemplate = ref<string | null>(null);
const requestBody = ref('');
const sending = ref(false);
const gettingModels = ref(false);
const response = ref<any>(null);
const modelsResponse = ref<any>(null);

const llmGatewayUrl = ref<string>('http://localhost:3000');

const curlExample = computed(() => `curl ${llmGatewayUrl.value}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_VIRTUAL_KEY" \\
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [
      {
        "role": "user",
        "content": "Hello!"
      }
    ]
  }'`);

const pythonExample = computed(() => `from openai import OpenAI

client = OpenAI(
    api_key="YOUR_VIRTUAL_KEY",
    base_url="${llmGatewayUrl.value}"
)

response = client.chat.completions.create(
    model="gpt-3.5-turbo",
    messages=[
        {"role": "user", "content": "Hello!"}
    ]
)

print(response.choices[0].message.content)`);

const javascriptExample = computed(() => `import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'YOUR_VIRTUAL_KEY',
  baseURL: '${llmGatewayUrl.value}'
});

const response = await client.chat.completions.create({
  model: 'gpt-3.5-turbo',
  messages: [
    { role: 'user', content: 'Hello!' }
  ]
});

console.log(response.choices[0].message.content);`);

const nodejsExample = computed(() => `const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: 'YOUR_VIRTUAL_KEY',
  baseURL: '${llmGatewayUrl.value}/v1'
});

async function main() {
  const response = await client.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [
      { role: 'user', content: 'Hello!' }
    ]
  });

  console.log(response.choices[0].message.content);
}

main();`);

const virtualKeyOptions = computed(() => {
  return virtualKeyStore.virtualKeys
    .filter(vk => vk.enabled)
    .map(vk => ({
      label: `${vk.name} (${vk.keyValue.substring(0, 20)}...)`,
      value: vk.keyValue,
    }));
});

const modelOptions = computed(() => {
  const uniqueModels = new Map<string, { label: string; value: string }>();
  
  modelStore.models
    .filter(m => m.enabled)
    .forEach(m => {
      const key = `${m.providerName}-${m.name}`;
      if (!uniqueModels.has(key)) {
        uniqueModels.set(key, {
          label: `${m.providerName} (${m.name})`,
          value: m.modelIdentifier,
        });
      }
    });
  
  return Array.from(uniqueModels.values());
});

const templateOptions = [
  {
    label: '简单对话',
    value: 'simple-chat',
  },
  {
    label: '系统提示词对话',
    value: 'system-chat',
  },
  {
    label: '流式响应',
    value: 'stream-chat',
  },
  {
    label: '多轮对话',
    value: 'multi-turn-chat',
  },
];

function applyTemplate(templateValue: string | null) {
  if (!templateValue) return;

  const model = selectedModel.value || 'gpt-3.5-turbo';

  const templates: Record<string, string> = {
    'simple-chat': JSON.stringify({
      model,
      messages: [
        { role: 'user', content: 'Hello! How are you?' }
      ]
    }, null, 2),
    'system-chat': JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is the capital of France?' }
      ]
    }, null, 2),
    'stream-chat': JSON.stringify({
      model,
      messages: [
        { role: 'user', content: 'Tell me a short story.' }
      ],
      stream: true
    }, null, 2),
    'multi-turn-chat': JSON.stringify({
      model,
      messages: [
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: '2+2 equals 4.' },
        { role: 'user', content: 'What about 3+3?' }
      ]
    }, null, 2),
  };

  requestBody.value = templates[templateValue] || '';
}

async function sendRequest() {
  if (!selectedVirtualKey.value) {
    message.error('请选择虚拟密钥');
    return;
  }

  try {
    sending.value = true;
    const startTime = Date.now();

    const res = await fetch(`${llmGatewayUrl.value}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${selectedVirtualKey.value}`,
      },
      body: requestBody.value,
    });

    const duration = Date.now() - startTime;
    const data = await res.json();

    response.value = {
      status: res.status,
      statusText: res.statusText,
      duration,
      headers: Object.fromEntries(res.headers.entries()),
      data,
    };
  } catch (error: any) {
    message.error(error.message || '请求失败');
  } finally {
    sending.value = false;
  }
}

async function getModels() {
  if (!selectedVirtualKeyModels.value) {
    message.error('请选择虚拟密钥');
    return;
  }

  try {
    gettingModels.value = true;
    const startTime = Date.now();

    const res = await fetch(`${llmGatewayUrl.value}/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${selectedVirtualKeyModels.value}`,
      },
    });

    const duration = Date.now() - startTime;
    const data = await res.json();

    modelsResponse.value = {
      status: res.status,
      statusText: res.statusText,
      duration,
      data,
    };
  } catch (error: any) {
    message.error(error.message || '请求失败');
  } finally {
    gettingModels.value = false;
  }
}

function clearResponse() {
  response.value = null;
}

function clearModelsResponse() {
  modelsResponse.value = null;
}

onMounted(async () => {
  await Promise.all([
    virtualKeyStore.fetchVirtualKeys(),
    modelStore.fetchModels(),
  ]);

  try {
    const settings = await configApi.getSystemSettings();
    if (settings && settings.publicUrl) {
      llmGatewayUrl.value = settings.publicUrl;
    }
  } catch (e) {}

  if (modelOptions.value.length > 0) {
    selectedModel.value = modelOptions.value[0].value;
  }
});
</script>

<style scoped>
:deep(.n-collapse-item__header) {
  font-weight: 500;
  font-size: 14px;
}

:deep(.n-input__textarea-el) {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
}

.code-block {
  background-color: #f6f8fa;
  border: 1px solid #e1e4e8;
  border-radius: 6px;
  padding: 16px;
  overflow: auto;
  max-height: 400px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.5;
  color: #24292e;
  margin: 0;
  white-space: pre-wrap;
  word-wrap: break-word;
}
</style>

<template>
  <div>
    <n-space vertical :size="24">
      <n-card title="API 端点配置">
        <n-space vertical :size="16">
          <n-alert type="info">
            使用虚拟密钥访问 LLM Gateway API,请求将经过虚拟密钥验证后转发到 Portkey Gateway,最终路由到配置的 AI 提供商。
          </n-alert>

          <n-descriptions :column="1" bordered>
            <n-descriptions-item label="LLM Gateway API 地址">
              <n-text code>{{ llmGatewayUrl }}</n-text>
              <n-button text type="primary" @click="copyText(llmGatewayUrl)" style="margin-left: 8px;">
                复制
              </n-button>
            </n-descriptions-item>
            <n-descriptions-item label="Portkey Gateway 状态">
              <n-space align="center">
                <n-tag :type="gatewayStatus?.running ? 'success' : 'error'">
                  {{ gatewayStatus?.running ? '运行中' : '未运行' }}
                </n-tag>
                <n-text depth="3" style="margin-left: 8px;">{{ portkeyGatewayUrl }}</n-text>
                <n-button text type="primary" @click="checkGatewayStatus" :loading="checkingStatus">
                  刷新状态
                </n-button>
              </n-space>
            </n-descriptions-item>
            <n-descriptions-item label="认证方式">
              Bearer Token (使用虚拟密钥)
            </n-descriptions-item>
          </n-descriptions>
        </n-space>
      </n-card>

      <n-card title="使用示例">
        <n-tabs type="line">
          <n-tab-pane name="curl" tab="cURL">
            <n-code :code="curlExample" />
            <n-button type="primary" @click="copyText(curlExample)" style="margin-top: 12px;">
              复制代码
            </n-button>
          </n-tab-pane>

          <n-tab-pane name="python" tab="Python">
            <n-code :code="pythonExample" />
            <n-button type="primary" @click="copyText(pythonExample)" style="margin-top: 12px;">
              复制代码
            </n-button>
          </n-tab-pane>

          <n-tab-pane name="javascript" tab="JavaScript">
            <n-code :code="javascriptExample" />
            <n-button type="primary" @click="copyText(javascriptExample)" style="margin-top: 12px;">
              复制代码
            </n-button>
          </n-tab-pane>

          <n-tab-pane name="nodejs" tab="Node.js">
            <n-code :code="nodejsExample" />
            <n-button type="primary" @click="copyText(nodejsExample)" style="margin-top: 12px;">
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
import { useMessage, NSpace, NCard, NAlert, NDescriptions, NDescriptionsItem, NText, NTag, NButton, NTabs, NTabPane, NCode } from 'naive-ui';
import { configApi } from '@/api/config';

const message = useMessage();
const gatewayStatus = ref<any>(null);
const checkingStatus = ref(false);

const llmGatewayUrl = 'http://localhost:3000';
const portkeyGatewayUrl = computed(() => gatewayStatus.value?.url || 'http://localhost:8787');

const curlExample = computed(() => `curl ${llmGatewayUrl}/chat/completions \\
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
    base_url="${llmGatewayUrl}"
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
  baseURL: '${llmGatewayUrl}'
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
  baseURL: '${llmGatewayUrl}/v1'
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

async function checkGatewayStatus() {
  try {
    checkingStatus.value = true;
    gatewayStatus.value = await configApi.getGatewayStatus();

    if (gatewayStatus.value.running) {
      message.success('Gateway 运行正常');
    } else {
      message.warning('Gateway 未运行，请先启动 Portkey Gateway');
    }
  } catch (error: any) {
    message.error(error.message);
  } finally {
    checkingStatus.value = false;
  }
}

function copyText(text: string) {
  navigator.clipboard.writeText(text).then(() => {
    message.success('已复制到剪贴板');
  }).catch(() => {
    message.error('复制失败');
  });
}

onMounted(() => {
  checkGatewayStatus();
});
</script>


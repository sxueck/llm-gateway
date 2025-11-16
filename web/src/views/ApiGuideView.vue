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

            <n-collapse-item title="POST /v1/messages - Anthropic 协议" name="anthropic-messages">
              <n-space vertical :size="16">
                <n-form label-placement="left" label-width="100">
                  <n-form-item label="虚拟密钥">
                    <n-select
                      v-model:value="selectedVirtualKeyAnthropic"
                      :options="virtualKeyOptions"
                      placeholder="选择虚拟密钥"
                      clearable
                    />
                  </n-form-item>
                  <n-form-item label="模型">
                    <n-select
                      v-model:value="selectedModelAnthropic"
                      :options="modelOptions"
                      placeholder="选择模型"
                      clearable
                      filterable
                    />
                  </n-form-item>
                  <n-form-item label="请求模板">
                    <n-select
                      v-model:value="selectedTemplateAnthropic"
                      :options="anthropicTemplateOptions"
                      placeholder="选择模板"
                      @update:value="applyAnthropicTemplate"
                    />
                  </n-form-item>
                </n-form>

                <div>
                  <n-text strong>请求体</n-text>
                  <n-input
                    v-model:value="requestBodyAnthropic"
                    type="textarea"
                    :rows="12"
                    placeholder="输入请求体"
                    style="margin-top: 8px; font-family: monospace;"
                  />
                </div>

                <n-space>
                  <n-button type="primary" @click="sendAnthropicRequest" :loading="sendingAnthropic" :disabled="!selectedVirtualKeyAnthropic">
                    <template #icon>
                      <n-icon><SendOutline /></n-icon>
                    </template>
                    发送请求
                  </n-button>
                  <n-button @click="clearAnthropicResponse">
                    清空响应
                  </n-button>
                </n-space>

                <div v-if="anthropicResponse">
                  <n-divider />
                  <n-space vertical :size="12">
                    <n-space align="center">
                      <n-text strong>响应状态:</n-text>
                      <n-tag :type="anthropicResponse.status >= 200 && anthropicResponse.status < 300 ? 'success' : 'error'">
                        {{ anthropicResponse.status }} {{ anthropicResponse.statusText }}
                      </n-tag>
                      <n-text depth="3">响应时间: {{ anthropicResponse.duration }}ms</n-text>
                    </n-space>

                    <div v-if="anthropicResponse.headers">
                      <n-text strong>响应头</n-text>
                      <pre class="code-block" style="margin-top: 8px;">{{ formatJson(anthropicResponse.headers) }}</pre>
                    </div>

                    <div>
                      <n-text strong>响应体</n-text>
                      <pre class="code-block" style="margin-top: 8px;">{{ formatJson(anthropicResponse.data) }}</pre>
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
const selectedVirtualKeyAnthropic = ref<string | null>(null);
const selectedModel = ref<string | null>(null);
const selectedModelAnthropic = ref<string | null>(null);
const selectedTemplate = ref<string | null>(null);
const selectedTemplateAnthropic = ref<string | null>(null);
const requestBody = ref('');
const requestBodyAnthropic = ref('');
const sending = ref(false);
const sendingAnthropic = ref(false);
const gettingModels = ref(false);
const response = ref<any>(null);
const anthropicResponse = ref<any>(null);
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
      // 使用 modelIdentifier 作为唯一键，确保每个模型只出现一次
      const key = m.modelIdentifier;
      if (!uniqueModels.has(key)) {
        uniqueModels.set(key, {
          label: `${m.providerName} - ${m.name}`,
          value: m.modelIdentifier,
        });
      }
    });
  
  // 转换为数组并按 label 排序，确保顺序稳定
  return Array.from(uniqueModels.values()).sort((a, b) =>
    a.label.localeCompare(b.label)
  );
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
  {
    label: '动态压缩测试',
    value: 'compression-test',
  },
];

const anthropicTemplateOptions = [
  {
    label: '简单对话',
    value: 'anthropic-simple',
  },
  {
    label: '系统提示词对话',
    value: 'anthropic-system',
  },
  {
    label: '流式响应',
    value: 'anthropic-stream',
  },
  {
    label: '多轮对话',
    value: 'anthropic-multi-turn',
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
    'compression-test': JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: '请帮我分析以下代码：\n```python\ndef fibonacci(n):\n    if n <= 1:\n        return n\n    return fibonacci(n-1) + fibonacci(n-2)\n\nfor i in range(10):\n    print(fibonacci(i))\n```\n这段代码的时间复杂度是多少？'
        },
        {
          role: 'assistant',
          content: '这是一个递归实现的斐波那契数列函数。时间复杂度是 O(2^n)，因为每次调用会产生两个子调用，形成指数级增长。空间复杂度是 O(n)，取决于递归调用栈的深度。'
        },
        {
          role: 'user',
          content: '请帮我分析以下代码：\n```python\ndef fibonacci(n):\n    if n <= 1:\n        return n\n    return fibonacci(n-1) + fibonacci(n-2)\n\nfor i in range(10):\n    print(fibonacci(i))\n```\n这段代码有什么性能问题吗？能详细说明一下吗？'
        },
        {
          role: 'assistant',
          content: '这段代码存在严重的性能问题：\n\n1. **重复计算**：递归会导致大量重复计算。例如计算 fibonacci(5) 时，fibonacci(3) 会被计算多次。\n2. **指数时间复杂度**：随着 n 增大，计算时间呈指数级增长。\n3. **栈溢出风险**：对于较大的 n 值，可能导致递归栈溢出。\n\n建议使用动态规划或迭代方式优化，可以将时间复杂度降低到 O(n)。'
        },
        {
          role: 'user',
          content: '能否提供一个优化版本？最好包含多种实现方式。'
        },
        {
          role: 'assistant',
          content: '当然可以！这里提供三种优化方案：\n\n**方案1：动态规划（自底向上）**\n```python\ndef fibonacci_dp(n):\n    if n <= 1:\n        return n\n    dp = [0] * (n + 1)\n    dp[1] = 1\n    for i in range(2, n + 1):\n        dp[i] = dp[i-1] + dp[i-2]\n    return dp[n]\n\nfor i in range(10):\n    print(fibonacci_dp(i))\n```\n\n**方案2：空间优化的迭代**\n```python\ndef fibonacci_iter(n):\n    if n <= 1:\n        return n\n    a, b = 0, 1\n    for _ in range(2, n + 1):\n        a, b = b, a + b\n    return b\n\nfor i in range(10):\n    print(fibonacci_iter(i))\n```\n\n**方案3：记忆化递归**\n```python\ndef fibonacci_memo(n, memo={}):\n    if n in memo:\n        return memo[n]\n    if n <= 1:\n        return n\n    memo[n] = fibonacci_memo(n-1, memo) + fibonacci_memo(n-2, memo)\n    return memo[n]\n\nfor i in range(10):\n    print(fibonacci_memo(i))\n```\n\n这三种方案的时间复杂度都是 O(n)，性能大幅提升。'
        },
        {
          role: 'user',
          content: '太好了！那么请帮我分析一下这三种方案的优缺点。另外，我还想看看原始代码：\n```python\ndef fibonacci(n):\n    if n <= 1:\n        return n\n    return fibonacci(n-1) + fibonacci(n-2)\n\nfor i in range(10):\n    print(fibonacci(i))\n```\n和优化后的代码在实际运行时的性能差异。'
        },
        {
          role: 'assistant',
          content: '很好的问题！让我详细对比一下：\n\n**三种优化方案对比：**\n\n1. **动态规划（自底向上）**\n   - 优点：逻辑清晰，易于理解，性能稳定\n   - 缺点：需要 O(n) 的额外空间存储数组\n   - 适用场景：需要保存所有中间结果的情况\n\n2. **空间优化的迭代**\n   - 优点：空间复杂度仅 O(1)，最节省内存\n   - 缺点：只能获取最终结果，无法保留中间值\n   - 适用场景：只需要计算单个斐波那契数\n\n3. **记忆化递归**\n   - 优点：保持递归的简洁性，同时避免重复计算\n   - 缺点：仍有递归调用开销，可能栈溢出\n   - 适用场景：需要多次调用且希望保持代码简洁\n\n**性能测试代码：**\n```python\nimport time\n\ndef benchmark(func, n, name):\n    start = time.time()\n    result = func(n)\n    end = time.time()\n    print(f"{name}: {result}, 耗时: {(end-start)*1000:.4f}ms")\n\nn = 35\nprint(f"计算 fibonacci({n}):")\nbenchmark(fibonacci, n, "原始递归")\nbenchmark(fibonacci_dp, n, "动态规划")\nbenchmark(fibonacci_iter, n, "迭代优化")\nbenchmark(fibonacci_memo, n, "记忆化递归")\n```\n\n**预期性能差异：**\n- 原始递归：约 3000-5000ms（n=35时）\n- 动态规划：约 0.01-0.02ms\n- 迭代优化：约 0.005-0.01ms\n- 记忆化递归：约 0.01-0.02ms\n\n可以看到优化后的方案性能提升了数十万倍！'
        },
        {
          role: 'user',
          content: '非常详细！现在我想测试一下这些代码。请问如何在实际项目中集成这些优化？另外，我注意到原始代码：\n```python\ndef fibonacci(n):\n    if n <= 1:\n        return n\n    return fibonacci(n-1) + fibonacci(n-2)\n\nfor i in range(10):\n    print(fibonacci(i))\n```\n在某些场景下可能还是有用的，比如教学演示。你觉得呢？'
        },
        {
          role: 'assistant',
          content: '你说得对！原始递归实现确实有其价值：\n\n**原始递归的适用场景：**\n1. **教学演示**：直观展示递归思想和问题分解\n2. **小规模数据**：当 n < 20 时，性能差异不明显\n3. **算法理解**：帮助理解递归的本质和性能陷阱\n\n**实际项目集成建议：**\n\n```python\nclass FibonacciCalculator:\n    """斐波那契数列计算器 - 支持多种算法\"\"\"\n    \n    def __init__(self, method="iter"):\n        self.method = method\n        self.memo = {}\n    \n    def calculate(self, n):\n        if self.method == "recursive":\n            return self._recursive(n)\n        elif self.method == "dp":\n            return self._dp(n)\n        elif self.method == "memo":\n            return self._memo(n)\n        else:\n            return self._iter(n)\n    \n    def _recursive(self, n):\n        if n <= 1:\n            return n\n        return self._recursive(n-1) + self._recursive(n-2)\n    \n    def _dp(self, n):\n        if n <= 1:\n            return n\n        dp = [0] * (n + 1)\n        dp[1] = 1\n        for i in range(2, n + 1):\n            dp[i] = dp[i-1] + dp[i-2]\n        return dp[n]\n    \n    def _iter(self, n):\n        if n <= 1:\n            return n\n        a, b = 0, 1\n        for _ in range(2, n + 1):\n            a, b = b, a + b\n        return b\n    \n    def _memo(self, n):\n        if n in self.memo:\n            return self.memo[n]\n        if n <= 1:\n            return n\n        self.memo[n] = self._memo(n-1) + self._memo(n-2)\n        return self.memo[n]\n\ncalc = FibonacciCalculator(method="iter")\nfor i in range(10):\n    print(f"F({i}) = {calc.calculate(i)}")\n```\n\n这样可以灵活切换不同实现，既保留了教学价值，又确保了生产环境的性能。'
        },
        {
          role: 'user',
          content: '完美！最后一个问题：如果我要计算非常大的斐波那契数（比如 n=1000），应该注意什么？'
        }
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

function applyAnthropicTemplate(templateValue: string | null) {
  if (!templateValue) return;

  const model = selectedModelAnthropic.value || 'claude-3-5-sonnet-20241022';

  const templates: Record<string, string> = {
    'anthropic-simple': JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'Hello! How are you?' }
      ]
    }, null, 2),
    'anthropic-system': JSON.stringify({
      model,
      max_tokens: 1024,
      system: 'You are a helpful assistant.',
      messages: [
        { role: 'user', content: 'What is the capital of France?' }
      ]
    }, null, 2),
    'anthropic-stream': JSON.stringify({
      model,
      max_tokens: 1024,
      stream: true,
      messages: [
        { role: 'user', content: 'Tell me a short story.' }
      ]
    }, null, 2),
    'anthropic-multi-turn': JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: '2+2 equals 4.' },
        { role: 'user', content: 'What about 3+3?' }
      ]
    }, null, 2),
  };

  requestBodyAnthropic.value = templates[templateValue] || '';
}

async function sendAnthropicRequest() {
  if (!selectedVirtualKeyAnthropic.value) {
    message.error('请选择虚拟密钥');
    return;
  }

  try {
    sendingAnthropic.value = true;
    const startTime = Date.now();

    const res = await fetch(`${llmGatewayUrl.value}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${selectedVirtualKeyAnthropic.value}`,
        'anthropic-version': '2023-06-01',
      },
      body: requestBodyAnthropic.value,
    });

    const duration = Date.now() - startTime;
    const data = await res.json();

    anthropicResponse.value = {
      status: res.status,
      statusText: res.statusText,
      duration,
      headers: Object.fromEntries(res.headers.entries()),
      data,
    };
  } catch (error: any) {
    message.error(error.message || '请求失败');
  } finally {
    sendingAnthropic.value = false;
  }
}

function clearAnthropicResponse() {
  anthropicResponse.value = null;
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
    selectedModelAnthropic.value = modelOptions.value[0].value;
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

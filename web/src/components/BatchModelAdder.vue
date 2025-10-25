<template>
  <div class="batch-model-adder">
    <n-space vertical :size="12">
      <n-space justify="space-between" align="center">
        <h4 class="section-title">批量添加模型</h4>
        <n-space :size="8">
          <n-button size="small" @click="addModel">
            <template #icon>
              <n-icon><AddOutline /></n-icon>
            </template>
            添加模型
          </n-button>
          <n-button
            size="small"
            @click="showBatchInput = true"
            :style="{ border: '1px solid #0f6b4a', borderRadius: '8px' }"
          >
            <template #icon>
              <n-icon><DocumentTextOutline /></n-icon>
            </template>
            批量输入
          </n-button>
        </n-space>
      </n-space>

      <div v-if="models.length === 0" class="empty-state">
        <n-empty description="暂无模型，点击上方按钮添加模型" size="small" />
      </div>

      <div v-else class="models-list">
        <n-card
          v-for="(model, index) in models"
          :key="index"
          size="small"
          class="model-card"
        >
          <template #header>
            <n-space justify="space-between" align="center">
              <span class="model-title">模型 {{ index + 1 }}</span>
              <n-button
                size="small"
                type="error"
                text
                @click="removeModel(index)"
              >
                <template #icon>
                  <n-icon><CloseOutline /></n-icon>
                </template>
              </n-button>
            </n-space>
          </template>

          <n-form :model="model" label-placement="left" label-width="80" size="small">
            <n-form-item label="模型名称" :rule="{ required: true, message: '请输入模型名称' }">
              <n-input
                v-model:value="model.name"
                placeholder="如: GPT-4 Turbo"
                size="small"
              />
            </n-form-item>
            <n-form-item label="模型标识符" :rule="{ required: true, message: '请输入模型标识符' }">
              <n-input
                v-model:value="model.modelIdentifier"
                placeholder="如: gpt-4-turbo-preview"
                size="small"
              />
            </n-form-item>
            <n-form-item label="描述">
              <n-input
                v-model:value="model.description"
                placeholder="可选"
                size="small"
              />
            </n-form-item>
            <n-form-item label="启用">
              <n-switch v-model:value="model.enabled" size="small" />
            </n-form-item>
          </n-form>
        </n-card>
      </div>

      <n-space v-if="models.length > 0" justify="end" style="margin-top: 16px">
        <n-button @click="clearAll" size="small">清空所有</n-button>
        <n-button type="primary" @click="handleBatchCreate" :loading="creating" size="small">
          创建 {{ models.length }} 个模型
        </n-button>
      </n-space>
    </n-space>

    <n-modal
      v-model:show="showBatchInput"
      preset="card"
      title="批量输入模型"
      :style="{ width: '600px' }"
    >
      <n-space vertical :size="12">
        <n-alert type="info" size="small">
          <div style="font-size: 13px;">
            每行一个模型，格式：模型名称|模型标识符|描述（可选）
            <br>
            示例：GPT-4 Turbo|gpt-4-turbo-preview|最新的GPT-4模型
          </div>
        </n-alert>
        
        <n-input
          v-model:value="batchInputText"
          type="textarea"
          placeholder="GPT-4 Turbo|gpt-4-turbo-preview|最新的GPT-4模型&#10;Claude 3 Opus|claude-3-opus-20240229|Anthropic最强模型"
          :rows="8"
          size="small"
        />
      </n-space>
      
      <template #footer>
        <n-space justify="end" :size="8">
          <n-button @click="showBatchInput = false" size="small">取消</n-button>
          <n-button type="primary" @click="handleBatchInputParse" size="small">
            解析并添加
          </n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import {
  NSpace,
  NButton,
  NCard,
  NForm,
  NFormItem,
  NInput,
  NSwitch,
  NAlert,
  NEmpty,
  NIcon,
  NModal,
  useMessage,
} from 'naive-ui';
import {
  AddOutline,
  CloseOutline,
  DocumentTextOutline,
} from '@vicons/ionicons5';

interface ModelInput {
  name: string;
  modelIdentifier: string;
  description?: string;
  enabled: boolean;
}

interface Props {
  providerId: string;
}

defineProps<Props>();
const emit = defineEmits<{
  create: [models: ModelInput[]];
}>();

const message = useMessage();
const models = ref<ModelInput[]>([]);
const creating = ref(false);
const showBatchInput = ref(false);
const batchInputText = ref('');

function addModel() {
  models.value.push({
    name: '',
    modelIdentifier: '',
    description: '',
    enabled: true,
  });
}

function removeModel(index: number) {
  models.value.splice(index, 1);
}

function clearAll() {
  models.value = [];
}

async function handleBatchCreate() {
  const validModels = models.value.filter(model => 
    model.name.trim() && model.modelIdentifier.trim()
  );

  if (validModels.length === 0) {
    message.warning('请至少添加一个有效的模型');
    return;
  }

  if (validModels.length !== models.value.length) {
    message.warning('存在未填写完整的模型，将只创建已填写完整的模型');
  }

  creating.value = true;
  try {
    emit('create', validModels);
  } finally {
    creating.value = false;
  }
}

function handleBatchInputParse() {
  if (!batchInputText.value.trim()) {
    message.warning('请输入模型信息');
    return;
  }

  const lines = batchInputText.value.trim().split('\n');
  const newModels: ModelInput[] = [];

  for (const line of lines) {
    const parts = line.trim().split('|');
    if (parts.length >= 2) {
      newModels.push({
        name: parts[0].trim(),
        modelIdentifier: parts[1].trim(),
        description: parts[2]?.trim() || '',
        enabled: true,
      });
    }
  }

  if (newModels.length === 0) {
    message.warning('未解析到有效的模型信息');
    return;
  }

  models.value.push(...newModels);
  showBatchInput.value = false;
  batchInputText.value = '';
  message.success(`已添加 ${newModels.length} 个模型`);
}

defineExpose({
  getModels: () => models.value,
  clearModels: () => { models.value = []; },
});
</script>

<style scoped>
.batch-model-adder {
  padding: 16px;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: #262626;
  margin: 0;
}

.empty-state {
  padding: 32px 0;
  text-align: center;
}

.models-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.model-card {
  border: 1px solid #e8e8e8;
  border-radius: 8px;
}

.model-title {
  font-size: 13px;
  font-weight: 600;
  color: #262626;
}

.model-card :deep(.n-card__header) {
  padding: 12px 16px;
  border-bottom: 1px solid #f0f0f0;
}

.model-card :deep(.n-card__content) {
  padding: 16px;
}
</style>

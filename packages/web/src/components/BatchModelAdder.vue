<template>
  <div class="batch-model-adder">
    <n-space vertical :size="12">
      <n-space justify="space-between" align="center">
        <h4 class="section-title">{{ t('models.batchAddTitle') }}</h4>
        <n-space :size="8">
          <n-button size="small" @click="addModel">
            <template #icon>
              <n-icon><AddOutline /></n-icon>
            </template>
            {{ t('models.addModel') }}
          </n-button>
          <n-button
            size="small"
            @click="showBatchInput = true"
            :style="{ border: '1px solid #0f6b4a', borderRadius: '8px' }"
          >
            <template #icon>
              <n-icon><DocumentTextOutline /></n-icon>
            </template>
            {{ t('models.batchInput') }}
          </n-button>
        </n-space>
      </n-space>

      <div v-if="models.length === 0" class="empty-state">
        <n-empty :description="t('models.batchEmpty')" size="small" />
      </div>

      <div v-else class="models-list">
        <n-card
          v-for="(model, index) in models"
          :key="model.modelIdentifier + '-' + index"
          size="small"
          class="model-card"
        >
          <template #header>
            <n-space justify="space-between" align="center">
              <span class="model-title">{{ t('models.modelIndex', { index: index + 1 }) }}</span>
              <n-button size="small" type="error" text @click="removeModel(index)">
                <template #icon>
                  <n-icon><CloseOutline /></n-icon>
                </template>
              </n-button>
            </n-space>
          </template>

          <n-form :model="model" label-placement="left" label-width="80" size="small">
            <n-form-item :label="t('models.modelName')" :rule="{ required: true, message: t('validation.modelNameRequired') }">
              <n-input v-model:value="model.name" :placeholder="t('models.batchNamePlaceholder')" size="small" />
            </n-form-item>
            <n-form-item :label="t('models.modelId')" :rule="{ required: true, message: t('validation.modelIdRequired') }">
              <n-input
                v-model:value="model.modelIdentifier"
                :placeholder="t('models.batchIdPlaceholder')"
                size="small"
              />
            </n-form-item>
            <n-form-item :label="t('common.description')">
              <n-input v-model:value="model.description" :placeholder="t('common.optional')" size="small" />
            </n-form-item>
            <n-form-item :label="t('common.enabled')">
              <n-switch v-model:value="model.enabled" size="small" />
            </n-form-item>
          </n-form>
        </n-card>
      </div>

      <n-space v-if="models.length > 0" justify="end" style="margin-top: 16px">
        <n-button @click="clearAll" size="small">{{ t('models.clearAll') }}</n-button>
        <n-button type="primary" @click="handleBatchCreate" :loading="creating" size="small">
          {{ t('models.createCount', { count: models.length }) }}
        </n-button>
      </n-space>
    </n-space>

    <n-modal
      v-model:show="showBatchInput"
      preset="card"
      :title="t('models.batchInputTitle')"
      :style="{ width: '600px', maxWidth: '92vw' }"
    >
      <n-space vertical :size="12">
        <n-alert type="info" size="small">
          <div style="font-size: 13px">
            {{ t('models.batchFormat') }}
            <br />
            {{ t('models.batchExample') }}
          </div>
        </n-alert>

        <n-input
          v-model:value="batchInputText"
          type="textarea"
          :placeholder="t('models.batchPlaceholder')"
          :rows="8"
          size="small"
        />
      </n-space>

      <template #footer>
        <n-space justify="end" :size="8">
          <n-button @click="showBatchInput = false" size="small">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" @click="handleBatchInputParse" size="small">{{ t('models.parseAndAdd') }}</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
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
  useMessage
} from 'naive-ui'
import { AddOutline, CloseOutline, DocumentTextOutline } from '@vicons/ionicons5'

interface ModelInput {
  name: string
  modelIdentifier: string
  description?: string
  enabled: boolean
}

interface Props {
  providerId: string
}

defineProps<Props>()
const emit = defineEmits<{
  create: [models: ModelInput[]]
}>()

const { t } = useI18n()
const message = useMessage()
const models = ref<ModelInput[]>([])
const creating = ref(false)
const showBatchInput = ref(false)
const batchInputText = ref('')

function addModel() {
  models.value.push({
    name: '',
    modelIdentifier: '',
    description: '',
    enabled: true
  })
}

function removeModel(index: number) {
  models.value.splice(index, 1)
}

function clearAll() {
  models.value = []
}

async function handleBatchCreate() {
  const validModels = models.value.filter(
    model => model.name.trim() && model.modelIdentifier.trim()
  )

  if (validModels.length === 0) {
    message.warning(t('models.needValidModel'))
    return
  }

  if (validModels.length !== models.value.length) {
    message.warning(t('models.incompleteModels'))
  }

  creating.value = true
  try {
    emit('create', validModels)
  } finally {
    creating.value = false
  }
}

function handleBatchInputParse() {
  if (!batchInputText.value.trim()) {
    message.warning(t('models.enterModelInfo'))
    return
  }

  const lines = batchInputText.value.trim().split('\n')
  const newModels: ModelInput[] = []

  for (const line of lines) {
    const parts = line.trim().split('|')
    if (parts.length >= 2) {
      newModels.push({
        name: parts[0].trim(),
        modelIdentifier: parts[1].trim(),
        description: parts[2]?.trim() || '',
        enabled: true
      })
    }
  }

  if (newModels.length === 0) {
    message.warning(t('models.parseNone'))
    return
  }

  models.value.push(...newModels)
  showBatchInput.value = false
  batchInputText.value = ''
  message.success(t('models.addedCount', { count: newModels.length }))
}

defineExpose({
  getModels: () => models.value,
  clearModels: () => {
    models.value = []
  }
})
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

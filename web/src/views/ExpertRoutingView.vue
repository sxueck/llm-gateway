<template>
  <div>
    <n-space vertical :size="12">
      <n-space justify="space-between" align="center">
        <div>
          <h2 class="page-title">{{ t('expertRouting.title') }}</h2>
          <p class="page-subtitle">{{ t('expertRouting.subtitle') }}</p>
        </div>
        <n-space :size="8">
          <n-button type="primary" size="small" @click="handleCreate">
            <template #icon>
              <n-icon><AddOutline /></n-icon>
            </template>
            {{ t('expertRouting.createExpertRouting') }}
          </n-button>
          <n-button size="small" @click="handleRefresh">
            <template #icon>
              <n-icon><RefreshOutline /></n-icon>
            </template>
            {{ t('common.refresh') }}
          </n-button>
        </n-space>
      </n-space>

      <n-alert v-if="showExperimentalAlert" type="info" closable @close="handleCloseExperimentalAlert">
        <template #header>
          <div style="font-size: 14px; font-weight: 500;">{{ t('expertRouting.experimentalFeature') }}</div>
        </template>
        <div style="font-size: 13px;">{{ t('expertRouting.experimentalFeatureDesc') }}</div>
      </n-alert>

      <n-spin :show="loading">
        <n-empty
          v-if="configs.length === 0 && !loading"
          :description="t('expertRouting.noConfigs')"
          :show-icon="false"
          style="padding: 60px 0"
        >
          <template #extra>
            <n-button type="primary" @click="handleCreate">
              {{ t('expertRouting.createFirstConfig') }}
            </n-button>
          </template>
        </n-empty>

        <div v-else class="config-grid">
          <n-card
            v-for="config in configs"
            :key="config.id"
            class="config-card"
            :style="{ width: cardWidth + 'px' }"
            hoverable
          >
            <template #header>
              <n-space justify="space-between" align="center">
                <n-space align="center" :size="8">
                  <n-text strong>{{ config.name }}</n-text>
                  <n-tag
                    :type="config.enabled ? 'success' : 'default'"
                    size="small"
                  >
                    {{ config.enabled ? t('common.enabled') : t('common.disabled') }}
                  </n-tag>
                </n-space>
                <n-switch
                  :value="config.enabled"
                  @update:value="(val) => handleToggleEnabled(config.id, val)"
                  size="small"
                  @click.stop
                />
              </n-space>
            </template>

            <div class="config-card-content">
              <div v-if="config.description" class="config-description">
                <n-text depth="3" style="font-size: 13px">{{ config.description }}</n-text>
              </div>

              <div
                class="visualization-preview"
                @click="handleEdit(config)"
              >
                <ExpertRoutingVisualization
                  :experts="config.config.experts"
                  :classifier-config="config.config.classifier"
                  :virtual-model-options="virtualModelOptions"
                  :editable="false"
                />
                <div
                  class="resize-handle"
                  @mousedown.stop="handleResizeStart($event)"
                  @click.stop
                >
                  <div class="resize-handle-line"></div>
                  <div v-if="isResizing" class="resize-tooltip">
                    {{ previewWidth }}px
                  </div>
                </div>
              </div>

              <div class="config-meta">
                <n-space :size="16">
                  <n-text depth="3" style="font-size: 12px">
                    <n-icon size="14" style="vertical-align: -2px; margin-right: 4px">
                      <FilterOutline />
                    </n-icon>
                    {{ t('expertRouting.classifier') }}: {{ getClassifierLabel(config.config.classifier) }}
                  </n-text>
                  <n-text depth="3" style="font-size: 12px">
                    <n-icon size="14" style="vertical-align: -2px; margin-right: 4px">
                      <CubeOutline />
                    </n-icon>
                    {{ t('expertRouting.expertCount') }}: {{ config.config.experts.length }}
                  </n-text>
                </n-space>
              </div>
            </div>

            <template #footer>
              <n-space justify="end" :size="8">
                <n-button
                  text
                  size="small"
                  @click.stop="handleShowStatistics(config.id)"
                >
                  <template #icon>
                    <n-icon><BarChartOutlined /></n-icon>
                  </template>
                  {{ t('expertRouting.statistics') }}
                </n-button>
                <n-button
                  text
                  size="small"
                  @click.stop="handleEdit(config)"
                >
                  <template #icon>
                    <n-icon><EditOutlined /></n-icon>
                  </template>
                  {{ t('common.edit') }}
                </n-button>
                <n-popconfirm
                  @positive-click="handleDelete(config.id)"
                  @click.stop
                >
                  <template #trigger>
                    <n-button
                      text
                      size="small"
                      type="error"
                      @click.stop
                    >
                      <template #icon>
                        <n-icon><DeleteOutlined /></n-icon>
                      </template>
                      {{ t('common.delete') }}
                    </n-button>
                  </template>
                  {{ t('expertRouting.deleteConfigConfirm') }}
                </n-popconfirm>
              </n-space>
            </template>
          </n-card>
        </div>
      </n-spin>
    </n-space>

    <n-modal
      v-model:show="showEditorModal"
      preset="card"
      :title="editingId ? t('expertRouting.editExpertRouting') : t('expertRouting.createExpertRouting')"
      class="expert-routing-modal"
      :style="{ width: '90%', maxWidth: '1200px', maxHeight: '85vh' }"
      :segmented="{
        content: 'soft',
        footer: 'soft'
      }"
    >
      <div class="modal-content-wrapper">
        <ExpertRoutingEditor
          v-if="showEditorModal"
          :config="editingConfig"
          :editing-id="editingId"
          @save="handleSave"
          @cancel="handleCancel"
          :saving="saving"
        />
      </div>
    </n-modal>

    <n-modal
      v-model:show="showStatisticsModal"
      preset="card"
      :title="t('expertRouting.statistics')"
      class="statistics-modal"
      :style="{ width: '800px', maxHeight: '85vh' }"
      :segmented="{
        content: 'soft',
        footer: 'soft'
      }"
    >
      <div class="modal-content-wrapper">
        <ExpertRoutingStatistics v-if="showStatisticsModal" :config-id="selectedConfigId" />
      </div>
    </n-modal>
  </div>
</template>

<style scoped>
.page-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.page-subtitle {
  margin: 4px 0 0 0;
  font-size: 13px;
  color: var(--n-text-color-3);
}

.config-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 16px;
}

.config-card {
  transition: all 0.3s ease;
  flex-shrink: 0;
}

.config-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.config-card-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.config-description {
  padding: 8px 0;
  border-bottom: 1px solid var(--n-border-color);
}

.visualization-preview {
  position: relative;
  cursor: pointer;
  padding: 16px;
  border: 1px solid var(--n-border-color);
  border-radius: 8px;
  background: #fafafa;
  transition: all 0.3s ease;
  width: 100%;
}

.visualization-preview:hover {
  border-color: #18a058;
  background: #f0f9f4;
}

.resize-handle {
  position: absolute;
  right: -4px;
  top: 0;
  bottom: 0;
  width: 12px;
  cursor: ew-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.2s;
  z-index: 10;
}

.visualization-preview:hover .resize-handle {
  opacity: 1;
}

.resize-handle:hover .resize-handle-line {
  width: 3px;
  height: 60px;
  background: #18a058;
}

.resize-handle-line {
  width: 2px;
  height: 40px;
  background: #18a058;
  border-radius: 2px;
  transition: all 0.2s;
  box-shadow: 0 0 4px rgba(24, 160, 88, 0.3);
}

.resize-tooltip {
  position: absolute;
  top: 50%;
  right: 20px;
  transform: translateY(-50%);
  background: #18a058;
  color: white;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.config-meta {
  padding-top: 8px;
  border-top: 1px solid var(--n-border-color);
}

@media (max-width: 768px) {
  .expert-routing-modal :deep(.n-card__content),
  .statistics-modal :deep(.n-card__content) {
    padding: 0;
    overflow: hidden;
  }

  .modal-content-wrapper {
    max-height: calc(85vh - 180px);
    overflow-y: auto;
    overflow-x: hidden;
    padding: 16px 20px;
  }

  .modal-content-wrapper::-webkit-scrollbar {
    width: 6px;
  }

  .modal-content-wrapper::-webkit-scrollbar-track {
    background: #f0f0f0;
    border-radius: 3px;
  }

  .modal-content-wrapper::-webkit-scrollbar-thumb {
    background: #d0d0d0;
    border-radius: 3px;
  }

  .modal-content-wrapper::-webkit-scrollbar-thumb:hover {
    background: #b0b0b0;
  }

  .expert-routing-modal :deep(.n-card__footer),
  .statistics-modal :deep(.n-card__footer) {
    padding: 12px 20px;
    border-top: 1px solid #e8e8e8;
    background: #ffffff;
  }
  .config-grid {
    flex-direction: column;
  }

  .config-card {
    width: 100% !important;
  }

  .resize-handle {
    display: none;
  }
}
</style>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  useMessage,
  NSpace,
  NCard,
  NButton,
  NIcon,
  NModal,
  NAlert,
  NSwitch,
  NPopconfirm,
  NSpin,
  NEmpty,
  NText,
  NTag,
} from 'naive-ui';
import {
  AddOutline,
  RefreshOutline,
  FilterOutline,
  CubeOutline,
} from '@vicons/ionicons5';
import {
  EditOutlined,
  DeleteOutlined,
  BarChartOutlined,
} from '@vicons/material';
import { expertRoutingApi, type ExpertRouting, type CreateExpertRoutingRequest } from '@/api/expert-routing';
import ExpertRoutingEditor from '@/components/ExpertRoutingEditor.vue';
import ExpertRoutingVisualization from '@/components/ExpertRoutingVisualization.vue';
import ExpertRoutingStatistics from '@/components/ExpertRoutingStatistics.vue';
import { useModelStore } from '@/stores/model';
import { createDefaultExpertRoutingConfig } from '@/utils/expert-routing';

const { t } = useI18n();
const message = useMessage();
const modelStore = useModelStore();

const virtualModels = computed(() => {
  return modelStore.models.filter(m => m.isVirtual);
});

const virtualModelOptions = computed(() => {
  return virtualModels.value.map(m => ({
    label: m.name,
    value: m.id,
  }));
});

const EXPERIMENTAL_ALERT_KEY = 'expert-routing-experimental-alert-closed';

const configs = ref<ExpertRouting[]>([]);
const loading = ref(false);
const showEditorModal = ref(false);
const showStatisticsModal = ref(false);
const editingId = ref<string | null>(null);
const editingConfig = ref<CreateExpertRoutingRequest>(createDefaultExpertRoutingConfig());
const selectedConfigId = ref<string>('');
const saving = ref(false);
const showExperimentalAlert = ref(localStorage.getItem(EXPERIMENTAL_ALERT_KEY) !== 'true');

const PREVIEW_WIDTH_KEY = 'expert-routing-preview-width';
const DEFAULT_PREVIEW_WIDTH = 600;
const MIN_PREVIEW_WIDTH = 400;
const MAX_PREVIEW_WIDTH = 1200;

const previewWidth = ref(Number.parseInt(localStorage.getItem(PREVIEW_WIDTH_KEY) || String(DEFAULT_PREVIEW_WIDTH), 10));
const isResizing = ref(false);
const resizeStartX = ref(0);
const resizeStartWidth = ref(0);

const cardWidth = computed(() => {
  const CARD_PADDING = 48;
  return previewWidth.value + CARD_PADDING;
});

function handleCloseExperimentalAlert() {
  showExperimentalAlert.value = false;
  localStorage.setItem(EXPERIMENTAL_ALERT_KEY, 'true');
}

function handleResizeStart(event: MouseEvent) {
  isResizing.value = true;
  resizeStartX.value = event.clientX;
  resizeStartWidth.value = previewWidth.value;

  document.addEventListener('mousemove', handleResizeMove);
  document.addEventListener('mouseup', handleResizeEnd);
  document.body.style.cursor = 'ew-resize';
  document.body.style.userSelect = 'none';
}

function handleResizeMove(event: MouseEvent) {
  if (!isResizing.value) return;

  const delta = event.clientX - resizeStartX.value;
  const newWidth = Math.max(MIN_PREVIEW_WIDTH, Math.min(MAX_PREVIEW_WIDTH, resizeStartWidth.value + delta));
  previewWidth.value = newWidth;
}

function handleResizeEnd() {
  if (!isResizing.value) return;

  isResizing.value = false;
  document.removeEventListener('mousemove', handleResizeMove);
  document.removeEventListener('mouseup', handleResizeEnd);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';

  localStorage.setItem(PREVIEW_WIDTH_KEY, String(previewWidth.value));
  savePreviewWidthToServer(previewWidth.value);
}

async function savePreviewWidthToServer(width: number) {
  try {
    await expertRoutingApi.savePreviewWidth(width);
  } catch (error) {
    console.error('保存预览宽度失败:', error);
  }
}

function getClassifierLabel(classifier: any): string {
  if (classifier.type === 'virtual') {
    const virtualModel = modelStore.models.find(m => m.id === classifier.model_id);
    return virtualModel?.name || classifier.model_id || t('expertRouting.virtualModel');
  } else {
    return classifier.model || t('expertRouting.realModel');
  }
}

async function loadConfigs() {
  loading.value = true;
  try {
    const response = await expertRoutingApi.getAll();
    configs.value = response.configs;
  } catch (error: any) {
    message.error(error.message || t('messages.operationFailed'));
  } finally {
    loading.value = false;
  }
}

function handleCreate() {
  editingId.value = null;
  editingConfig.value = createDefaultExpertRoutingConfig();
  showEditorModal.value = true;
}

function handleEdit(config: ExpertRouting) {
  editingId.value = config.id;
  editingConfig.value = {
    name: config.name,
    description: config.description,
    enabled: config.enabled,
    classifier: config.config.classifier,
    experts: config.config.experts,
    fallback: config.config.fallback,
  };
  showEditorModal.value = true;
}

function handleShowStatistics(configId: string) {
  selectedConfigId.value = configId;
  showStatisticsModal.value = true;
}

async function handleSave(data: CreateExpertRoutingRequest) {
  saving.value = true;
  try {
    if (editingId.value) {
      await expertRoutingApi.update(editingId.value, data);
      message.success(t('expertRouting.updateSuccess'));
    } else {
      await expertRoutingApi.create(data);
      message.success('专家路由创建成功,已自动创建专家模型');
    }

    showEditorModal.value = false;
    await loadConfigs();
  } catch (error: any) {
    message.error(error.message || t('messages.operationFailed'));
  } finally {
    saving.value = false;
  }
}

function handleCancel() {
  showEditorModal.value = false;
}

async function handleToggleEnabled(id: string, enabled: boolean) {
  try {
    await expertRoutingApi.update(id, { enabled });
    message.success(t('messages.operationSuccess'));
    await loadConfigs();
  } catch (error: any) {
    message.error(error.message || t('messages.operationFailed'));
  }
}

async function handleDelete(id: string) {
  try {
    await expertRoutingApi.delete(id);
    message.success(t('expertRouting.deleteSuccess'));
    await loadConfigs();
  } catch (error: any) {
    message.error(error.message || t('messages.operationFailed'));
  }
}

function handleRefresh() {
  loadConfigs();
}

async function loadPreviewWidth() {
  try {
    const result = await expertRoutingApi.getPreviewWidth();
    if (result.width) {
      previewWidth.value = result.width;
      localStorage.setItem(PREVIEW_WIDTH_KEY, String(result.width));
    }
  } catch (error) {
    console.error('加载预览宽度失败:', error);
  }
}

onMounted(async () => {
  await modelStore.fetchModels(); // 获取所有模型数据
  loadConfigs();
  loadPreviewWidth();
});
</script>



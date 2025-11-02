<template>
  <div>
    <n-space vertical :size="16">
      <n-card :title="t('expertRouting.statistics')" size="small">
        <n-space vertical :size="12">
          <n-statistic :label="t('expertRouting.totalRequests')" :value="statistics.totalRequests" />
          <n-statistic
            :label="t('expertRouting.avgClassificationTime')"
            :value="statistics.avgClassificationTime"
            suffix="ms"
          />
        </n-space>
      </n-card>

      <n-card :title="t('expertRouting.categoryDistribution')" size="small">
        <n-space vertical :size="8">
          <div
            v-for="(count, category) in statistics.categoryDistribution"
            :key="category"
            class="category-item"
            @click="handleCategoryClick(category)"
          >
            <n-text>{{ category }}</n-text>
            <n-space align="center">
              <n-progress
                type="line"
                :percentage="getPercentage(count)"
                :show-indicator="false"
                style="width: 200px"
              />
              <n-text>{{ count }}</n-text>
            </n-space>
          </div>
          <n-empty v-if="Object.keys(statistics.categoryDistribution).length === 0" :description="t('common.noData')" :show-icon="false" />
        </n-space>
      </n-card>

      <n-card :title="t('expertRouting.logs')" size="small">
        <n-data-table
          :columns="logColumns"
          :data="logs"
          :loading="loading"
          :pagination="{ pageSize: 10 }"
          size="small"
        />
      </n-card>
    </n-space>

    <n-modal
      v-model:show="showCategoryDetailModal"
      preset="card"
      :title="t('expertRouting.categoryDetails', { category: selectedCategory })"
      style="width: 900px"
    >
      <n-spin :show="categoryLogsLoading">
        <n-data-table
          :columns="categoryLogColumns"
          :data="categoryLogs"
          :pagination="{ pageSize: 20 }"
          size="small"
        />
      </n-spin>
    </n-modal>

    <n-modal
      v-model:show="showLogDetailModal"
      preset="card"
      :title="t('expertRouting.logDetails')"
      style="width: 1000px; max-height: 80vh"
    >
      <n-spin :show="logDetailLoading">
        <n-space v-if="selectedLogDetail" vertical :size="16">
          <n-card :title="t('expertRouting.basicInfo')" size="small">
            <n-space vertical :size="8">
              <div><n-text strong>{{ t('expertRouting.classificationResult') }}:</n-text> {{ selectedLogDetail.classification_result }}</div>
              <div><n-text strong>{{ t('expertRouting.selectedExpert') }}:</n-text> {{ selectedLogDetail.selected_expert_name }}</div>
              <div><n-text strong>{{ t('expertRouting.classifierModel') }}:</n-text> {{ selectedLogDetail.classifier_model }}</div>
              <div><n-text strong>{{ t('expertRouting.classificationTime') }}:</n-text> {{ selectedLogDetail.classification_time }}ms</div>
              <div><n-text strong>{{ t('common.time') }}:</n-text> {{ new Date(selectedLogDetail.created_at).toLocaleString('zh-CN') }}</div>
            </n-space>
          </n-card>

          <n-card size="small" class="log-detail-card collapsible-card">
            <template #header>
              <div class="card-header" @click="toggleOriginalRequest">
                <n-text>{{ t('expertRouting.originalRequest') }}</n-text>
                <n-icon :class="{ 'rotate-icon': !showOriginalRequest }">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
                  </svg>
                </n-icon>
              </div>
            </template>
            <div v-show="showOriginalRequest">
              <n-code
                v-if="selectedLogDetail.original_request"
                :code="JSON.stringify(selectedLogDetail.original_request, null, 2)"
                language="json"
                class="log-detail-code"
                word-wrap
              />
              <n-empty v-else :description="t('common.noData')" />
            </div>
          </n-card>

          <n-card size="small" class="log-detail-card collapsible-card">
            <template #header>
              <div class="card-header" @click="toggleClassifierRequest">
                <n-text>{{ t('expertRouting.classifierRequest') }}</n-text>
                <n-icon :class="{ 'rotate-icon': !showClassifierRequest }">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
                  </svg>
                </n-icon>
              </div>
            </template>
            <div v-show="showClassifierRequest">
              <n-code
                v-if="selectedLogDetail.classifier_request"
                :code="JSON.stringify(selectedLogDetail.classifier_request, null, 2)"
                language="json"
                class="log-detail-code"
                word-wrap
              />
              <n-empty v-else :description="t('common.noData')" :show-icon="false" />
            </div>
          </n-card>

          <n-card size="small" class="log-detail-card collapsible-card">
            <template #header>
              <div class="card-header" @click="toggleClassifierResponse">
                <n-text>{{ t('expertRouting.classifierResponse') }}</n-text>
                <n-icon :class="{ 'rotate-icon': !showClassifierResponse }">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
                  </svg>
                </n-icon>
              </div>
            </template>
            <div v-show="showClassifierResponse">
              <n-code
                v-if="selectedLogDetail.classifier_response"
                :code="JSON.stringify(selectedLogDetail.classifier_response, null, 2)"
                language="json"
                class="log-detail-code"
                word-wrap
              />
              <n-empty v-else :description="t('common.noData')" :show-icon="false" />
            </div>
          </n-card>
        </n-space>
      </n-spin>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, h } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NSpace,
  NCard,
  NStatistic,
  NProgress,
  NText,
  NEmpty,
  NDataTable,
  NTag,
  NModal,
  NSpin,
  NButton,
  NCode,
  NIcon,
  type DataTableColumns,
} from 'naive-ui';
import { expertRoutingApi, type ExpertRoutingStatistics, type ExpertRoutingLog, type ExpertRoutingLogDetail } from '@/api/expert-routing';

const { t } = useI18n();

interface Props {
  configId: string;
}

const props = defineProps<Props>();

const statistics = ref<ExpertRoutingStatistics>({
  totalRequests: 0,
  avgClassificationTime: 0,
  categoryDistribution: {},
});
const logs = ref<ExpertRoutingLog[]>([]);
const loading = ref(false);
const showCategoryDetailModal = ref(false);
const selectedCategory = ref('');
const categoryLogs = ref<ExpertRoutingLog[]>([]);
const categoryLogsLoading = ref(false);
const showLogDetailModal = ref(false);
const selectedLogDetail = ref<ExpertRoutingLogDetail | null>(null);
const logDetailLoading = ref(false);
const showOriginalRequest = ref(false);
const showClassifierRequest = ref(false);
const showClassifierResponse = ref(false);

const logColumns = computed<DataTableColumns<ExpertRoutingLog>>(() => [
  {
    title: t('expertRouting.classificationResult'),
    key: 'classification_result',
    ellipsis: { tooltip: true },
  },
  {
    title: t('expertRouting.selectedExpert'),
    key: 'selected_expert_name',
    ellipsis: { tooltip: true },
  },
  {
    title: t('expertRouting.classificationTime'),
    key: 'classification_time',
    width: 120,
    render: (row) => `${row.classification_time}ms`,
  },
  {
    title: t('common.status'),
    key: 'selected_expert_type',
    width: 100,
    render: (row) => {
      return h(
        NTag,
        {
          size: 'small',
          type: row.selected_expert_type === 'virtual' ? 'info' : 'success',
        },
        () => row.selected_expert_type === 'virtual' ? t('expertRouting.virtualModel') : t('expertRouting.realModel')
      );
    },
  },
  {
    title: t('common.actions'),
    key: 'actions',
    width: 100,
    render: (row) => {
      return h(
        NButton,
        {
          size: 'small',
          onClick: () => handleLogClick(row),
        },
        () => t('common.details')
      );
    },
  },
]);

const categoryLogColumns = computed<DataTableColumns<ExpertRoutingLog>>(() => [
  {
    title: t('expertRouting.selectedExpert'),
    key: 'selected_expert_name',
    ellipsis: { tooltip: true },
  },
  {
    title: t('expertRouting.classificationTime'),
    key: 'classification_time',
    width: 120,
    render: (row) => `${row.classification_time}ms`,
  },
  {
    title: t('common.status'),
    key: 'selected_expert_type',
    width: 100,
    render: (row) => {
      return h(
        NTag,
        {
          size: 'small',
          type: row.selected_expert_type === 'virtual' ? 'info' : 'success',
        },
        () => row.selected_expert_type === 'virtual' ? t('expertRouting.virtualModel') : t('expertRouting.realModel')
      );
    },
  },
  {
    title: t('common.time'),
    key: 'created_at',
    width: 180,
    render: (row) => new Date(row.created_at).toLocaleString('zh-CN'),
  },
  {
    title: t('common.actions'),
    key: 'actions',
    width: 100,
    render: (row) => {
      return h(
        NButton,
        {
          size: 'small',
          onClick: () => handleLogClick(row),
        },
        () => t('common.details')
      );
    },
  },
]);

function getPercentage(count: number): number {
  if (statistics.value.totalRequests === 0) return 0;
  return Math.round((count / statistics.value.totalRequests) * 100);
}

async function loadStatistics() {
  try {
    statistics.value = await expertRoutingApi.getStatistics(props.configId);
  } catch (error) {
    console.error('Failed to load statistics:', error);
  }
}

async function loadLogs() {
  loading.value = true;
  try {
    const response = await expertRoutingApi.getLogs(props.configId, 50);
    logs.value = response.logs;
  } catch (error) {
    console.error('Failed to load logs:', error);
  } finally {
    loading.value = false;
  }
}

async function handleCategoryClick(category: string) {
  selectedCategory.value = category;
  showCategoryDetailModal.value = true;
  categoryLogsLoading.value = true;
  try {
    const response = await expertRoutingApi.getLogsByCategory(props.configId, category, 100);
    categoryLogs.value = response.logs;
  } catch (error) {
    console.error('Failed to load category logs:', error);
  } finally {
    categoryLogsLoading.value = false;
  }
}

async function handleLogClick(log: ExpertRoutingLog) {
  showLogDetailModal.value = true;
  logDetailLoading.value = true;
  selectedLogDetail.value = null;
  showOriginalRequest.value = false;
  showClassifierRequest.value = false;
  showClassifierResponse.value = false;
  try {
    const detail = await expertRoutingApi.getLogDetails(props.configId, log.id);
    selectedLogDetail.value = detail;
  } catch (error) {
    console.error('Failed to load log details:', error);
  } finally {
    logDetailLoading.value = false;
  }
}

function toggleOriginalRequest() {
  showOriginalRequest.value = !showOriginalRequest.value;
}

function toggleClassifierRequest() {
  showClassifierRequest.value = !showClassifierRequest.value;
}

function toggleClassifierResponse() {
  showClassifierResponse.value = !showClassifierResponse.value;
}

onMounted(() => {
  loadStatistics();
  loadLogs();
});
</script>

<style scoped>
.category-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.category-item:hover {
  background-color: rgba(0, 0, 0, 0.05);
}

/* 专家路由日志详情卡片样式 */
.log-detail-card {
  margin-bottom: 16px;
  overflow: hidden;
}

.log-detail-card:last-child {
  margin-bottom: 0;
}

.collapsible-card .card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  user-select: none;
  width: 100%;
}

.collapsible-card .n-icon {
  transition: transform 0.3s ease;
  width: 20px;
  height: 20px;
}

.collapsible-card .rotate-icon {
  transform: rotate(-90deg);
}

.log-detail-code {
  max-height: 300px;
  overflow: auto;
  white-space: pre-wrap;
  word-wrap: break-word;
  word-break: break-all;
  font-size: 12px;
}

/* 确保代码块在小屏幕上也能正确显示 */
@media (max-height: 800px) {
  .log-detail-code {
    max-height: 200px;
  }
}

@media (max-height: 600px) {
  .log-detail-code {
    max-height: 150px;
  }
}
</style>


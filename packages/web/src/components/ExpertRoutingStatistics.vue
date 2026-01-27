<template>
  <div>
    <n-space vertical :size="16">
      <!-- Top Overview -->
      <n-grid :cols="3" :x-gap="12">
        <n-gi>
          <n-card size="small">
            <n-statistic :label="t('expertRouting.totalRequests')" :value="statistics.totalRequests" />
          </n-card>
        </n-gi>
        <n-gi>
          <n-card size="small">
            <n-statistic :label="t('expertRouting.avgClassificationTime')" :value="statistics.avgClassificationTime">
              <template #suffix>ms</template>
            </n-statistic>
          </n-card>
        </n-gi>
        <n-gi>
          <n-card size="small">
            <n-statistic :label="t('expertRouting.cleaningEfficiency')" :value="cleaningEfficiency">
              <template #suffix>%</template>
            </n-statistic>
          </n-card>
        </n-gi>
      </n-grid>

      <!-- Routing Flow / Distribution -->
      <n-card :title="t('expertRouting.routingDistribution')" size="small">
        <n-space vertical :size="12">
          <div
            v-for="bar in distributionBars"
            :key="bar.source"
            class="distribution-bar"
          >
            <div class="dist-label">{{ bar.label }}</div>
            <n-progress
              type="line"
              :percentage="getSourcePercentage(bar.source)"
              :color="bar.color"
              :height="20"
              :show-indicator="true"
            >
              {{ statistics.routeSourceDistribution?.[bar.source] || 0 }}
            </n-progress>
          </div>
        </n-space>
      </n-card>

      <!-- Category Distribution -->
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

      <!-- Logs -->
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

    <!-- Modals (Category Detail & Log Detail) ... -->
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
      style="width: 1000px; max-height: 90vh"
    >
      <div class="log-detail-scroll-container">
        <n-spin :show="logDetailLoading">
          <n-space v-if="selectedLogDetail" vertical :size="16">
          <n-card :title="t('expertRouting.basicInfo')" size="small">
            <n-grid :cols="2" :x-gap="24">
              <n-gi>
                <n-space vertical :size="8">
                  <div><n-text strong>{{ t('expertRouting.classificationResult') }}:</n-text> {{ selectedLogDetail.classification_result }}</div>
                  <div><n-text strong>{{ t('expertRouting.selectedExpert') }}:</n-text> {{ selectedLogDetail.selected_expert_name }}</div>
                  <div><n-text strong>{{ t('expertRouting.classifierModel') }}:</n-text> {{ selectedLogDetail.classifier_model }}</div>
                  <div><n-text strong>{{ t('expertRouting.classificationTime') }}:</n-text> {{ selectedLogDetail.classification_time }}ms</div>
                  <div><n-text strong>{{ t('common.time') }}:</n-text> {{ new Date(selectedLogDetail.created_at).toLocaleString('zh-CN') }}</div>
                </n-space>
              </n-gi>
              <n-gi>
                <n-space vertical :size="8">
                  <div>
                    <n-text strong>Route Source:</n-text>
                    <n-tag size="small" :type="getSourceTagType(selectedLogDetail.route_source)">
                      {{ selectedLogDetail.route_source || 'N/A' }}
                    </n-tag>
                  </div>
                  <div>
                    <n-text strong>Semantic Score:</n-text>
                    {{ typeof selectedLogDetail.semantic_score === 'number' ? selectedLogDetail.semantic_score.toFixed(4) : '-' }}
                  </div>
                  <div>
                    <n-text strong>Prompt Tokens (Est):</n-text>
                    {{ selectedLogDetail.prompt_tokens ?? '-' }}
                  </div>
                  <div>
                    <n-text strong>Cleaned Length:</n-text>
                    {{ selectedLogDetail.cleaned_content_length ?? '-' }} chars
                  </div>
                </n-space>
              </n-gi>
            </n-grid>
          </n-card>

          <!-- ... Existing Request/Response Cards ... -->
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
      </div>
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
  NGrid,
  NGi,
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
  routeSourceDistribution: {},
  cleaningStats: { avgPromptTokens: 0, avgCleanedLength: 0, totalRequests: 0 }
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

const cleaningEfficiency = computed(() => {
  const stats = statistics.value.cleaningStats;
  if (!stats || stats.avgPromptTokens === 0) return 0;
  // Use length estimation for prompt tokens to compare: chars vs chars?
  // Backend returns avgCleanedLength (chars) and avgPromptTokens (tokens).
  // 1 token approx 4 chars.
  const estimatedOriginalChars = stats.avgPromptTokens * 4;
  if (estimatedOriginalChars <= 0) return 0;
  const reduction = estimatedOriginalChars - stats.avgCleanedLength;
  return Math.max(0, Math.round((reduction / estimatedOriginalChars) * 100));
});

type RouteSource = 'l1_semantic' | 'l2_heuristic' | 'l3_llm' | 'l2_llm' | 'fallback';

const distributionBars = computed(() => {
  const dist = statistics.value.routeSourceDistribution || {};
  const count = (source: RouteSource) => dist[source] || 0;

  // We only show L2/L3/Fallback when they actually occur.
  // L1 is always shown.
  const bars: Array<{ source: RouteSource; label: string; color: string }> = [
    { source: 'l1_semantic', label: 'L1 Semantic', color: '#18a058' },
  ];

  if (count('l2_llm') > 0) {
    bars.push({ source: 'l2_llm', label: 'L2 LLM Judge', color: '#f0a020' });
  }
  if (count('l3_llm') > 0) {
    bars.push({ source: 'l3_llm', label: 'L3 LLM Judge', color: '#f0a020' });
  }
  if (count('fallback') > 0) {
    bars.push({ source: 'fallback', label: 'Fallback', color: '#d03050' });
  }

  return bars;
});

function getSourcePercentage(source: string): number {
  if (statistics.value.totalRequests === 0) return 0;
  const count = statistics.value.routeSourceDistribution?.[source] || 0;
  return Math.round((count / statistics.value.totalRequests) * 100);
}

function getSourceTagType(source?: string) {
  switch (source) {
    case 'l1_semantic': return 'success';
    case 'l2_heuristic': return 'info';
    case 'l2_llm': return 'warning';
    case 'l3_llm': return 'warning';
    case 'fallback': return 'error';
    default: return 'default';
  }
}

function formatRouteSource(source?: string) {
  if (!source) return '-';
  if (source === 'fallback') return 'Fallback';
  if (source === 'l2_llm') return 'L2 LLM Judge';
  return source
    .replace('l1_', 'L1 ')
    .replace('l2_', 'L2 ')
    .replace('l3_', 'L3 ')
    .replace(/_/g, ' ');
}

const logColumns = computed<DataTableColumns<ExpertRoutingLog>>(() => [
  {
    title: t('expertRouting.classificationResult'),
    key: 'classification_result',
    ellipsis: { tooltip: true },
  },
  {
    title: 'Source',
    key: 'route_source',
    width: 110,
    render: (row) => {
      return h(
        NTag,
        {
          size: 'small',
          type: getSourceTagType(row.route_source),
          bordered: false
        },
        () => formatRouteSource(row.route_source)
      );
    }
  },
  {
    title: t('expertRouting.selectedExpert'),
    key: 'selected_expert_name',
    ellipsis: { tooltip: true },
  },
  {
    title: t('expertRouting.classificationTime'),
    key: 'classification_time',
    width: 100,
    render: (row) => `${row.classification_time}ms`,
  },
  {
    title: t('common.actions'),
    key: 'actions',
    width: 80,
    render: (row) => {
      return h(
        NButton,
        {
          size: 'tiny',
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
    title: 'Source',
    key: 'route_source',
    width: 100,
    render: (row) => row.route_source || '-'
  },
  {
    title: t('expertRouting.classificationTime'),
    key: 'classification_time',
    width: 100,
    render: (row) => `${row.classification_time}ms`,
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
    width: 80,
    render: (row) => {
      return h(
        NButton,
        {
          size: 'tiny',
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

.distribution-bar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.dist-label {
  width: 120px;
  font-size: 13px;
  color: var(--n-text-color-2);
}

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

.log-detail-scroll-container {
  max-height: calc(90vh - 100px);
  overflow-y: auto;
  padding-right: 8px;
}
</style>

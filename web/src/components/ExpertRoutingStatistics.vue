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
          <n-empty v-if="Object.keys(statistics.categoryDistribution).length === 0" :description="t('common.noData')" />
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
  type DataTableColumns,
} from 'naive-ui';
import { expertRoutingApi, type ExpertRoutingStatistics, type ExpertRoutingLog } from '@/api/expert-routing';

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
</style>


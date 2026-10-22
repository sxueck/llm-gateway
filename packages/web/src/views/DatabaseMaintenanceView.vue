<template>
  <div>
    <n-space vertical :size="24">
      <PageHeader eyebrow="SETTINGS" :title="t('settings.dbMaintenanceTitle')" />

      <n-alert type="warning" :show-icon="true">
        {{ t('settings.dbMaintenanceBackupHint') }}
        <router-link to="/backup">{{ t('settings.dbMaintenanceGoBackup') }}</router-link>
      </n-alert>

      <n-card :title="t('settings.dbMaintenanceTablesTitle')">
        <template #header-extra>
          <n-button size="small" :loading="loading" @click="refresh">
            {{ t('common.refresh') }}
          </n-button>
        </template>
        <n-data-table
          :columns="sizeColumns"
          :data="overview?.tables ?? []"
          :loading="loading"
          size="small"
          :row-key="(row: TableSizeInfo) => row.table"
        />
      </n-card>

      <n-card :title="t('settings.dbMaintenancePurgeTitle')">
        <n-text depth="3" style="font-size: 12px; display: block; margin-bottom: 12px;">
          {{ t('settings.dbMaintenancePurgeHint') }}
        </n-text>
        <n-data-table
          :columns="purgeColumns"
          :data="purgeTargets"
          size="small"
          :row-key="(row: PurgePlan) => row.table"
        />
        <n-space justify="end" style="margin-top: 16px;">
          <n-button :disabled="purgeSelection.length === 0" @click="savePolicy">
            {{ t('settings.dbMaintenanceSavePolicy') }}
          </n-button>
          <n-button
            type="default"
            :loading="purging"
            :disabled="purgeSelection.length === 0"
            @click="previewPurge"
          >
            {{ t('settings.dbMaintenancePurgePreview') }}
          </n-button>
          <n-button
            type="error"
            :loading="purging"
            :disabled="!purgePreviewed"
            @click="executePurge"
          >
            {{ t('settings.dbMaintenancePurgeExecute') }}
          </n-button>
        </n-space>

        <n-alert
          v-if="purgePlans.length > 0"
          type="info"
          style="margin-top: 12px;"
          closable
          @close="purgePlans = []"
        >
          <div v-for="plan in purgePlans" :key="plan.table">
            {{ plan.table }}: {{ formatCount(plan.estimatedRows) }}
          </div>
        </n-alert>
        <n-alert
          v-if="purgeResults.length > 0"
          type="success"
          style="margin-top: 12px;"
          closable
          @close="purgeResults = []"
        >
          <div v-for="result in purgeResults" :key="result.table">
            {{ result.table }}: {{ formatCount(result.deleted) }} ({{ result.batches }}
            {{ t('settings.dbMaintenanceBatches') }})
          </div>
          <n-text depth="3" style="font-size: 12px;">
            {{ t('settings.dbMaintenancePurgeRepeatHint') }}
          </n-text>
        </n-alert>
      </n-card>

      <n-card :title="t('settings.dbMaintenanceOptimizeTitle')">
        <n-text depth="3" style="font-size: 12px; display: block; margin-bottom: 12px;">
          {{ t('settings.dbMaintenanceOptimizeHint') }}
        </n-text>
        <n-checkbox-group v-model:value="optimizeSelection">
          <n-space vertical>
            <n-checkbox
              v-for="table in optimizeCandidates"
              :key="table.table"
              :value="table.table"
              :label="`${table.table} (${formatMb(table.freeMb)} ${t('settings.dbMaintenanceFragmented')})`"
            />
          </n-space>
        </n-checkbox-group>
        <n-space justify="end" style="margin-top: 16px;">
          <n-button
            type="primary"
            :loading="optimizing"
            :disabled="optimizeSelection.length === 0"
            @click="executeOptimize"
          >
            {{ t('settings.dbMaintenanceOptimizeExecute') }}
          </n-button>
        </n-space>

        <n-alert
          v-if="optimizeResults.length > 0"
          :type="optimizeResults.every((r) => r.ok) ? 'success' : 'warning'"
          style="margin-top: 12px;"
          closable
          @close="optimizeResults = []"
        >
          <div v-for="result in optimizeResults" :key="result.table">
            {{ result.table }}: {{ result.ok ? t('settings.dbMaintenanceOptimizeOk') : t('settings.dbMaintenanceOptimizeFailed') }}
            <n-text v-if="!result.ok" depth="3" style="font-size: 12px;">
              {{ result.messages.join('; ') }}
            </n-text>
          </div>
        </n-alert>
      </n-card>

      <n-card :title="t('settings.dbMaintenanceLastRunTitle')">
        <n-text v-if="overview?.lastRun" depth="2">
          {{ lastRunTypeLabel }} · {{ formatTimestamp(overview.lastRun.at) }} ·
          {{ overview.lastRun.summary }}
        </n-text>
        <n-text v-else depth="3">{{ t('settings.dbMaintenanceLastRunEmpty') }}</n-text>
      </n-card>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NAlert,
  NButton,
  NCard,
  NCheckbox,
  NCheckboxGroup,
  NDataTable,
  NInputNumber,
  NSpace,
  NTag,
  NText,
  useMessage,
} from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import PageHeader from '@/components/PageHeader.vue';
import {
  dbMaintenanceApi,
  type MaintenanceOverview,
  type OptimizeResult,
  type PurgePlan,
  type PurgeResult,
  type TableSizeInfo,
} from '@/api/db-maintenance';

const { t } = useI18n();
const message = useMessage();

const loading = ref(false);
const purging = ref(false);
const optimizing = ref(false);
const overview = ref<MaintenanceOverview | null>(null);
const purgeSelection = ref<string[]>([]);
const purgePlans = ref<PurgePlan[]>([]);
const purgeResults = ref<PurgeResult[]>([]);
const retentionDays = ref<Record<string, number>>({});
const optimizeSelection = ref<string[]>([]);
const optimizeResults = ref<OptimizeResult[]>([]);

const purgeTargets = computed(() => overview.value?.purgeTargets ?? []);
const purgePreviewed = computed(() => purgePlans.value.length > 0);

// 仅列出有碎片（data_free > 0）的表；OPTIMIZE 是重操作，默认范围越小越好。
const optimizeCandidates = computed(
  () => (overview.value?.tables ?? []).filter((table) => table.freeMb > 0)
);

const lastRunTypeLabel = computed(() => {
  const lastRun = overview.value?.lastRun;
  if (!lastRun) return '';
  return lastRun.type === 'purge'
    ? t('settings.dbMaintenancePurgeTitle')
    : t('settings.dbMaintenanceOptimizeTitle');
});

function formatMb(value: number): string {
  return `${value.toFixed(2)} MB`;
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatTimestamp(at: number): string {
  return new Date(at).toLocaleString();
}

const sizeColumns = computed<DataTableColumns<TableSizeInfo>>(() => [
  { title: t('settings.dbMaintenanceColTable'), key: 'table' },
  { title: t('settings.dbMaintenanceColEngine'), key: 'engine', width: 90 },
  {
    title: t('settings.dbMaintenanceColRows'),
    key: 'rows',
    width: 110,
    render: (row) => formatCount(row.rows),
  },
  {
    title: t('settings.dbMaintenanceColData'),
    key: 'dataMb',
    width: 110,
    render: (row) => formatMb(row.dataMb),
  },
  {
    title: t('settings.dbMaintenanceColIndex'),
    key: 'indexMb',
    width: 110,
    render: (row) => formatMb(row.indexMb),
  },
  {
    title: t('settings.dbMaintenanceColFragmented'),
    key: 'freeMb',
    width: 110,
    render: (row) => formatMb(row.freeMb),
  },
  {
    title: t('settings.dbMaintenanceColTotal'),
    key: 'totalMb',
    width: 110,
    render: (row) => formatMb(row.totalMb),
  },
]);

const purgeColumns = computed<DataTableColumns<PurgePlan>>(() => [
  {
    title: '',
    key: 'selection',
    width: 40,
    render: (row) =>
      h(NCheckbox, {
        checked: purgeSelection.value.includes(row.table),
        onUpdateChecked: (checked: boolean) => {
          purgeSelection.value = checked
            ? [...purgeSelection.value, row.table]
            : purgeSelection.value.filter((item) => item !== row.table);
        },
      }),
  },
  { title: t('settings.dbMaintenanceColTable'), key: 'table' },
  {
    title: t('settings.dbMaintenanceColMode'),
    key: 'mode',
    width: 100,
    render: (row) =>
      h(
        NTag,
        { size: 'small', type: row.mode === 'age' ? 'info' : 'default' },
        {
          default: () =>
            row.mode === 'age'
              ? t('settings.dbMaintenanceModeAge')
              : t('settings.dbMaintenanceModeExpired'),
        }
      ),
  },
  {
    title: t('settings.dbMaintenanceColRetention'),
    key: 'retention',
    width: 160,
    render: (row) => {
      if (row.mode !== 'age') return '';
      return h(NInputNumber, {
        value: retentionDays.value[row.table] ?? 90,
        min: 1,
        max: 3650,
        size: 'small',
        style: 'width: 130px;',
        onUpdateValue: (value: number | null) => {
          retentionDays.value[row.table] = value ?? 90;
        },
      });
    },
  },
  {
    title: t('settings.dbMaintenanceColEstimated'),
    key: 'estimatedRows',
    width: 140,
    render: (row) => formatCount(row.estimatedRows),
  },
]);

async function refresh() {
  loading.value = true;
  try {
    overview.value = await dbMaintenanceApi.getOverview();
    retentionDays.value = { ...(overview.value.settings.retentionDays ?? {}) };
    purgeSelection.value = [];
    purgePlans.value = [];
    purgeResults.value = [];
    optimizeResults.value = [];
  } catch (error) {
    message.error(t('settings.dbMaintenanceLoadFailed'));
    console.error('Failed to load db-maintenance overview:', error);
  } finally {
    loading.value = false;
  }
}

async function savePolicy() {
  try {
    const policy: Record<string, number> = {};
    for (const table of purgeSelection.value) {
      const days = retentionDays.value[table];
      if (days != null) policy[table] = days;
    }
    await dbMaintenanceApi.saveSettings({ retentionDays: policy });
    message.success(t('settings.dbMaintenancePolicySaved'));
  } catch (error) {
    message.error(t('settings.dbMaintenanceLoadFailed'));
    console.error('Failed to save db-maintenance settings:', error);
  }
}

async function previewPurge() {
  purging.value = true;
  try {
    await savePolicy();
    purgePlans.value = await dbMaintenanceApi.dryRunPurge(purgeSelection.value);
    purgeResults.value = [];
  } catch (error) {
    message.error(t('settings.dbMaintenanceLoadFailed'));
    console.error('Purge dry-run failed:', error);
  } finally {
    purging.value = false;
  }
}

async function executePurge() {
  purging.value = true;
  try {
    purgeResults.value = await dbMaintenanceApi.purge(purgeSelection.value);
    purgePlans.value = [];
    optimizeSelection.value = [];
    const tables = await dbMaintenanceApi.getOverview();
    overview.value = tables;
  } catch (error) {
    message.error(t('settings.dbMaintenancePurgeFailed'));
    console.error('Purge failed:', error);
  } finally {
    purging.value = false;
  }
}

async function executeOptimize() {
  optimizing.value = true;
  try {
    optimizeResults.value = await dbMaintenanceApi.optimize(optimizeSelection.value);
    const tables = await dbMaintenanceApi.getOverview();
    overview.value = tables;
  } catch (error) {
    message.error(t('settings.dbMaintenanceOptimizeFailed'));
    console.error('Optimize failed:', error);
  } finally {
    optimizing.value = false;
  }
}

onMounted(refresh);
</script>

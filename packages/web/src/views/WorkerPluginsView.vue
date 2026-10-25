<script setup lang="ts">
import { computed, h, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { DataTableColumns } from "naive-ui";
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NDescriptions,
  NDescriptionsItem,
  NDivider,
  NDrawer,
  NDrawerContent,
  NInput,
  NModal,
  NPopconfirm,
  NSpace,
  NSwitch,
  NTag,
  useMessage,
} from "naive-ui";
import {
  workerPluginApi,
  type PluginEnrollment,
  type PublishPluginPayload,
  type WorkerPluginVersion,
} from "@/api/worker-plugin";
import { formatTimestamp } from "@/utils/common";
import PageHeader from "@/components/PageHeader.vue";

const message = useMessage();
const { t } = useI18n();
const loading = ref(false);
const plugins = ref<WorkerPluginVersion[]>([]);
const enrollments = ref<PluginEnrollment[]>([]);
const selectedPlugin = ref<WorkerPluginVersion | null>(null);
const showDetails = ref(false);
const showPublishModal = ref(false);
const publishBundleText = ref("");
const publishing = ref(false);

const enrollmentByPlugin = computed(() => {
  const map = new Map<string, PluginEnrollment>();
  for (const enrollment of enrollments.value) {
    map.set(enrollment.plugin_id, enrollment);
  }
  return map;
});

const selectedEnrollment = computed(() =>
  selectedPlugin.value
    ? enrollmentByPlugin.value.get(selectedPlugin.value.id)
    : undefined,
);

async function load() {
  loading.value = true;
  try {
    const res = await workerPluginApi.list();
    plugins.value = res.plugins;
    enrollments.value = res.enrollments;
    if (selectedPlugin.value) {
      selectedPlugin.value =
        res.plugins.find(
          (plugin) =>
            plugin.id === selectedPlugin.value?.id &&
            plugin.version === selectedPlugin.value?.version,
        ) ?? null;
      if (!selectedPlugin.value) showDetails.value = false;
    }
  } catch (error: any) {
    message.error(error?.message || t("workerPlugins.loadFailed"));
  } finally {
    loading.value = false;
  }
}

const statusTagType: Record<
  WorkerPluginVersion["status"],
  "success" | "warning" | "error" | "default"
> = {
  published: "success",
  deprecated: "warning",
  revoked: "error",
  draft: "default",
};

const statusLabel = computed(() => ({
  published: t("workerPlugins.status.published"),
  deprecated: t("workerPlugins.status.deprecated"),
  revoked: t("workerPlugins.status.revoked"),
  draft: t("workerPlugins.status.draft"),
}));

function enrollmentState(row: WorkerPluginVersion) {
  const enrollment = enrollmentByPlugin.value.get(row.id);
  const isCurrent = enrollment?.version === row.version;
  return {
    enrollment,
    isCurrent,
    enabled:
      enrollment === undefined || (enrollment.enabled && isCurrent),
  };
}

function openDetails(row: WorkerPluginVersion) {
  selectedPlugin.value = row;
  showDetails.value = true;
}

async function toggleEnabled(row: WorkerPluginVersion, enabled: boolean) {
  const current = enrollmentByPlugin.value.get(row.id);
  try {
    await workerPluginApi.enroll(row.id, {
      version: row.version,
      enabled,
      is_default: enabled ? (current?.is_default ?? false) : false,
    });
    await load();
  } catch (error: any) {
    message.error(error?.message || t("workerPlugins.enrollFailed"));
  }
}

async function setDefault(row: WorkerPluginVersion) {
  try {
    await workerPluginApi.enroll(row.id, {
      version: row.version,
      enabled: true,
      is_default: true,
    });
    await load();
  } catch (error: any) {
    message.error(error?.message || t("workerPlugins.setDefaultFailed"));
  }
}

async function transition(
  row: WorkerPluginVersion,
  action: "deprecate" | "republish" | "revoke",
) {
  try {
    await workerPluginApi[action](row.id, row.version);
    message.success(t("workerPlugins.statusUpdated", { id: row.id, version: row.version }));
    await load();
  } catch (error: any) {
    message.error(error?.message || t("workerPlugins.statusUpdateFailed"));
  }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function removeVersion(row: WorkerPluginVersion) {
  try {
    await workerPluginApi.remove(row.id, row.version);
    message.success(t("workerPlugins.deleted", { id: row.id, version: row.version }));
    if (
      selectedPlugin.value?.id === row.id &&
      selectedPlugin.value?.version === row.version
    ) {
      showDetails.value = false;
      selectedPlugin.value = null;
    }
    await load();
  } catch (error: any) {
    message.error(errorText(error, t("workerPlugins.deleteFailed")));
  }
}

async function unenroll(row: WorkerPluginVersion) {
  try {
    await workerPluginApi.unenroll(row.id);
    message.success(t("workerPlugins.unenrolled", { id: row.id }));
    await load();
  } catch (error: any) {
    message.error(errorText(error, t("workerPlugins.unenrollFailed")));
  }
}

async function submitPublish() {
  let payload: PublishPluginPayload;
  try {
    payload = JSON.parse(publishBundleText.value);
  } catch {
    message.error(t("workerPlugins.bundleInvalid"));
    return;
  }
  if (!payload?.manifest || !payload?.files) {
    message.error(t("workerPlugins.bundleFields"));
    return;
  }
  publishing.value = true;
  try {
    const res = await workerPluginApi.publish(payload);
    message.success(t("workerPlugins.published", { id: res.id, version: res.version }));
    showPublishModal.value = false;
    publishBundleText.value = "";
    await load();
  } catch (error: any) {
    message.error(error?.message || t("workerPlugins.publishFailed"));
  } finally {
    publishing.value = false;
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const latestVersionByPlugin = computed(() => {
  const map = new Map<string, string>();
  for (const plugin of plugins.value) {
    const current = map.get(plugin.id);
    if (!current || compareVersions(plugin.version, current) > 0) {
      map.set(plugin.id, plugin.version);
    }
  }
  return map;
});

function rowClassName(row: WorkerPluginVersion) {
  return row.status === "revoked" ? "plugin-row-revoked" : "";
}

const columns = computed<DataTableColumns<WorkerPluginVersion>>(() => [
  {
    title: t("workerPlugins.colVersion"),
    key: "name",
    minWidth: 230,
    render: (row) => {
      const isLatest =
        latestVersionByPlugin.value.get(row.id) === row.version &&
        row.status !== "revoked";
      return h("div", { class: "plugin-identity" }, [
        h("div", { class: "plugin-identity-main" }, [
          h("strong", null, row.name),
          h(NTag, { size: "small", bordered: false }, { default: () => `v${row.version}` }),
          ...(isLatest
            ? [h(NTag, { size: "small", type: "primary", bordered: false }, { default: () => t("workerPlugins.latest") })]
            : []),
        ]),
        h("code", { class: "plugin-identity-id" }, row.id),
      ]);
    },
  },
  {
    title: t("common.status"),
    key: "status",
    width: 100,
    render: (row) =>
      h(
        NTag,
        { type: statusTagType[row.status], size: "small" },
        { default: () => statusLabel.value[row.status] },
      ),
  },
  {
    title: t("workerPlugins.colRuntime"),
    key: "configuration",
    minWidth: 190,
    render: (row) =>
      h("div", { class: "configuration-summary" }, [
        h("code", { class: "configuration-profile" }, row.model_profile),
        h("span", null, t("workerPlugins.toolCount", { count: row.tools.length })),
        h("span", null, t("workerPlugins.turnBudget", { turns: row.max_turns, seconds: row.timeout_seconds })),
      ]),
  },
  {
    title: t("workerPlugins.colMine"),
    key: "enrollment",
    width: 180,
    render: (row) => {
      if (row.status === "revoked") return h("span", { class: "muted-value" }, t("workerPlugins.unavailable"));
      const state = enrollmentState(row);
      return h(NSpace, { size: 8, align: "center", wrap: false }, {
        default: () => [
          h(NSwitch, {
            size: "small",
            value: state.enabled,
            onUpdateValue: (value: boolean) => toggleEnabled(row, value),
          }),
          state.enrollment?.is_default && state.isCurrent
            ? h(NTag, { size: "small", type: "info", bordered: false }, { default: () => t("common.default") })
            : h(
                NButton,
                {
                  size: "tiny",
                  quaternary: true,
                  disabled: row.status === "draft",
                  onClick: () => setDefault(row),
                },
                { default: () => t("workerPlugins.setDefault") },
              ),
        ],
      });
    },
  },
  {
    title: "",
    key: "details",
    width: 96,
    align: "right",
    render: (row) =>
      h(
        NButton,
        { size: "small", tertiary: true, onClick: () => openDetails(row) },
        { default: () => t("workerPlugins.details") },
      ),
  },
]);

onMounted(load);
</script>

<template>
  <div class="worker-plugins-view">
    <PageHeader
      eyebrow="EXPERIMENTAL"
      :title="t('workerPlugins.title')"
      :subtitle="t('workerPlugins.subtitle')"
    >
      <template #actions>
        <NButton size="small" @click="load" :loading="loading">{{ t('common.refresh') }}</NButton>
        <NButton size="small" type="primary" @click="showPublishModal = true">
          {{ t('workerPlugins.publish') }}
        </NButton>
      </template>
    </PageHeader>

    <NCard class="plugin-center-card" :bordered="false">
      <NAlert type="info" class="plugin-notice" :show-icon="true">
        {{ t('workerPlugins.immutableHint') }}
      </NAlert>

      <NDataTable
        class="plugin-overview-table"
        :columns="columns"
        :data="plugins"
        :loading="loading"
        :bordered="false"
        :single-line="false"
        size="small"
        :row-class-name="rowClassName"
        :row-key="(row: WorkerPluginVersion) => `${row.id}@${row.version}`"
      />
    </NCard>

    <NDrawer v-model:show="showDetails" placement="right" :width="480">
      <NDrawerContent v-if="selectedPlugin" closable>
        <template #header>
          <div class="drawer-title">
            <span>{{ selectedPlugin.name }}</span>
            <NTag size="small" :type="statusTagType[selectedPlugin.status]">
              {{ statusLabel[selectedPlugin.status] }}
            </NTag>
            <NButton size="small" tertiary @click="load" :loading="loading">{{ t('common.refresh') }}</NButton>
          </div>
        </template>

        <div class="drawer-body">
          <code class="plugin-id">{{ selectedPlugin.id }}@{{ selectedPlugin.version }}</code>
          <p class="plugin-description">{{ selectedPlugin.description || t('workerPlugins.noDescription') }}</p>

          <NDescriptions label-placement="left" :column="1" bordered size="small">
            <NDescriptionsItem :label="t('workerPlugins.modelProfile')">
              {{ selectedPlugin.model_profile }}
            </NDescriptionsItem>
            <NDescriptionsItem :label="t('workerPlugins.budget')">
              {{ t('workerPlugins.budgetValue', { turns: selectedPlugin.max_turns, seconds: selectedPlugin.timeout_seconds }) }}
            </NDescriptionsItem>
            <NDescriptionsItem :label="t('workerPlugins.publishedAt')">
              {{ selectedPlugin.published_at ? formatTimestamp(selectedPlugin.published_at) : "—" }}
            </NDescriptionsItem>
            <NDescriptionsItem label="Digest">
              <code class="digest-value">{{ selectedPlugin.digest }}</code>
            </NDescriptionsItem>
          </NDescriptions>

          <section class="detail-section">
            <span class="section-label">{{ t('workerPlugins.allowedTools') }}</span>
            <NSpace size="small" wrap>
              <NTag v-for="tool in selectedPlugin.tools" :key="tool" size="small" :bordered="false">
                {{ tool }}
              </NTag>
            </NSpace>
          </section>

          <section
            v-if="selectedPlugin.status !== 'revoked' || selectedEnrollment"
            class="detail-section enrollment-section"
          >
            <div>
              <span class="section-label">{{ t('workerPlugins.enrollment') }}</span>
              <p v-if="selectedPlugin.status === 'revoked'">{{ t('workerPlugins.revokedHint') }}</p>
              <p v-else>{{ enrollmentState(selectedPlugin).enabled ? t('workerPlugins.enrollmentEnabled') : t('workerPlugins.enrollmentDisabled') }}</p>
            </div>
            <NSpace align="center">
              <NSwitch
                v-if="selectedPlugin.status !== 'revoked'"
                :value="enrollmentState(selectedPlugin).enabled"
                @update:value="(value: boolean) => toggleEnabled(selectedPlugin!, value)"
              />
              <NPopconfirm
                v-if="selectedEnrollment"
                @positive-click="unenroll(selectedPlugin)"
              >
                <template #trigger>
                  <NButton size="small" quaternary>{{ t('workerPlugins.unenroll') }}</NButton>
                </template>
                {{ t('workerPlugins.unenrollConfirm') }}
              </NPopconfirm>
            </NSpace>
          </section>

          <NButton
            v-if="selectedPlugin.status !== 'revoked' && !(selectedEnrollment?.is_default && selectedEnrollment.version === selectedPlugin.version)"
            block
            secondary
            type="info"
            @click="setDefault(selectedPlugin)"
          >
            {{ t('workerPlugins.setDefaultVersion') }}
          </NButton>

          <NDivider />

          <section class="detail-section">
            <span class="section-label danger-label">{{ t('workerPlugins.versionStatus') }}</span>
            <p>{{ t('workerPlugins.statusHint') }}</p>
            <NSpace>
              <NButton
                v-if="selectedPlugin.status === 'published'"
                size="small"
                @click="transition(selectedPlugin, 'deprecate')"
              >
                {{ t('workerPlugins.markDeprecated') }}
              </NButton>
              <NButton
                v-if="selectedPlugin.status === 'deprecated'"
                size="small"
                type="primary"
                secondary
                @click="transition(selectedPlugin, 'republish')"
              >
                {{ t('workerPlugins.republish') }}
              </NButton>
              <NPopconfirm
                v-if="selectedPlugin.status === 'published' || selectedPlugin.status === 'deprecated'"
                @positive-click="transition(selectedPlugin, 'revoke')"
              >
                <template #trigger>
                  <NButton size="small" type="error" secondary>{{ t('workerPlugins.revoke') }}</NButton>
                </template>
                {{ t('workerPlugins.revokeConfirm') }}
              </NPopconfirm>
              <NPopconfirm @positive-click="removeVersion(selectedPlugin)">
                <template #trigger>
                  <NButton size="small" type="error">{{ t('workerPlugins.deleteVersion') }}</NButton>
                </template>
                {{ t('workerPlugins.deleteConfirm', { id: selectedPlugin.id, version: selectedPlugin.version }) }}
              </NPopconfirm>
            </NSpace>
          </section>
        </div>
      </NDrawerContent>
    </NDrawer>

    <NModal
      v-model:show="showPublishModal"
      preset="card"
      :title="t('workerPlugins.publishTitle')"
      :style="{ width: '720px', maxWidth: '92vw' }"
    >
      <NSpace vertical size="large">
        <NAlert type="warning" :show-icon="true">
          {{ t('workerPlugins.publishHint') }}
        </NAlert>
        <NInput
          v-model:value="publishBundleText"
          type="textarea"
          :placeholder="t('workerPlugins.bundlePlaceholder')"
          :rows="14"
          style="font-family: monospace"
        />
        <NSpace justify="end">
          <NButton @click="showPublishModal = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="publishing" @click="submitPublish">{{ t('workerPlugins.publishAction') }}</NButton>
        </NSpace>
      </NSpace>
    </NModal>
  </div>
</template>

<style scoped>
.worker-plugins-view {
  max-width: 1440px;
  margin: 0 auto;
}

.plugin-center-card {
  overflow: hidden;
}

.section-label {
  color: var(--n-text-color-3);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.plugin-description,
.detail-section p {
  margin: 0;
  color: var(--n-text-color-3);
  font-size: 13px;
  line-height: 1.7;
}

.plugin-notice {
  margin-bottom: 16px;
}

.plugin-id,
.digest-value {
  color: var(--n-text-color-3);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.drawer-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.drawer-title span {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drawer-body {
  display: grid;
  gap: 20px;
}

.plugin-id {
  display: block;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--n-code-color);
}

.detail-section {
  display: grid;
  gap: 8px;
}

.enrollment-section {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px;
  border: 1px solid var(--n-border-color);
  border-radius: 8px;
}

.danger-label {
  color: var(--n-error-color);
}
</style>

<style>
/*
 * 列 render 函数（h()）生成的单元格 DOM 不携带本组件的 scoped data-v attribute，
 * 表格内样式必须全局作用域；全部挂在 .worker-plugins-view 下避免泄漏。
 */
.worker-plugins-view .plugin-identity {
  display: grid;
  gap: 2px;
}

.worker-plugins-view .plugin-identity-main {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.worker-plugins-view .plugin-identity-main strong {
  color: var(--n-text-color-1);
  font-weight: 600;
}

.worker-plugins-view .plugin-identity-id {
  color: var(--n-text-color-3);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.worker-plugins-view .configuration-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  color: var(--n-text-color-3);
  font-size: 12px;
}

.worker-plugins-view .configuration-summary > :not(:last-child)::after {
  margin-left: 8px;
  color: var(--n-divider-color);
  content: "·";
}

.worker-plugins-view .configuration-profile {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--n-code-color);
  font-size: 12px;
}

.worker-plugins-view .muted-value {
  color: var(--n-text-color-disabled);
}

.worker-plugins-view .plugin-row-revoked {
  opacity: 0.55;
}

.worker-plugins-view .plugin-row-revoked:hover {
  opacity: 0.8;
}
</style>

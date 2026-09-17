<script setup lang="ts">
import { computed, h, onMounted, ref } from "vue";
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

const message = useMessage();
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
    message.error(error?.response?.data?.error?.message || "加载插件列表失败");
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

const statusLabel: Record<WorkerPluginVersion["status"], string> = {
  published: "已发布",
  deprecated: "已废弃",
  revoked: "已撤销",
  draft: "草稿",
};

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
    message.error(error?.response?.data?.error?.message || "更新启用状态失败");
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
    message.error(error?.response?.data?.error?.message || "设置默认版本失败");
  }
}

async function transition(
  row: WorkerPluginVersion,
  action: "deprecate" | "republish" | "revoke",
) {
  try {
    await workerPluginApi[action](row.id, row.version);
    message.success(`插件 ${row.id}@${row.version} 状态已更新`);
    await load();
  } catch (error: any) {
    message.error(error?.response?.data?.error?.message || "状态更新失败");
  }
}

async function submitPublish() {
  let payload: PublishPluginPayload;
  try {
    payload = JSON.parse(publishBundleText.value);
  } catch {
    message.error("Bundle JSON 解析失败，请检查格式");
    return;
  }
  if (!payload?.manifest || !payload?.files) {
    message.error("Bundle 必须包含 manifest 与 files 两个字段");
    return;
  }
  publishing.value = true;
  try {
    const res = await workerPluginApi.publish(payload);
    message.success(`已发布 ${res.id}@${res.version}`);
    showPublishModal.value = false;
    publishBundleText.value = "";
    await load();
  } catch (error: any) {
    message.error(error?.response?.data?.error?.message || "发布失败");
  } finally {
    publishing.value = false;
  }
}

const columns: DataTableColumns<WorkerPluginVersion> = [
  {
    title: "插件版本",
    key: "name",
    minWidth: 230,
    render: (row) =>
      h("div", { class: "plugin-identity" }, [
        h("strong", null, row.name),
        h("code", null, row.id),
        h(NTag, { size: "small", bordered: false }, { default: () => `v${row.version}` }),
      ]),
  },
  {
    title: "状态",
    key: "status",
    width: 100,
    render: (row) =>
      h(
        NTag,
        { type: statusTagType[row.status], size: "small" },
        { default: () => statusLabel[row.status] },
      ),
  },
  {
    title: "运行配置",
    key: "configuration",
    minWidth: 190,
    render: (row) =>
      h("div", { class: "configuration-summary" }, [
        h("span", null, row.model_profile),
        h("span", null, `${row.tools.length} 个工具`),
        h("span", null, `${row.max_turns} 轮 · ${row.timeout_seconds}s`),
      ]),
  },
  {
    title: "我的设置",
    key: "enrollment",
    width: 180,
    render: (row) => {
      if (row.status === "revoked") return h("span", { class: "muted-value" }, "不可用");
      const state = enrollmentState(row);
      return h(NSpace, { size: 8, align: "center", wrap: false }, {
        default: () => [
          h(NSwitch, {
            size: "small",
            value: state.enabled,
            onUpdateValue: (value: boolean) => toggleEnabled(row, value),
          }),
          state.enrollment?.is_default && state.isCurrent
            ? h(NTag, { size: "small", type: "info", bordered: false }, { default: () => "默认" })
            : h(
                NButton,
                {
                  size: "tiny",
                  quaternary: true,
                  disabled: row.status === "draft",
                  onClick: () => setDefault(row),
                },
                { default: () => "设为默认" },
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
        { default: () => "详情" },
      ),
  },
];

onMounted(load);
</script>

<template>
  <div class="worker-plugins-view">
    <NCard class="plugin-center-card" :bordered="false">
      <div class="page-toolbar">
        <div>
          <div class="eyebrow">EXPERIMENTAL</div>
          <h2>Worker 插件中心</h2>
          <p>管理版本化的只读 Worker 角色包与个人默认版本。</p>
        </div>
        <NSpace class="toolbar-actions">
          <NButton size="small" @click="load" :loading="loading">刷新</NButton>
          <NButton size="small" type="primary" @click="showPublishModal = true">
            发布新版本
          </NButton>
        </NSpace>
      </div>

      <NAlert type="info" class="plugin-notice" :show-icon="true">
        版本发布后不可变；每次 run 固定使用 id、version 与 digest。撤销版本会拒绝新的 run，已创建的 run 可继续完成。
      </NAlert>

      <NDataTable
        class="plugin-overview-table"
        :columns="columns"
        :data="plugins"
        :loading="loading"
        :bordered="false"
        :single-line="false"
        size="small"
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
            <NButton size="small" tertiary @click="load" :loading="loading">刷新</NButton>
          </div>
        </template>

        <div class="drawer-body">
          <code class="plugin-id">{{ selectedPlugin.id }}@{{ selectedPlugin.version }}</code>
          <p class="plugin-description">{{ selectedPlugin.description || "暂无插件说明。" }}</p>

          <NDescriptions label-placement="left" :column="1" bordered size="small">
            <NDescriptionsItem label="模型 Profile">
              {{ selectedPlugin.model_profile }}
            </NDescriptionsItem>
            <NDescriptionsItem label="执行预算">
              {{ selectedPlugin.max_turns }} 轮 · {{ selectedPlugin.timeout_seconds }} 秒
            </NDescriptionsItem>
            <NDescriptionsItem label="发布时间">
              {{ selectedPlugin.published_at ? formatTimestamp(selectedPlugin.published_at) : "—" }}
            </NDescriptionsItem>
            <NDescriptionsItem label="Digest">
              <code class="digest-value">{{ selectedPlugin.digest }}</code>
            </NDescriptionsItem>
          </NDescriptions>

          <section class="detail-section">
            <span class="section-label">允许工具</span>
            <NSpace size="small" wrap>
              <NTag v-for="tool in selectedPlugin.tools" :key="tool" size="small" :bordered="false">
                {{ tool }}
              </NTag>
            </NSpace>
          </section>

          <section v-if="selectedPlugin.status !== 'revoked'" class="detail-section enrollment-section">
            <div>
              <span class="section-label">个人启用</span>
              <p>{{ enrollmentState(selectedPlugin).enabled ? "当前版本可用于默认选择。" : "当前版本已禁用。" }}</p>
            </div>
            <NSwitch
              :value="enrollmentState(selectedPlugin).enabled"
              @update:value="(value: boolean) => toggleEnabled(selectedPlugin!, value)"
            />
          </section>

          <NButton
            v-if="selectedPlugin.status !== 'revoked' && !(selectedEnrollment?.is_default && selectedEnrollment.version === selectedPlugin.version)"
            block
            secondary
            type="info"
            @click="setDefault(selectedPlugin)"
          >
            设为默认版本
          </NButton>

          <NDivider />

          <section class="detail-section">
            <span class="section-label danger-label">版本状态</span>
            <p>状态变更只影响新建 run；撤销不可恢复。</p>
            <NSpace>
              <NButton
                v-if="selectedPlugin.status === 'published'"
                size="small"
                @click="transition(selectedPlugin, 'deprecate')"
              >
                标记为废弃
              </NButton>
              <NButton
                v-if="selectedPlugin.status === 'deprecated'"
                size="small"
                type="primary"
                secondary
                @click="transition(selectedPlugin, 'republish')"
              >
                恢复发布
              </NButton>
              <NPopconfirm
                v-if="selectedPlugin.status === 'published' || selectedPlugin.status === 'deprecated'"
                @positive-click="transition(selectedPlugin, 'revoke')"
              >
                <template #trigger>
                  <NButton size="small" type="error" secondary>撤销版本</NButton>
                </template>
                撤销后不能再创建新的 run，且不可恢复。确认撤销？
              </NPopconfirm>
            </NSpace>
          </section>
        </div>
      </NDrawerContent>
    </NDrawer>

    <NModal
      v-model:show="showPublishModal"
      preset="card"
      title="发布插件版本"
      class="publish-modal"
    >
      <NSpace vertical size="large">
        <NAlert type="warning" :show-icon="true">
          仅发布官方 bundle：manifest 与 prompt.md、input.schema.json、output.schema.json 三个 bundle 文件。含可执行文件的 bundle 会被拒绝。
        </NAlert>
        <NInput
          v-model:value="publishBundleText"
          type="textarea"
          placeholder='粘贴 bundle JSON，例如：
{
  "manifest": { "schema_version": "1", "id": "com.llm-gateway.code-search", "version": "1.0.1", ... },
  "files": { "prompt.md": "...", "input.schema.json": "...", "output.schema.json": "..." },
  "changelog": "可选，版本变更说明"
}'
          :rows="14"
          style="font-family: monospace"
        />
        <NSpace justify="end">
          <NButton @click="showPublishModal = false">取消</NButton>
          <NButton type="primary" :loading="publishing" @click="submitPublish">发布</NButton>
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

.page-toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 24px;
}

.eyebrow,
.section-label {
  color: var(--n-text-color-3);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.page-toolbar h2 {
  margin: 4px 0 6px;
  color: var(--n-text-color-1);
  font-size: 24px;
  line-height: 1.25;
}

.page-toolbar p,
.plugin-description,
.detail-section p {
  margin: 0;
  color: var(--n-text-color-3);
  font-size: 13px;
  line-height: 1.7;
}

.toolbar-actions {
  flex: none;
}

.plugin-notice {
  margin-bottom: 16px;
}

.plugin-identity {
  display: grid;
  gap: 4px;
}

.plugin-identity strong {
  color: var(--n-text-color-1);
  font-weight: 600;
}

.plugin-identity code,
.plugin-id,
.digest-value {
  color: var(--n-text-color-3);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.configuration-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  color: var(--n-text-color-3);
  font-size: 12px;
}

.configuration-summary span:not(:last-child)::after {
  margin-left: 8px;
  color: var(--n-divider-color);
  content: "·";
}

.muted-value {
  color: var(--n-text-color-disabled);
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

.publish-modal {
  width: min(720px, calc(100vw - 32px));
}

@media (max-width: 700px) {
  .page-toolbar {
    display: grid;
    gap: 16px;
  }

  .toolbar-actions {
    justify-content: flex-start;
  }

  .page-toolbar h2 {
    font-size: 21px;
  }
}
</style>

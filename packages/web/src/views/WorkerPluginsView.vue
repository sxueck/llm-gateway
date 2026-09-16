<script setup lang="ts">
import { computed, h, onMounted, ref } from "vue";
import type { DataTableColumns } from "naive-ui";
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NInput,
  NModal,
  NPopconfirm,
  NSpace,
  NSwitch,
  NTag,
  NTooltip,
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

const showPublishModal = ref(false);
const publishBundleText = ref("");
const publishing = ref(false);

const enrollmentByPlugin = computed(() => {
  const map = new Map<string, PluginEnrollment>();
  for (const e of enrollments.value) map.set(e.plugin_id, e);
  return map;
});

async function load() {
  loading.value = true;
  try {
    const res = await workerPluginApi.list();
    plugins.value = res.plugins;
    enrollments.value = res.enrollments;
  } catch (e: any) {
    message.error(e?.response?.data?.error?.message || "加载插件列表失败");
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

async function toggleEnabled(row: WorkerPluginVersion, enabled: boolean) {
  const current = enrollmentByPlugin.value.get(row.id);
  // 关闭默认版本时同步取消默认，避免“已禁用但仍为默认”的非法组合
  const isDefault = enabled ? (current?.is_default ?? false) : false;
  try {
    await workerPluginApi.enroll(row.id, {
      version: row.version,
      enabled,
      is_default: isDefault,
    });
    await load();
  } catch (e: any) {
    message.error(e?.response?.data?.error?.message || "更新启用状态失败");
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
  } catch (e: any) {
    message.error(e?.response?.data?.error?.message || "设置默认版本失败");
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
  } catch (e: any) {
    message.error(e?.response?.data?.error?.message || "状态更新失败");
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
  } catch (e: any) {
    message.error(e?.response?.data?.error?.message || "发布失败");
  } finally {
    publishing.value = false;
  }
}

const columns: DataTableColumns<WorkerPluginVersion> = [
  {
    title: "插件",
    key: "name",
    render: (row) =>
      h("div", null, [
        h("div", null, row.name),
        h(
          "div",
          {
            style: "font-size: 12px; color: var(--n-text-color-disabled, #999)",
          },
          row.id,
        ),
      ]),
  },
  { title: "版本", key: "version", width: 90 },
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
  { title: "模型 Profile", key: "model_profile", width: 130 },
  {
    title: "工具",
    key: "tools",
    render: (row) =>
      h(
        NSpace,
        { size: 4 },
        {
          default: () =>
            row.tools.map((t) =>
              h(NTag, { size: "small", bordered: false }, { default: () => t }),
            ),
        },
      ),
  },
  {
    title: "预算",
    key: "budget",
    width: 130,
    render: (row) => `${row.max_turns} turns / ${row.timeout_seconds}s`,
  },
  {
    title: "Digest",
    key: "digest",
    width: 150,
    render: (row) =>
      h(
        NTooltip,
        {},
        {
          trigger: () =>
            h(
              "code",
              { style: "font-size: 12px" },
              row.digest.slice(7, 19) + "…",
            ),
          default: () => row.digest,
        },
      ),
  },
  {
    title: "发布时间",
    key: "published_at",
    width: 160,
    render: (row) =>
      row.published_at ? formatTimestamp(row.published_at) : "—",
  },
  {
    title: "我的启用",
    key: "enrollment",
    width: 170,
    render: (row) => {
      if (row.status === "revoked") return h("span", null, "—");
      const enrollment = enrollmentByPlugin.value.get(row.id);
      const isCurrent = enrollment?.version === row.version;
      const effectiveEnabled =
        enrollment === undefined
          ? true
          : enrollment.enabled && enrollment.version === row.version;
      return h(
        NSpace,
        { size: 8, align: "center" },
        {
          default: () => [
            h(NSwitch, {
              size: "small",
              value: effectiveEnabled,
              onUpdateValue: (v: boolean) => toggleEnabled(row, v),
            }),
            enrollment?.is_default && isCurrent
              ? h(
                  NTag,
                  { size: "small", type: "info", bordered: false },
                  { default: () => "默认" },
                )
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
        },
      );
    },
  },
  {
    title: "操作",
    key: "actions",
    width: 170,
    render: (row) => {
      const buttons: ReturnType<typeof h>[] = [];
      if (row.status === "published") {
        buttons.push(
          h(
            NButton,
            { size: "tiny", onClick: () => transition(row, "deprecate") },
            { default: () => "废弃" },
          ),
        );
      }
      if (row.status === "deprecated") {
        buttons.push(
          h(
            NButton,
            { size: "tiny", onClick: () => transition(row, "republish") },
            { default: () => "恢复" },
          ),
        );
      }
      if (row.status === "published" || row.status === "deprecated") {
        buttons.push(
          h(
            NPopconfirm,
            { onPositiveClick: () => transition(row, "revoke") },
            {
              trigger: () =>
                h(
                  NButton,
                  { size: "tiny", type: "error", quaternary: true },
                  { default: () => "撤销" },
                ),
              default: () =>
                "撤销后该版本不能再创建新 run（存量 run 允许完成），且不可恢复。确认？",
            },
          ),
        );
      }
      return h(NSpace, { size: 4 }, { default: () => buttons });
    },
  },
];

onMounted(load);
</script>

<template>
  <div class="worker-plugins-view">
    <NCard title="Worker 插件中心" style="margin-bottom: 16px">
      <template #header-extra>
        <NSpace>
          <NButton size="small" @click="load" :loading="loading">刷新</NButton>
          <NButton size="small" type="primary" @click="showPublishModal = true"
            >发布新版本</NButton
          >
        </NSpace>
      </template>
      <NAlert type="info" style="margin-bottom: 12px" :show-icon="true">
        插件是声明式角色包（prompt + schema +
        工具/预算策略），版本发布后不可变；run 创建时固定
        id+version+digest。已撤销版本拒绝新
        run。个人启用状态与默认版本仅影响客户端默认选择。
      </NAlert>
      <NDataTable
        :columns="columns"
        :data="plugins"
        :loading="loading"
        :bordered="false"
        size="small"
        :row-key="(row: WorkerPluginVersion) => `${row.id}@${row.version}`"
      />
    </NCard>

    <NModal
      v-model:show="showPublishModal"
      preset="card"
      title="发布插件版本"
      style="width: 720px"
    >
      <NSpace vertical size="large">
        <NAlert type="warning" :show-icon="true">
          仅发布官方 bundle：manifest + 三个 bundle
          文件（prompt.md、input.schema.json、
          output.schema.json）。含可执行文件（*.ts/*.js/package.json 等）的
          bundle 会被校验拒绝。
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
          <NButton type="primary" :loading="publishing" @click="submitPublish"
            >发布</NButton
          >
        </NSpace>
      </NSpace>
    </NModal>
  </div>
</template>

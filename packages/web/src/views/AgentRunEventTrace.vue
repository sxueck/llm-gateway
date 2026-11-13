<template>
  <div class="event-list">
    <Trace
      v-for="event in events"
      :key="event.seq"
      class="event-row"
      :data-event-seq="event.seq"
    >
      <TraceLine>
        <span
          data-slot="event-dot"
          class="event-dot mt-1.5 size-2 shrink-0 rounded-full"
          :class="eventDotClass(event.type)"
        />
        <Badge
          data-slot="event-type-badge"
          :variant="eventBadgeVariant(event.type)"
          :class="eventBadgeClass(event.type)"
        >
          {{ event.type }}
        </Badge>
        <span class="event-summary">{{ eventSummary(event) }}</span>
        <TraceDescription class="event-time">
          {{ formatEventTime(event.created_at) }}
        </TraceDescription>
      </TraceLine>
      <TraceCollapsible :default-open="defaultOpen" class="event-payload">
        <TraceCollapsibleTrigger>
          <code class="event-seq">#{{ event.seq }}</code>
          {{ t("agentRunDetail.payload") }}
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <pre data-slot="event-payload-json" class="payload-json">{{
            JSON.stringify(event.payload, null, 2)
          }}</pre>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceLine,
} from "@/components/ui/trace";
import type { AgentRunEvent } from "@/api/config";

withDefaults(defineProps<{ events: AgentRunEvent[]; defaultOpen?: boolean }>(), {
  defaultOpen: false,
});

const { t } = useI18n();

function eventTagType(
  type: string,
): "default" | "info" | "success" | "warning" | "error" {
  if (type.startsWith("tool.")) return "warning";
  if (type === "model.completed") return "success";
  if (type === "run.failed") return "error";
  if (type === "run.cancelled") return "warning";
  if (type === "run.completed") return "success";
  if (type === "run.queued") return "default";
  return "info";
}

// shadcn-vue Badge 仅有 default/secondary/destructive/outline 四种 variant，
// 语义色（info/success/warning）通过 Tailwind 任意值类映射到现有主题变量，保持原配色。
function eventBadgeVariant(
  type: string,
): "default" | "secondary" | "destructive" | "outline" {
  const tag = eventTagType(type);
  if (tag === "error") return "destructive";
  if (tag === "default") return "outline";
  return "secondary";
}

function eventBadgeClass(type: string): string {
  const tag = eventTagType(type);
  switch (tag) {
    case "info":
      return "bg-[var(--color-info)] text-white border-transparent";
    case "success":
      return "bg-[var(--color-success)] text-white border-transparent";
    case "warning":
      return "bg-[var(--color-warning)] text-white border-transparent";
    default:
      return "";
  }
}

function eventDotClass(type: string): string {
  return `dot-${eventTagType(type)}`;
}

function eventSummary(event: AgentRunEvent): string {
  const p = event.payload ?? {};
  switch (event.type) {
    case "run.queued":
    case "run.started":
      return typeof p.plugin === "string" ? p.plugin : "";
    case "source.resolved":
      return [p.source_type, p.snapshot_id]
        .filter((v) => v !== null && v !== undefined && v !== "")
        .map(String)
        .join(" · ");
    case "worker.started":
      return typeof p.executor === "string" ? p.executor : "";
    case "model.completed":
      return `turn ${String(p.turn ?? "?")} · ↑${formatNumber(
        Number(p.prompt_tokens ?? 0),
      )} ↓${formatNumber(Number(p.completion_tokens ?? 0))}`;
    default: {
      const entries = Object.entries(p)
        .filter(
          ([, v]) =>
            typeof v === "string" ||
            typeof v === "number" ||
            typeof v === "boolean",
        )
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${String(v)}`);
      return entries.join(" · ");
    }
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatEventTime(value: number): string {
  const d = new Date(value);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
</script>

<style scoped>
.event-list {
  display: flex;
  flex-direction: column;
}
.event-row {
  padding: 10px 0;
  border-bottom: 1px dashed #ececec;
}
.event-row:last-child {
  border-bottom: none;
}
.event-row :deep([data-slot="trace-line"]) {
  width: 100%;
  flex-wrap: wrap;
}
.event-row :deep([data-slot="event-type-badge"]) {
  padding: 3px 8px;
  line-height: 1.4;
}
.event-row :deep([data-slot="trace-collapsible-trigger"]) {
  margin-left: 16px;
  padding: 4px 6px;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: 12px;
}
.event-row :deep([data-slot="trace-collapsible-trigger"]:hover) {
  background: #f2f5f3;
}
.event-row :deep([data-slot="trace-collapsible-trigger"]:focus-visible) {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
.event-dot {
  background: #d9d9d9;
}
.event-dot.dot-info {
  background: var(--color-info);
}
.event-dot.dot-success {
  background: var(--color-success);
}
.event-dot.dot-warning {
  background: var(--color-warning);
}
.event-dot.dot-error {
  background: var(--color-error);
}
.event-summary {
  font-size: 12px;
  color: #595959;
  word-break: break-all;
}
.event-time {
  margin-left: auto;
  font-size: 12px;
  color: #8c8c8c;
  white-space: nowrap;
}
.event-seq {
  font-size: 11px;
  color: #8c8c8c;
}
.payload-json {
  margin: 0;
  padding: 10px;
  background: #f7f8fa;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.6;
  overflow-x: auto;
}
</style>

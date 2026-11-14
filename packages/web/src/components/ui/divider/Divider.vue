<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { computed, useSlots } from "vue"
import { cn } from "cn"
import { cva } from "class-variance-authority"
import { Primitive } from "reka-ui"

/*
 * 本地 shadcn-vue 风格分隔线，替换 naive-ui 的 NDivider。
 * 结构与视觉对齐 NDivider：横向渲染 role="separator" 的 flex 容器，
 * 无标题时一条整行 1px 细线，有标题时为 线-标题-线 布局，
 * title-placement 控制标题停靠（left 时前导线固定 28px）。
 *
 * 默认上下 24px 间距刻意放在行内样式上：与 NDivider 注入的
 * 运行时样式优先级一致 —— 可被使用处的内联 style 覆盖，
 * 且不受 Tailwind utilities 分层 / 视图 scoped 样式影响，
 * 从而保持迁移前（如 class="my-4"、class="form-section"）的实际渲染效果。
 * 线色用 shadcn 的 --border 令牌（var(--color-neutral-300)），与主题覆盖的
 * dividerColor var(--color-neutral-300) 视觉一致。
 */
const props = withDefaults(
  defineProps<{
    titlePlacement?: "left" | "center" | "right"
    dashed?: boolean
    vertical?: boolean
    class?: HTMLAttributes["class"]
  }>(),
  { titlePlacement: "center" },
)

const dividerVariants = cva("relative", {
  variants: {
    orientation: {
      horizontal: "flex w-full items-center box-border text-base text-foreground",
      vertical: "inline-block h-[1em] w-px align-middle bg-border mx-2 text-base",
    },
  },
})

const slots = useSlots()
const hasTitle = computed(() => !props.vertical && Boolean(slots.default))

const lineStyleClass = computed(() =>
  props.dashed
    ? "h-0 border-t border-dashed border-border bg-transparent"
    : "h-px bg-border",
)

const leftLineClass = computed(() =>
  cn(
    "m-0 grow border-0",
    lineStyleClass.value,
    hasTitle.value && props.titlePlacement === "left" && "w-7 grow-0",
  ),
)

const rightLineClass = computed(() =>
  cn(
    "m-0 grow border-0",
    lineStyleClass.value,
    props.titlePlacement === "right" && "w-7 grow-0",
  ),
)
</script>

<template>
  <Primitive
    v-if="vertical"
    role="separator"
    aria-orientation="vertical"
    data-slot="divider"
    :class="cn(dividerVariants({ orientation: 'vertical' }), props.class)"
  />
  <Primitive
    v-else
    role="separator"
    data-slot="divider"
    :class="cn(dividerVariants({ orientation: 'horizontal' }), props.class)"
    :style="{ marginTop: '24px', marginBottom: '24px' }"
  >
    <div
      data-slot="divider-line"
      :class="leftLineClass"
    />
    <div
      v-if="hasTitle"
      data-slot="divider-title"
      class="mx-3 flex items-center whitespace-nowrap font-medium"
    >
      <slot />
    </div>
    <div
      v-if="hasTitle"
      data-slot="divider-line"
      :class="rightLineClass"
    />
  </Primitive>
</template>

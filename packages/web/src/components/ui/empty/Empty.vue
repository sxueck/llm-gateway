<script setup lang="ts">
import type { PrimitiveProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import type { EmptyVariants } from "."
import { computed, useSlots } from "vue"
import { Inbox } from "lucide-vue-next"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "cn"
import { Primitive } from "reka-ui"
import { emptyVariants } from "."

/*
 * 本地 shadcn-vue 风格空状态，替换 naive-ui 的 NEmpty。
 * 结构对齐 NEmpty：垂直居中的 flex 容器，依次渲染
 * 图标（show-icon=false 时隐藏）、描述、extra 操作区。
 * 描述支持 description prop 或默认插槽（插槽优先，与 NEmpty 一致），
 * 图标可用 #icon 插槽覆盖（默认 lucide Inbox，aria-hidden 纯装饰）。
 */
const props = withDefaults(
  defineProps<
    PrimitiveProps & {
      /** 描述文本；默认插槽存在时优先渲染插槽 */
      description?: string
      /** 是否展示图标（NEmpty 默认 true） */
      showIcon?: boolean
      size?: EmptyVariants["size"]
      class?: HTMLAttributes["class"]
    }
  >(),
  { showIcon: true, as: "div" },
)

const slots = useSlots()
const delegatedProps = reactiveOmit(props, "class", "description", "showIcon", "size")

const hasDescription = computed(() => Boolean(props.description || slots.default))
const hasExtra = computed(() => Boolean(slots.extra))
</script>

<template>
  <Primitive
    data-slot="empty"
    :class="cn(emptyVariants({ size }), props.class)"
    v-bind="delegatedProps"
  >
    <div
      v-if="props.showIcon"
      data-slot="empty-icon"
      aria-hidden="true"
      class="mb-4 leading-none opacity-80 [&_svg:not([class*='size-'])]:size-[1em]"
    >
      <slot name="icon">
        <Inbox class="size-[1em]" />
      </slot>
    </div>
    <div
      v-if="hasDescription"
      data-slot="empty-description"
      class="mt-0 leading-relaxed transition-colors"
    >
      <slot>{{ props.description }}</slot>
    </div>
    <div
      v-if="hasExtra"
      data-slot="empty-extra"
      class="mt-4 flex items-center justify-center gap-2"
    >
      <slot name="extra" />
    </div>
  </Primitive>
</template>

import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Empty } from "./Empty.vue"

/*
 * 对齐 naive-ui NEmpty 的外观变量：
 * - 尺寸同时缩放文字与图标（NEmpty: small/medium/large/huge）
 */
export const emptyVariants = cva(
  "flex flex-col items-center justify-center text-center box-border text-muted-foreground",
  {
    variants: {
      size: {
        small: "text-xs [&_[data-slot=empty-icon]]:text-[28px]",
        medium: "text-sm [&_[data-slot=empty-icon]]:text-[36px]",
        large: "text-base [&_[data-slot=empty-icon]]:text-[44px]",
        huge: "text-lg [&_[data-slot=empty-icon]]:text-[52px]",
      },
    },
    defaultVariants: {
      size: "medium",
    },
  },
)

export type EmptyVariants = VariantProps<typeof emptyVariants>

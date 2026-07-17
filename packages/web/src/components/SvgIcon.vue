<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    :viewBox="viewBox"
    fill="currentColor"
    :width="size"
    :height="size"
    :style="{ color }"
    aria-hidden="true"
  >
    <path :d="path" />
  </svg>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    path: string
    viewBox?: string
    size?: number | string
    color?: string
  }>(),
  {
    viewBox: '0 0 24 24',
    size: 24,
  }
)
</script>

<template>
  <svg
    class="nav-glyph"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(d, index) in paths" :key="index" :d="d" />
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NAV_GLYPHS } from '@/components/nav-icons';
import type { NavIconName } from '@/components/nav-icons';

const props = withDefaults(
  defineProps<{
    name: NavIconName;
    size?: number | string;
    strokeWidth?: number;
  }>(),
  {
    size: 18,
    strokeWidth: 1.7,
  }
);

const paths = computed(() => NAV_GLYPHS[props.name]);
</script>

<style scoped>
.nav-glyph {
  display: block;
  flex: 0 0 auto;
}
</style>
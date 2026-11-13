<template>
  <component
    :is="icon"
    class="nav-glyph"
    :size="size"
    :stroke-width="strokeWidth"
    aria-hidden="true"
    focusable="false"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NAV_GLYPHS } from '@/components/nav-icons';
import type { NavIconName } from '@/components/nav-icons';

const props = withDefaults(
  defineProps<{
    name: NavIconName;
    size?: number;
    strokeWidth?: number;
  }>(),
  {
    size: 16,
    strokeWidth: 1.75,
  }
);

const icon = computed(() => NAV_GLYPHS[props.name]);
</script>

<style scoped>
.nav-glyph {
  display: block;
  flex: 0 0 auto;
}
</style>

<template>
  <div class="page-heading">
    <div v-if="$slots.prefix" class="page-heading__prefix">
      <slot name="prefix" />
    </div>
    <div class="page-heading__text">
      <div v-if="eyebrow" class="page-heading__eyebrow">{{ eyebrow }}</div>
      <h2 class="page-heading__title">
        {{ title }}
        <slot name="title-extra" />
      </h2>
      <p v-if="subtitle || $slots.subtitle" class="page-heading__subtitle">
        <slot name="subtitle">{{ subtitle }}</slot>
      </p>
    </div>
    <div v-if="$slots.actions" class="page-heading__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
// eyebrow 是装饰性的分类标签，两种语言下都保持大写英文（与 Worker 插件中心的 "EXPERIMENTAL" 同源）。
defineProps<{
  eyebrow?: string;
  title: string;
  subtitle?: string;
}>();
</script>

<style scoped>
/* 刻意避开全局 .page-header 工具类（style.css），组件本身不带外边距，间距由父级布局决定。 */
.page-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-xl);
}

.page-heading__prefix {
  display: flex;
  align-items: center;
  flex: none;
  padding-top: 2px;
}

.page-heading__eyebrow {
  color: #8c8c8c;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.page-heading__title {
  margin: 4px 0 6px;
  color: var(--color-title);
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.25;
}

.page-heading__subtitle {
  margin: 0;
  color: #8c8c8c;
  font-size: 13px;
  line-height: 1.7;
  font-weight: 400;
}

.page-heading__actions {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex: none;
  padding-top: 2px;
}

@media (max-width: 700px) {
  .page-heading {
    flex-direction: column;
    gap: var(--space-md);
  }

  .page-heading__actions {
    flex-wrap: wrap;
    padding-top: 0;
  }

  .page-heading__title {
    font-size: 21px;
  }
}
</style>

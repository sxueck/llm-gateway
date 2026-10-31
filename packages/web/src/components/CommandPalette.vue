<template>
  <teleport to="body">
    <div
      v-if="visible"
      class="palette-overlay"
      @click.self="close"
      @keydown.esc.stop="close"
      @mousemove="pointerMoved = true"
    >
      <div
        class="palette"
        role="dialog"
        aria-modal="true"
        @keydown="handlePaletteKey"
      >
        <div class="palette-search">
          <n-input
            ref="inputRef"
            v-model:value="query"
            size="large"
            :bordered="false"
            :placeholder="t('commandPalette.placeholder')"
            @keydown.down.prevent="move(1)"
            @keydown.up.prevent="move(-1)"
            @keydown.enter.prevent="runActive"
          >
            <template #prefix>
              <NavIcon name="search" :size="17" class="palette-search-icon" />
            </template>
          </n-input>
        </div>

        <div ref="listRef" class="palette-list">
          <div
            class="palette-active-surface"
            aria-hidden="true"
            :style="highlightStyle"
          />
          <template v-for="group in groups" :key="group.key">
            <div class="palette-group">{{ group.label }}</div>
            <button
              v-for="entry in group.entries"
              :key="entry.id"
              type="button"
              class="palette-item"
              :class="{ 'palette-item-active': entry.id === activeEntry?.id }"
              @click="run(entry)"
              @mouseenter="activate(entry)"
            >
              <NavIcon :name="entry.iconName" :size="16" class="palette-item-icon" />
              <span class="palette-item-label">{{ entry.label }}</span>
              <span v-if="entry.hint" class="palette-item-hint">{{ entry.hint }}</span>
            </button>
          </template>
          <div v-if="!flatEntries.length" class="palette-empty">
            {{ t('commandPalette.empty') }}
          </div>
        </div>

        <div class="palette-footer">{{ t('commandPalette.hint') }}</div>
      </div>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { NInput } from 'naive-ui';
import NavIcon from '@/components/NavIcon.vue';
import type { NavIconName } from '@/components/nav-icons';
import { useNavigation } from '@/composables/useNavigation';
import { useAuthStore } from '@/stores/auth';
import { trapPaletteFocus } from '@/components/palette-focus';

interface PaletteEntry {
  id: string;
  label: string;
  hint: string;
  iconName: NavIconName;
  run: () => void;
}

const router = useRouter();
const { t } = useI18n();
const authStore = useAuthStore();
const { pages } = useNavigation();

const visible = ref(false);
const query = ref('');
const activeIndex = ref(0);
// 面板弹出时鼠标可能正停在某一行上，mouseenter 会把键盘选中项抢走；
// 真正移动过鼠标之后才让 hover 接管。
const pointerMoved = ref(false);
const inputRef = ref<{ focus: () => void } | null>(null);
const listRef = ref<HTMLElement | null>(null);
const highlightStyle = ref({
  opacity: 0,
  transform: 'translateY(0px)',
  height: '0px',
});
let previouslyFocusedElement: HTMLElement | null = null;

const pageEntries = computed<PaletteEntry[]>(() =>
  pages.value.map((page) => ({
    id: page.path,
    label: page.label,
    hint: page.hubLabel ?? page.groupLabel ?? '',
    iconName: page.iconName,
    run: () => {
      close();
      router.push(page.path);
    },
  }))
);

const actionEntries = computed<PaletteEntry[]>(() => [
  {
    id: 'action:refresh',
    label: t('commandPalette.actionRefresh'),
    hint: '',
    iconName: 'refresh',
    run: () => {
      close();
      router.go(0);
    },
  },
  {
    id: 'action:logout',
    label: t('commandPalette.actionLogout'),
    hint: '',
    iconName: 'logout',
    run: () => {
      close();
      authStore.logout();
      router.push('/login');
    },
  },
]);

/** 页面与动作同一套匹配规则：标签、所属分组、路径都参与，避免只能按中文名找。 */
const groups = computed(() => {
  const needle = query.value.trim().toLowerCase();
  const matches = (entry: PaletteEntry) =>
    !needle || `${entry.label} ${entry.hint} ${entry.id}`.toLowerCase().includes(needle);
  const pagesHit = pageEntries.value.filter(matches);
  const actionsHit = actionEntries.value.filter(matches);
  const defaultPages = needle ? pagesHit : pagesHit.slice(0, 8);
  const defaultActions = needle ? actionsHit : [];
  return [
    { key: 'pages', label: t('commandPalette.sectionPages'), entries: defaultPages },
    { key: 'actions', label: t('commandPalette.sectionActions'), entries: defaultActions },
  ].filter((group) => group.entries.length > 0);
});

const flatEntries = computed(() => groups.value.flatMap((group) => group.entries));

const activeEntry = computed<PaletteEntry | null>(() => flatEntries.value[activeIndex.value] ?? null);

watch(flatEntries, () => {
  activeIndex.value = 0;
});

watch([activeIndex, flatEntries, visible], () => {
  nextTick(() => {
    listRef.value?.querySelector('.palette-item-active')?.scrollIntoView({ block: 'nearest' });
    updateHighlight();
  });
});

function updateHighlight() {
  const list = listRef.value;
  const element = list?.querySelector<HTMLElement>('.palette-item-active');
  if (!visible.value || !list || !element) {
    highlightStyle.value = { ...highlightStyle.value, opacity: 0 };
    return;
  }

  highlightStyle.value = {
    opacity: 1,
    transform: `translateY(${element.offsetTop}px)`,
    height: `${element.offsetHeight}px`,
  };
}

function move(delta: number) {
  const total = flatEntries.value.length;
  if (!total) return;
  activeIndex.value = (activeIndex.value + delta + total) % total;
}

function activate(entry: PaletteEntry) {
  if (!pointerMoved.value) return;
  const index = flatEntries.value.findIndex((candidate) => candidate.id === entry.id);
  if (index >= 0) activeIndex.value = index;
}

function run(entry: PaletteEntry) {
  entry.run();
}

function runActive() {
  activeEntry.value?.run();
}

function open() {
  query.value = '';
  activeIndex.value = 0;
  pointerMoved.value = false;
  previouslyFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  visible.value = true;
  document.body.style.overflow = 'hidden';
  nextTick(() => inputRef.value?.focus());
}

function close() {
  if (!visible.value) return;
  visible.value = false;
  document.body.style.overflow = '';
  const restoreTarget = previouslyFocusedElement;
  previouslyFocusedElement = null;
  restoreTarget?.focus();
}

function handlePaletteKey(event: KeyboardEvent) {
  trapPaletteFocus(event, event.currentTarget as HTMLElement);
}

function handleGlobalKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && visible.value) {
    event.preventDefault();
    close();
    return;
  }
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
  event.preventDefault();
  if (visible.value) close();
  else open();
}

onMounted(() => window.addEventListener('keydown', handleGlobalKey));
onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKey);
  document.body.style.overflow = '';
});

defineExpose({ open, close });
</script>

<style scoped>
.palette-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 12vh 16px 16px;
  background: rgba(17, 24, 39, 0.3);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}

.palette {
  width: min(560px, 100%);
  display: flex;
  flex-direction: column;
  max-height: 60vh;
  border-radius: 16px;
  background: #ffffff;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.18), 0 2px 10px rgba(0, 0, 0, 0.08);
  overflow: hidden;
  animation: palette-in 0.12s ease-out;
}

@keyframes palette-in {
  from {
    opacity: 0;
    transform: translateY(-6px) scale(0.99);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.palette-search {
  padding: 6px 6px 6px 10px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.palette-search-icon {
  color: #9ca3af;
}

.palette-list {
  position: relative;
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 6px;
}

.palette-active-surface {
  position: absolute;
  top: 0;
  left: 6px;
  right: 6px;
  z-index: 0;
  border-radius: 8px;
  background: rgba(15, 107, 74, 0.08);
  pointer-events: none;
  transition:
    transform 180ms cubic-bezier(0.22, 1, 0.36, 1),
    height 180ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 120ms ease;
  will-change: transform, height;
}

.palette-group {
  padding: 8px 10px 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #8c8c8c;
}

.palette-item {
  position: relative;
  z-index: 1;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #374151;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}

.palette-item-active {
  color: var(--color-primary);
}

.palette-item-icon {
  flex: 0 0 auto;
  color: #9ca3af;
}

.palette-item-active .palette-item-icon {
  color: var(--color-primary);
}

.palette-item-label {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.palette-item-hint {
  flex: 0 0 auto;
  font-size: 12px;
  color: #9ca3af;
}

.palette-empty {
  padding: 24px 12px;
  text-align: center;
  font-size: 13px;
  color: #9ca3af;
}

.palette-footer {
  padding: 8px 12px;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
  font-size: 11px;
  color: #9ca3af;
}

@media (prefers-reduced-motion: reduce) {
  .palette-active-surface {
    transition: none;
  }
}
</style>

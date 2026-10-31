<template>
  <section ref="cardElement" class="heatmap-card" :aria-labelledby="'request-heatmap-title'" :aria-busy="loading">
    <div class="heatmap-header">
      <div>
        <h3 id="request-heatmap-title">{{ t('dashboard.heatmapTitle') }}</h3>
        <p>{{ t('dashboard.heatmapSubtitle', { days: visibleData?.days ?? 365 }) }}</p>
      </div>
      <strong v-if="data && !error" :title="total.toLocaleString()">{{ t('dashboard.heatmapTotal', { count: formatTokenNumber(total) }) }}</strong>
    </div>
    <div v-if="loading && !data" class="heatmap-skeleton" role="status" :aria-label="t('dashboard.heatmapLoading')">
      <div class="heatmap-placeholder" aria-hidden="true"></div>
    </div>
    <div v-if="error" class="heatmap-state" role="alert">
      {{ t('dashboard.heatmapError') }}
      <button class="heatmap-retry" type="button" @click="load">{{ t('dashboard.heatmapRetry') }}</button>
    </div>
    <template v-if="data">
      <div ref="scrollElement" class="heatmap-scroll" tabindex="0" @scroll="hoveredDay = null" :aria-label="t('dashboard.heatmapScroll')">
        <div class="heatmap-content" :style="{ '--heatmap-columns': cells.length / 7 }">
          <div class="heatmap-months">
            <span v-for="month in months" :key="month.index" :style="{ gridColumn: month.index + 1 }">{{ month.label }}</span>
          </div>
          <div class="heatmap-grid" role="group" :aria-label="t('dashboard.heatmapSummary', { count: formatTokenNumber(total), days: visibleData?.days ?? 365 })">
            <template v-for="(day, index) in cells" :key="index">
              <button v-if="day" type="button" class="heatmap-cell" :class="{ [`level-${day.level}`]: true, selected: selectedDay?.date === day.date }" :aria-label="t('dashboard.heatmapDay', { date: day.date, count: formatTokenNumber(day.totalTokens) })" :aria-pressed="selectedDay?.date === day.date" @mouseenter="showTooltip(day, $event)" @mouseleave="hoveredDay = null" @focus="showTooltip(day, $event)" @blur="hoveredDay = null" @click="selectedDay = day"></button>
              <span v-else class="heatmap-cell empty" aria-hidden="true"></span>
            </template>
          </div>
        </div>
      </div>
      <div v-if="hoveredDay" class="heatmap-tooltip" :style="tooltipStyle" role="status">
        <strong>{{ hoveredDay.date }}</strong>
        <span>{{ t('dashboard.heatmapDailyTotal') }}：{{ formatTokenNumber(hoveredDay.totalTokens) }}</span>
        <span>{{ t('dashboard.heatmapInput') }}：{{ formatTokenNumber(hoveredDay.promptTokens) }}</span>
        <span>{{ t('dashboard.heatmapOutput') }}：{{ formatTokenNumber(hoveredDay.completionTokens) }}</span>
        <span>{{ t('dashboard.heatmapCached') }}：{{ formatTokenNumber(hoveredDay.cachedTokens) }}</span>
        <span>{{ t('dashboard.totalRequests') }}：{{ hoveredDay.requestCount.toLocaleString() }}</span>
      </div>
      <div v-if="selectedDay" class="heatmap-detail" aria-live="polite">
        <div class="heatmap-detail-date">{{ selectedDay.date }}</div>
        <dl>
          <div><dt>{{ t('dashboard.heatmapDailyTotal') }}</dt><dd :title="selectedDay.totalTokens.toLocaleString()">{{ formatTokenNumber(selectedDay.totalTokens) }}</dd></div>
          <div><dt>{{ t('dashboard.heatmapInput') }}</dt><dd :title="selectedDay.promptTokens.toLocaleString()">{{ formatTokenNumber(selectedDay.promptTokens) }}</dd></div>
          <div><dt>{{ t('dashboard.heatmapOutput') }}</dt><dd :title="selectedDay.completionTokens.toLocaleString()">{{ formatTokenNumber(selectedDay.completionTokens) }}</dd></div>
          <div><dt>{{ t('dashboard.heatmapCached') }}</dt><dd :title="selectedDay.cachedTokens.toLocaleString()">{{ formatTokenNumber(selectedDay.cachedTokens) }}</dd></div>
          <div><dt>{{ t('dashboard.totalRequests') }}</dt><dd>{{ selectedDay.requestCount.toLocaleString() }}</dd></div>
        </dl>
        <p>{{ t('dashboard.heatmapCacheNote') }}</p>
      </div>
      <div class="heatmap-footer">
        <div class="heatmap-legend" :aria-label="t('dashboard.heatmapLegend')">
          <span>{{ t('dashboard.heatmapLess') }}</span>
          <i v-for="level in 5" :key="level" class="heatmap-cell" :class="`level-${level - 1}`"></i>
          <span>{{ t('dashboard.heatmapMore') }}</span>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { configApi, type RequestHeatmapResponse } from '@/api/config'
import { buildRequestHeatmap, heatmapWindow, formatHeatmapTokens as formatTokenNumber, type HeatmapDay } from '@/utils/request-heatmap'

const { t, locale } = useI18n()
const data = ref<RequestHeatmapResponse | null>(null)
const loading = ref(true)
const error = ref(false)
const selectedDay = ref<HeatmapDay | null>(null)
const hoveredDay = ref<HeatmapDay | null>(null)
const tooltipPosition = ref({ left: 0, top: 0 })
const tooltipAbove = ref(false)
const tooltipStyle = computed(() => ({ left: `${tooltipPosition.value.left}px`, top: `${tooltipPosition.value.top}px`, transform: tooltipAbove.value ? 'translateY(-100%)' : undefined }))
const cardElement = ref<HTMLElement | null>(null)
const scrollElement = ref<HTMLElement | null>(null)
const width = ref(0)
const visibleData = computed(() => data.value ? heatmapWindow(data.value, width.value) : null)
const cells = computed(() => visibleData.value ? buildRequestHeatmap(visibleData.value) : [])
const total = computed(() => visibleData.value?.items.reduce((sum, item) => sum + item.totalTokens, 0) ?? 0)
let resizeObserver: ResizeObserver | null = null
watch(scrollElement, (element, previous) => {
  if (!resizeObserver) return
  if (previous) resizeObserver.unobserve(previous)
  if (element) resizeObserver.observe(element)
})
const months = computed(() => {
  const first = cells.value.findIndex(Boolean)
  const labels = cells.value.flatMap((day, index) => {
    if (!day || (index !== first && !day.date.endsWith('-01'))) return []
    const date = new Date(`${day.date}T00:00:00Z`)
    return [{ index: Math.floor(index / 7), label: new Intl.DateTimeFormat(locale.value, { month: 'short', timeZone: 'UTC' }).format(date) }]
  })
  if (labels.length > 1 && labels[1].index - labels[0].index < 3) labels.shift()
  return labels
})

function showTooltip(day: HeatmapDay, event: Event) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  hoveredDay.value = day
  tooltipPosition.value = {
    left: Math.max(8, Math.min(rect.left, window.innerWidth - 190)),
    top: rect.top > 180 ? rect.top - 8 : rect.bottom + 8
  }
  tooltipAbove.value = rect.top > 180
}

function dismissDetailOnOutsideClick(event: MouseEvent) {
  const target = event.target
  if (target instanceof Element && cardElement.value?.contains(target) && target.closest('button.heatmap-cell, .heatmap-detail')) return
  selectedDay.value = null
}

async function load() {
  loading.value = true
  error.value = false
  try {
    const result = await configApi.getRequestHeatmap(730)
    if (!result.items.every(item => [item.totalTokens, item.promptTokens, item.completionTokens, item.cachedTokens].every(Number.isFinite))) {
      throw new Error('Invalid token heatmap response')
    }
    data.value = result
    selectedDay.value = selectedDay.value ? cells.value.find(day => day?.date === selectedDay.value?.date) ?? null : null
  } catch {
    error.value = true
  } finally {
    loading.value = false
  }
}

defineExpose({ load })
onMounted(() => {
  resizeObserver = new ResizeObserver(entries => { width.value = entries[0]?.contentRect.width ?? 0 })
  if (scrollElement.value) resizeObserver.observe(scrollElement.value)
  document.addEventListener('click', dismissDetailOnOutsideClick)
  load()
})
onUnmounted(() => {
  resizeObserver?.disconnect()
  document.removeEventListener('click', dismissDetailOnOutsideClick)
})
</script>

<style scoped>
.heatmap-card { padding: 24px 28px; border: 1px solid #e6ebe8; border-radius: 16px; background: #fff; }
.heatmap-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 22px; }
.heatmap-header h3 { margin: 0; color: #17231e; font-size: 17px; font-weight: 650; }
.heatmap-header p { margin: 5px 0 0; color: #68756f; font-size: 12px; }
.heatmap-header strong { color: #385449; font-size: 13px; font-weight: 600; white-space: nowrap; }
.heatmap-state { padding: 28px 0; color: #68756f; font-size: 13px; }
.heatmap-skeleton { padding-top: 22px; padding-bottom: 36px; }
.heatmap-placeholder { height: 144px; border-radius: 8px; background: #f8faf9; }
.heatmap-retry { margin-left: 8px; padding: 0; border: 0; background: transparent; color: #006241; cursor: pointer; text-decoration: underline; }
.heatmap-scroll { max-width: 100%; overflow-x: auto; padding-bottom: 4px; }
.heatmap-content { width: 100%; min-width: 900px; }
.heatmap-months, .heatmap-grid { display: grid; grid-template-columns: repeat(var(--heatmap-columns), minmax(12px, 1fr)); column-gap: 3px; }
.heatmap-months { position: relative; z-index: 2; height: 22px; color: #68756f; font-size: 11px; }
.heatmap-months span { white-space: nowrap; padding: 0 2px; background: #fff; }
.heatmap-months span:last-child:not(:first-child) { justify-self: end; }
.heatmap-grid { grid-auto-flow: column; grid-template-rows: repeat(7, auto); row-gap: 3px; }
.heatmap-cell { width: 100%; aspect-ratio: 1; max-height: 18px; padding: 0; border: 0; border-radius: 3px; background: #edf1ee; }
button.heatmap-cell { cursor: pointer; }
button.heatmap-cell:focus-visible, button.heatmap-cell.selected { outline: 2px solid #164e36; outline-offset: 2px; position: relative; z-index: 1; }
.heatmap-cell.empty { visibility: hidden; }
.heatmap-cell.level-1 { background: #c8e6d3; }
.heatmap-cell.level-2 { background: #94cfaa; }
.heatmap-cell.level-3 { background: #55ad7c; }
.heatmap-cell.level-4 { background: #147a4b; }
.heatmap-cell:not(.empty):hover { outline: 1px solid #4e7462; outline-offset: 1px; }
.heatmap-tooltip { position: fixed; z-index: 10; display: grid; gap: 3px; min-width: 154px; padding: 9px 11px; border: 1px solid #dce7e1; border-radius: 8px; background: rgba(255, 255, 255, .98); box-shadow: 0 8px 24px rgba(23, 35, 30, .14); color: #52635b; font-size: 11px; pointer-events: none; }
.heatmap-tooltip strong { color: #17231e; font-size: 12px; }
.heatmap-detail { margin-top: 18px; padding: 16px; border: 1px solid #e6eeea; border-radius: 12px; background: #f8faf9; }
.heatmap-detail-date { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; color: #17231e; font-size: 14px; font-weight: 650; }
.heatmap-detail p { color: #68756f; font-size: 11px; font-weight: 400; }
.heatmap-detail dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin: 12px 0 0; }
.heatmap-detail dt { color: #68756f; font-size: 12px; }
.heatmap-detail dd { margin: 4px 0 0; color: #17231e; font-size: 16px; font-weight: 650; font-variant-numeric: tabular-nums; }
.heatmap-detail p { margin: 12px 0 0; }
.heatmap-footer { display: flex; justify-content: flex-end; gap: 16px; margin-top: 16px; color: #68756f; font-size: 11px; }
.heatmap-legend { display: flex; align-items: center; gap: 4px; }
.heatmap-legend .heatmap-cell { width: 14px; }
@media (max-width: 639px) {
  .heatmap-card { padding: 20px 16px; }
  .heatmap-header { flex-direction: column; gap: 8px; }
}
</style>

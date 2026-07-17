import { ref, onMounted, onUnmounted } from 'vue'

export function useDebouncedWindowSize(
  delay = 200,
  onResize?: (width: number, height: number) => void
) {
  const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 0)
  const windowHeight = ref(typeof window !== 'undefined' ? window.innerHeight : 0)
  let timer: ReturnType<typeof setTimeout> | null = null

  const updateWindowSize = () => {
    windowWidth.value = window.innerWidth
    windowHeight.value = window.innerHeight
    onResize?.(windowWidth.value, windowHeight.value)
  }

  const handleResize = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      updateWindowSize()
    }, delay)
  }

  onMounted(() => {
    updateWindowSize()
    window.addEventListener('resize', handleResize)
  })

  onUnmounted(() => {
    window.removeEventListener('resize', handleResize)
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  })

  return {
    windowWidth,
    windowHeight,
  }
}

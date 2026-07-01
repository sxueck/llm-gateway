import { ref } from 'vue';
import { defineStore } from 'pinia';

const LOADING_DELAY = 200;

export const useLoadingStore = defineStore('loading', () => {
  const routeLoading = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function startRouteLoading() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      routeLoading.value = true;
    }, LOADING_DELAY);
  }

  function stopRouteLoading() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    routeLoading.value = false;
  }

  return {
    routeLoading,
    startRouteLoading,
    stopRouteLoading,
  };
});

import { ref, watch, toValue, type MaybeRefOrGetter } from 'vue';
import { modelApi } from '@/api/model';

export type ModelOption = { label: string; value: string };

/**
 * Load non-virtual models for a provider on demand. Clears the list while the
 * provider id is empty or the fetch fails so callers never show stale options.
 */
export function useProviderModels(providerId: MaybeRefOrGetter<string | undefined>) {
  const options = ref<ModelOption[]>([]);
  const loading = ref(false);

  watch(
    () => toValue(providerId),
    async (id) => {
      if (!id) {
        options.value = [];
        return;
      }
      loading.value = true;
      try {
        const response = await modelApi.getByProviderId(id);
        options.value = response.models
          .filter((m) => !m.isVirtual)
          .map((m) => ({ label: m.name, value: m.modelIdentifier }));
      } catch {
        options.value = [];
      } finally {
        loading.value = false;
      }
    },
    { immediate: true },
  );

  return { options, loading };
}

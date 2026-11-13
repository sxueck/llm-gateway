import { ref, watch, toValue, onScopeDispose, type MaybeRefOrGetter } from 'vue';
import { modelApi } from '@/api/model';

export type ModelOption = { label: string; value: string };

/**
 * Load non-virtual models for a provider on demand. Clears the list while the
 * provider id is empty or the fetch fails so callers never show stale options.
 */
export function useProviderModels(providerId: MaybeRefOrGetter<string | undefined>) {
  const options = ref<ModelOption[]>([]);
  const loading = ref(false);

  // Monotonic token: only the most recent request may write state. Bumped on
  // every provider change and on scope disposal so late responses from
  // outdated requests (or after unmount) are discarded.
  let requestEpoch = 0;

  const stop = watch(
    () => toValue(providerId),
    async (id) => {
      const epoch = ++requestEpoch;
      const isCurrent = () => epoch === requestEpoch && toValue(providerId) === id;
      if (!id) {
        options.value = [];
        loading.value = false;
        return;
      }
      loading.value = true;
      try {
        const response = await modelApi.getByProviderId(id);
        if (!isCurrent()) return;
        options.value = response.models
          .filter((m) => !m.isVirtual)
          .map((m) => ({ label: m.name, value: m.modelIdentifier }));
      } catch {
        if (!isCurrent()) return;
        options.value = [];
      } finally {
        if (isCurrent()) loading.value = false;
      }
    },
    { immediate: true },
  );

  // Stop the watcher and invalidate any in-flight request when the host
  // component unmounts, so a late response never touches refs afterwards.
  onScopeDispose(() => {
    stop();
    requestEpoch += 1;
    loading.value = false;
  });

  return { options, loading };
}

import { computed } from 'vue';
import { useVirtualKeyStore } from '@/stores/virtual-key';

interface UseVirtualKeyOptionsConfig {
  includeDisabled?: boolean;
  showKeySnippet?: boolean;
}

export function useVirtualKeyOptions(config: UseVirtualKeyOptionsConfig = {}) {
  const { includeDisabled = false, showKeySnippet = true } = config;
  const virtualKeyStore = useVirtualKeyStore();

  const virtualKeyOptions = computed(() => {
    return virtualKeyStore.virtualKeys
      .filter(vk => (includeDisabled ? true : vk.enabled))
      .map(vk => {
        const snippet = showKeySnippet
          ? ` (${vk.keyValue.substring(0, 20)}...)`
          : '';

        return {
          label: `${vk.name}${snippet}`,
          value: vk.keyValue,
        };
      });
  });

  return { virtualKeyOptions };
}

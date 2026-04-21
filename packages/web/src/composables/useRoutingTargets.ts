import { ref, readonly, watch, type Ref } from 'vue';
import type { VirtualModelTarget, RoutingConfigType } from '@/types/virtual-model';

export interface UseRoutingTargetsOptions {
  configType: Ref<RoutingConfigType>;
  /**
   * 外部传入的 targets Ref；若提供则直接操作该 Ref，否则内部新建
   */
  targets?: Ref<VirtualModelTarget[]>;
  initialTargets?: VirtualModelTarget[];
  /**
   * 切换路由类型时是否清空 targets，默认 true
   */
  clearOnTypeChange?: boolean;
  /**
   * fallback 模式下默认触发状态码
   */
  defaultFallbackStatusCodes?: number[];
  /**
   * 非 fallback 且非 loadbalance 模式下默认权重
   */
  defaultWeight?: number;
}

export function useRoutingTargets(options: UseRoutingTargetsOptions) {
  const {
    configType,
    targets: externalTargets,
    initialTargets = [],
    clearOnTypeChange = true,
    defaultFallbackStatusCodes = [],
    defaultWeight = 0.5,
  } = options;

  // 若外部提供了 targets 则直接使用，否则内部新建
  const internalTargets = ref<VirtualModelTarget[]>([...initialTargets]);
  const _targets = externalTargets ?? internalTargets;

  const weightedTypes: RoutingConfigType[] = ['loadbalance', 'hash', 'affinity'];

  function isWeighted(type: RoutingConfigType = configType.value) {
    return weightedTypes.includes(type);
  }

  function addTarget() {
    _targets.value.push({
      providerId: '',
      modelName: '',
      weight: isWeighted() ? defaultWeight : undefined,
      onStatusCodes: configType.value === 'fallback' ? [...defaultFallbackStatusCodes] : undefined,
    });
  }

  function removeTarget(index: number) {
    _targets.value.splice(index, 1);
  }

  function moveTarget(index: number, direction: -1 | 1) {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= _targets.value.length) return;
    const items = [..._targets.value];
    [items[index], items[newIndex]] = [items[newIndex], items[index]];
    _targets.value = items;
  }

  function moveTargetUp(index: number) {
    moveTarget(index, -1);
  }

  function moveTargetDown(index: number) {
    moveTarget(index, 1);
  }

  function resetTargets(type: RoutingConfigType = configType.value) {
    _targets.value = _targets.value.map(t => ({
      ...t,
      weight: isWeighted(type) ? defaultWeight : undefined,
      onStatusCodes: type === 'fallback' ? [...defaultFallbackStatusCodes] : undefined,
    }));
  }

  function clearTargets() {
    _targets.value = [];
  }

  function validateTargets(): { valid: boolean; message?: string } {
    if (_targets.value.length === 0) {
      return { valid: false, message: '请至少添加一个目标' };
    }
    const hasEmptyProvider = _targets.value.some(t => !t.providerId);
    if (hasEmptyProvider) {
      return { valid: false, message: '请为所有目标选择提供商' };
    }
    const hasEmptyModel = _targets.value.some(t => !t.modelName);
    if (hasEmptyModel) {
      return { valid: false, message: '请为所有目标选择模型' };
    }
    return { valid: true };
  }

  function getTotalWeight(): number {
    if (!isWeighted()) return 0;
    return _targets.value.reduce((sum, t) => sum + (t.weight || 0), 0);
  }

  watch(configType, (newType, oldType) => {
    if (newType === oldType) return;
    if (clearOnTypeChange) {
      clearTargets();
    } else {
      resetTargets(newType);
    }
  });

  return {
    targets: readonly(_targets) as Ref<readonly VirtualModelTarget[]>,
    addTarget,
    removeTarget,
    moveTarget,
    moveTargetUp,
    moveTargetDown,
    resetTargets,
    clearTargets,
    validateTargets,
    getTotalWeight,
  };
}

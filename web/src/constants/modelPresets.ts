// 本文件已废弃，所有模型预设现在通过 LiteLLM 预设库获取
// 保留此文件仅用于类型定义

import type { ModelAttributes } from '@/types';

export interface ModelPreset {
  pattern: RegExp;
  attributes: ModelAttributes;
  description: string;
}


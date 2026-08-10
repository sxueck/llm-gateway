import { EXPERT_ROUTING_ELIGIBLE_LABELS } from '@llm-gateway/shared';

export interface ExpertTemplate {
  label: string;
  value: string;
  description: string;
  utterances: string[];
}

const descriptions: Record<string, string> = {
  code_authoring: '实现新的代码、接口、页面或脚本。',
  code_modification: '在现有代码上进行功能性修改或重构。',
  code_repair: '定位并修复错误、异常、回归或失败的测试。',
  code_review: '评审代码、PR 或设计，识别风险并提出改进建议。',
  code_explanation: '解释代码、概念、机制或实现细节。',
  test_generation: '编写、补充或设计测试用例。',
  code_search: '在代码库中检索定义、调用关系或实现位置。',
  architecture_consultation: '提供架构、技术选型或实施方案建议。',
  dependency_management: '处理依赖选择、升级、冲突或许可证问题。',
  context_specification: '提供或调整任务所需的上下文和约束。',
  workflow_control: '控制工作流、执行步骤或任务状态。',
  general_inquiry: '处理不属于其他稳定标签的一般性问题。',
};

export const expertTemplates: ExpertTemplate[] = EXPERT_ROUTING_ELIGIBLE_LABELS.map((intent) => ({
  label: `${intent.displayName} (${intent.label})`,
  value: intent.label,
  description: descriptions[intent.label] || intent.displayName,
  utterances: [],
}));

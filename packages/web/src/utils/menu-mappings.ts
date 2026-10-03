// MainLayout 菜单的父子映射（子项 key → 分组 key），决定激活某个子项时哪个分组展开。
// 菜单项改名或删除时映射会静默失效，因此由 menu-mappings.test.ts 对照 MainLayout 校验。
export const mainMenuParentByKey: Record<string, string> = {
  providers: 'model-management',
  models: 'model-management',
  'virtual-models': 'model-management',
  'expert-routing': 'experimental-features',
  'worker-plugins': 'experimental-features',
  'cost-analysis': 'experimental-features',
  'worker-monitoring': 'monitoring',
  'operations-monitoring': 'monitoring',
  'traffic-analysis': 'monitoring',
  playground: 'tools',
  logs: 'tools',
  'api-requests': 'tools',
  'prompt-samples': 'tools',
  'node-operations': 'advanced-tools',
  'developer-settings': 'advanced-tools',
  'db-maintenance': 'advanced-tools',
};

export const generalMenuParentByKey: Record<string, string> = {
  settings: 'settings',
  'security-settings': 'settings',
  backup: 'settings',
};

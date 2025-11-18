import type { Provider } from '@/types';
import { getProviderById } from '@/constants/providers';

export interface ProviderExportData {
  version: string;
  exportTime: string;
  providers: Array<{
    id: string;
    name: string;
    description?: string;
    baseUrl: string;
    enabled: boolean;
    isPortkeySupported: boolean;
    category?: string;
    // 注意：不导出 API Key 以保护安全
  }>;
}

/**
 * 导出提供商配置
 */
export function exportProviders(providers: Provider[]): ProviderExportData {
  const exportData: ProviderExportData = {
    version: '1.0.0',
    exportTime: new Date().toISOString(),
    providers: providers.map(provider => {
      const preset = getProviderById(provider.id);
      return {
        id: provider.id,
        name: provider.name,
        description: provider.description || undefined,
        baseUrl: provider.baseUrl,
        enabled: provider.enabled,
        isPortkeySupported: !!preset,
        category: preset?.category,
      };
    }),
  };

  return exportData;
}

/**
 * 下载提供商配置文件
 */
export function downloadProvidersConfig(providers: Provider[], filename?: string) {
  const exportData = exportProviders(providers);
  const jsonString = JSON.stringify(exportData, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json' });
  
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || `providers-config-${new Date().toISOString().split('T')[0]}.json`;
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  URL.revokeObjectURL(url);
}

/**
 * 验证导入的配置文件
 */
export function validateImportData(data: any): {
  isValid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 检查基本结构
  if (!data || typeof data !== 'object') {
    errors.push('无效的配置文件格式');
    return { isValid: false, errors, warnings };
  }

  if (!data.version) {
    warnings.push('配置文件缺少版本信息');
  }

  if (!Array.isArray(data.providers)) {
    errors.push('配置文件中缺少有效的提供商列表');
    return { isValid: false, errors, warnings };
  }

  // 检查每个提供商配置
  data.providers.forEach((provider: any, index: number) => {
    const prefix = `提供商 ${index + 1}`;

    if (!provider.id || typeof provider.id !== 'string') {
      errors.push(`${prefix}: 缺少有效的 ID`);
    }

    if (!provider.name || typeof provider.name !== 'string') {
      errors.push(`${prefix}: 缺少有效的名称`);
    }

    if (!provider.baseUrl || typeof provider.baseUrl !== 'string') {
      errors.push(`${prefix}: 缺少有效的 Base URL`);
    } else {
      try {
        new URL(provider.baseUrl);
      } catch {
        errors.push(`${prefix}: Base URL 格式无效`);
      }
    }

    if (typeof provider.enabled !== 'boolean') {
      warnings.push(`${prefix}: 启用状态不是布尔值，将使用默认值`);
    }

    // 检查是否为 Portkey 支持的提供商
    const preset = getProviderById(provider.id);
    if (!preset && !provider.isPortkeySupported) {
      warnings.push(`${prefix}: "${provider.id}" 不是 Portkey 官方支持的提供商`);
    }
  });

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * 解析导入的配置文件
 */
export function parseImportFile(file: File): Promise<{
  data: ProviderExportData | null;
  validation: ReturnType<typeof validateImportData>;
}> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const data = JSON.parse(content);
        const validation = validateImportData(data);
        
        resolve({
          data: validation.isValid ? data : null,
          validation,
        });
      } catch (error) {
        resolve({
          data: null,
          validation: {
            isValid: false,
            errors: ['配置文件格式错误，请确保是有效的 JSON 文件'],
            warnings: [],
          },
        });
      }
    };

    reader.onerror = () => {
      resolve({
        data: null,
        validation: {
          isValid: false,
          errors: ['文件读取失败'],
          warnings: [],
        },
      });
    };

    reader.readAsText(file);
  });
}

/**
 * 转换导入数据为创建提供商的格式
 */
export function convertImportDataToProviders(data: ProviderExportData): Array<{
  id: string;
  name: string;
  description?: string;
  baseUrl: string;
  enabled: boolean;
  needsApiKey: boolean;
  isPortkeySupported: boolean;
  category?: string;
}> {
  return data.providers.map(provider => ({
    id: provider.id,
    name: provider.name,
    description: provider.description,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled ?? true,
    needsApiKey: true, // 导入的提供商都需要重新设置 API Key
    isPortkeySupported: provider.isPortkeySupported ?? false,
    category: provider.category,
  }));
}

/**
 * 生成配置摘要
 */
export function generateConfigSummary(data: ProviderExportData): {
  totalProviders: number;
  enabledProviders: number;
  portkeySupported: number;
  categories: Record<string, number>;
} {
  const summary = {
    totalProviders: data.providers.length,
    enabledProviders: data.providers.filter(p => p.enabled).length,
    portkeySupported: data.providers.filter(p => p.isPortkeySupported).length,
    categories: {} as Record<string, number>,
  };

  data.providers.forEach(provider => {
    if (provider.category) {
      summary.categories[provider.category] = (summary.categories[provider.category] || 0) + 1;
    }
  });

  return summary;
}

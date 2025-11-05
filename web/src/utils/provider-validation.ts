import { PROVIDER_PRESETS } from '@/constants/providers';

/**
 * 验证提供商 ID 格式
 */
export function validateProviderId(id: string): {
  isValid: boolean;
  message?: string;
} {
  // 检查是否为空
  if (!id || id.trim() === '') {
    return {
      isValid: false,
      message: '提供商 ID 不能为空',
    };
  }

  // 检查格式：只允许小写字母、数字、连字符
  const formatRegex = /^[a-z0-9-]+$/;
  if (!formatRegex.test(id)) {
    return {
      isValid: false,
      message: '提供商 ID 只能包含小写字母、数字和连字符',
    };
  }

  // 检查是否以连字符开头或结尾
  if (id.startsWith('-') || id.endsWith('-')) {
    return {
      isValid: false,
      message: '提供商 ID 不能以连字符开头或结尾',
    };
  }

  // 检查是否包含连续的连字符
  if (id.includes('--')) {
    return {
      isValid: false,
      message: '提供商 ID 不能包含连续的连字符',
    };
  }

  // 检查长度
  if (id.length < 2 || id.length > 50) {
    return {
      isValid: false,
      message: '提供商 ID 长度应在 2-50 个字符之间',
    };
  }

  return {
    isValid: true,
  };
}

/**
 * 获取提供商 ID 建议
 */
export function getProviderIdSuggestions(input: string): string[] {
  if (!input || input.length < 2) {
    return [];
  }

  const suggestions = PROVIDER_PRESETS
    .filter(p => 
      p.id.includes(input.toLowerCase()) || 
      p.name.toLowerCase().includes(input.toLowerCase())
    )
    .map(p => p.id)
    .slice(0, 5);

  return suggestions;
}

/**
 * 验证 Base URL 格式
 */
export function validateBaseUrl(url: string): {
  isValid: boolean;
  message?: string;
} {
  if (!url || url.trim() === '') {
    return {
      isValid: false,
      message: 'Base URL 不能为空',
    };
  }

  try {
    const urlObj = new URL(url);
    
    // 支持 HTTP 和 HTTPS 协议
    if (urlObj.protocol !== 'https:' && urlObj.protocol !== 'http:') {
      return {
        isValid: false,
        message: 'Base URL 必须使用 HTTP 或 HTTPS 协议',
      };
    }

    // 检查是否为有效的主机名（允许内网地址）
    if (!urlObj.hostname) {
      return {
        isValid: false,
        message: 'Base URL 必须包含有效的主机名',
      };
    }

    return {
      isValid: true,
    };
  } catch (error) {
    return {
      isValid: false,
      message: '请输入有效的 URL 格式',
    };
  }
}

/**
 * 验证 API Key 格式
 */
export function validateApiKey(apiKey: string, providerId?: string): {
  isValid: boolean;
  message?: string;
} {
  if (!apiKey || apiKey.trim() === '') {
    return {
      isValid: false,
      message: 'API Key 不能为空',
    };
  }

  // 基本长度检查
  if (apiKey.length < 10) {
    return {
      isValid: false,
      message: 'API Key 长度过短，请检查是否完整',
    };
  }

  // 根据提供商进行特定验证
  if (providerId) {
    switch (providerId) {
      case 'openai':
      case 'azure-openai':
        if (!apiKey.startsWith('sk-')) {
          return {
            isValid: false,
            message: 'OpenAI API Key 应以 "sk-" 开头',
          };
        }
        break;
      case 'anthropic':
        if (!apiKey.startsWith('sk-ant-')) {
          return {
            isValid: false,
            message: 'Anthropic API Key 应以 "sk-ant-" 开头',
          };
        }
        break;
      case 'deepseek':
        if (!apiKey.startsWith('sk-')) {
          return {
            isValid: false,
            message: 'DeepSeek API Key 应以 "sk-" 开头',
          };
        }
        break;
    }
  }

  return {
    isValid: true,
  };
}

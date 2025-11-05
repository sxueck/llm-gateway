interface ProviderConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  protocol?: 'openai' | 'anthropic' | 'google';
}

interface ProviderAdapter {
  normalizeBaseUrl(baseUrl: string): string;
  getProviderType(baseUrl: string): string;
}

function validateUrl(url: string): void {
  if (!url || typeof url !== 'string') {
    throw new Error('Invalid URL: URL must be a non-empty string');
  }

  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    throw new Error('Invalid URL: URL cannot be empty or whitespace');
  }

  try {
    const parsedUrl = new URL(trimmedUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Invalid URL: Only HTTP and HTTPS protocols are allowed');
    }
  } catch (error: any) {
    if (error.message.includes('Invalid URL')) {
      throw error;
    }
    throw new Error(`Invalid URL format: ${error.message}`);
  }
}

abstract class BaseAdapter implements ProviderAdapter {
  normalizeBaseUrl(baseUrl: string): string {
    validateUrl(baseUrl);
    const normalized = baseUrl.trim().replace(/\/+$/, '');
    return normalized;
  }

  abstract getProviderType(baseUrl: string): string;
}

class GoogleGeminiAdapter implements ProviderAdapter {
  normalizeBaseUrl(baseUrl: string): string {
    validateUrl(baseUrl);
    let normalized = baseUrl.trim();

    if (normalized.includes('generativelanguage.googleapis.com')) {
      normalized = normalized.replace(/\/+$/, '');

      if (normalized.endsWith('/v1beta/openai')) {
        return normalized;
      }

      if (normalized.endsWith('/v1beta')) {
        return normalized + '/openai';
      }

      if (!normalized.includes('/openai')) {
        return normalized + '/v1beta/openai';
      }
    }

    return normalized;
  }

  getProviderType(baseUrl: string): string {
    return 'google';
  }
}

class OpenAICompatibleAdapter extends BaseAdapter {
  getProviderType(baseUrl: string): string {
    const url = baseUrl.toLowerCase();

    if (url.includes('api.deepseek.com')) {
      return 'openai';
    }
    if (url.includes('api.openai.com')) {
      return 'openai';
    }

    return 'openai';
  }
}

class AnthropicAdapter extends BaseAdapter {
  getProviderType(baseUrl: string): string {
    return 'anthropic';
  }
}

export class ProviderAdapterFactory {
  private static readonly googleAdapter = new GoogleGeminiAdapter();
  private static readonly anthropicAdapter = new AnthropicAdapter();
  private static readonly openaiAdapter = new OpenAICompatibleAdapter();

  static getAdapter(baseUrl: string): ProviderAdapter {
    if (!baseUrl) {
      return this.openaiAdapter;
    }

    const url = baseUrl.toLowerCase();

    if (
      url.includes('generativelanguage.googleapis.com') ||
      url.includes('gemini')
    ) {
      return this.googleAdapter;
    }

    if (
      url.includes('api.anthropic.com') ||
      url.includes('anthropic')
    ) {
      return this.anthropicAdapter;
    }

    return this.openaiAdapter;
  }

  static normalizeProviderConfig(config: ProviderConfig): ProviderConfig {
    if (!config.baseUrl || config.baseUrl.trim() === '') {
      return {
        ...config,
        baseUrl: '',
        provider: config.protocol || 'openai',
        protocol: config.protocol || 'openai',
      };
    }

    const adapter = config.protocol
      ? this.getAdapterByProtocol(config.protocol)
      : this.getAdapter(config.baseUrl);
    
    return {
      ...config,
      baseUrl: adapter.normalizeBaseUrl(config.baseUrl),
      provider: config.protocol || adapter.getProviderType(config.baseUrl),
      protocol: config.protocol || adapter.getProviderType(config.baseUrl) as 'openai' | 'anthropic' | 'google',
    };
  }

  static getAdapterByProtocol(protocol: 'openai' | 'anthropic' | 'google'): ProviderAdapter {
    switch (protocol) {
      case 'google':
        return this.googleAdapter;
      case 'anthropic':
        return this.anthropicAdapter;
      case 'openai':
      default:
        return this.openaiAdapter;
    }
  }
}


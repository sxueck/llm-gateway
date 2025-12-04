interface ProviderConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  protocol?: 'openai' | 'anthropic' | 'google';
}

interface ProviderAdapter {
  normalizeBaseUrl(baseUrl: string): string;
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
}

class OpenAICompatibleAdapter extends BaseAdapter {
}

class AnthropicAdapter extends BaseAdapter {
}

export class ProviderAdapterFactory {
  private static readonly googleAdapter = new GoogleGeminiAdapter();
  private static readonly anthropicAdapter = new AnthropicAdapter();
  private static readonly openaiAdapter = new OpenAICompatibleAdapter();

  static normalizeProviderConfig(config: ProviderConfig): ProviderConfig {
    const protocol: 'openai' | 'anthropic' | 'google' = config.protocol || 'openai';

    if (!config.baseUrl || config.baseUrl.trim() === '') {
      return {
        ...config,
        baseUrl: '',
        provider: protocol,
        protocol,
      };
    }

    const adapter = this.getAdapterByProtocol(protocol);

    return {
      ...config,
      baseUrl: adapter.normalizeBaseUrl(config.baseUrl),
      provider: protocol,
      protocol,
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


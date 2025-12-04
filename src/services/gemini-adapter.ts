import { GoogleGenerativeAI, GenerativeModel, Content, Part } from '@google/generative-ai';
import { FastifyReply } from 'fastify';
import { memoryLogger } from './logger.js';
import type { ProtocolConfig } from './protocol-adapter.js';
import type { StreamTokenUsage, ThinkingBlock } from '../routes/proxy/http-client.js';
import { extractReasoningFromChoice } from '../utils/request-logger.js';
import { normalizeUsageCounts } from '../utils/usage-normalizer.js';

/**
 * Gemini 协议适配器
 * 支持 Gemini API 的原生协议调用
 */
export class GeminiAdapter {
  private clients: Map<string, GoogleGenerativeAI> = new Map();

  /**
   * 获取或创建 Gemini 客户端
   */
  private getClient(apiKey: string): GoogleGenerativeAI {
    if (!this.clients.has(apiKey)) {
      this.clients.set(apiKey, new GoogleGenerativeAI(apiKey));
    }
    return this.clients.get(apiKey)!;
  }

  /**
   * 将 OpenAI 格式的消息转换为 Gemini 格式
   */
  private convertMessagesToGemini(messages: any[]): Content[] {
    const contents: Content[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Gemini 使用 systemInstruction，在这里我们将其转为 user 消息
        // 实际使用时应该通过 systemInstruction 参数传递
        continue;
      }

      const role = msg.role === 'assistant' ? 'model' : 'user';
      const parts: Part[] = [];

      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ text: block.text });
          } else if (block.type === 'image_url') {
            // 处理图片
            const imageUrl = block.image_url?.url || block.image_url;
            if (imageUrl) {
              // Gemini 需要 base64 或 inline data
              if (imageUrl.startsWith('data:')) {
                const [mimeType, data] = imageUrl.split(',');
                parts.push({
                  inlineData: {
                    mimeType: mimeType.split(':')[1].split(';')[0],
                    data: data
                  }
                });
              }
            }
          }
        }
      }

      if (parts.length > 0) {
        contents.push({ role, parts });
      }
    }

    return contents;
  }

  /**
   * 提取系统指令
   */
  private extractSystemInstruction(messages: any[]): string | undefined {
    const systemMessages = messages.filter(m => m.role === 'system');
    if (systemMessages.length === 0) return undefined;
    
    return systemMessages.map(m => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((block: any) => block.type === 'text')
          .map((block: any) => block.text)
          .join('\n');
      }
      return '';
    }).join('\n\n');
  }

  /**
   * 将 Gemini 响应转换为 OpenAI 格式
   */
  private convertGeminiToOpenAI(response: any, model: string): any {
    const candidate = response.candidates?.[0];
    if (!candidate) {
      throw new Error('No candidates in Gemini response');
    }

    const content = candidate.content?.parts?.map((p: any) => p.text).join('') || '';
    
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content
          },
          finish_reason: candidate.finishReason?.toLowerCase() || 'stop'
        }
      ],
      usage: {
        prompt_tokens: response.usageMetadata?.promptTokenCount || 0,
        completion_tokens: response.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: response.usageMetadata?.totalTokenCount || 0
      }
    };
  }

  /**
   * 非流式聊天补全
   */
  async chatCompletion(
    config: ProtocolConfig,
    messages: any[],
    options: any,
    abortSignal?: AbortSignal
  ): Promise<any> {
    const client = this.getClient(config.apiKey);
    const systemInstruction = this.extractSystemInstruction(messages);
    const contents = this.convertMessagesToGemini(messages);

    const modelConfig: any = {
      model: config.model,
    };

    if (systemInstruction) {
      modelConfig.systemInstruction = systemInstruction;
    }

    const generativeModel = client.getGenerativeModel(modelConfig);

    const generationConfig: any = {};
    if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
    if (options.max_tokens !== undefined) generationConfig.maxOutputTokens = options.max_tokens;
    if (options.top_p !== undefined) generationConfig.topP = options.top_p;
    if (options.stop !== undefined) generationConfig.stopSequences = Array.isArray(options.stop) ? options.stop : [options.stop];

    try {
      const result = await generativeModel.generateContent({
        contents,
        generationConfig
      });

      const response = await result.response;
      return this.convertGeminiToOpenAI(response, config.model);
    } catch (error: any) {
      memoryLogger.error(`Gemini API 错误: ${error.message}`, 'GeminiAdapter');
      throw error;
    }
  }

  /**
   * 流式聊天补全
   */
  async streamChatCompletion(
    config: ProtocolConfig,
    messages: any[],
    options: any,
    reply: FastifyReply,
    abortSignal?: AbortSignal
  ): Promise<StreamTokenUsage> {
    const client = this.getClient(config.apiKey);
    const systemInstruction = this.extractSystemInstruction(messages);
    const contents = this.convertMessagesToGemini(messages);

    const modelConfig: any = {
      model: config.model,
    };

    if (systemInstruction) {
      modelConfig.systemInstruction = systemInstruction;
    }

    const generativeModel = client.getGenerativeModel(modelConfig);

    const generationConfig: any = {};
    if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
    if (options.max_tokens !== undefined) generationConfig.maxOutputTokens = options.max_tokens;
    if (options.top_p !== undefined) generationConfig.topP = options.top_p;
    if (options.stop !== undefined) generationConfig.stopSequences = Array.isArray(options.stop) ? options.stop : [options.stop];

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
    });

    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cachedTokens = 0;
    const streamChunks: string[] = [];
    let fullContent = '';
    let chunkIndex = 0;

    try {
      const result = await generativeModel.generateContentStream({
        contents,
        generationConfig
      });

      for await (const chunk of result.stream) {
        // 检查客户端是否断开连接
        if (reply.raw.destroyed || reply.raw.writableEnded) {
          memoryLogger.info('客户端已断开连接，停止流式传输', 'GeminiAdapter');
          break;
        }

        const text = chunk.text();
        if (text) {
          fullContent += text;

          // 转换为 OpenAI 流式格式
          const openaiChunk = {
            id: `chatcmpl-${Date.now()}-${chunkIndex}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: config.model,
            choices: [
              {
                index: 0,
                delta: {
                  content: text
                },
                finish_reason: null
              }
            ]
          };

          const chunkData = JSON.stringify(openaiChunk);
          const sseData = `data: ${chunkData}\n\n`;
          streamChunks.push(sseData);

          if (!reply.raw.write(sseData)) {
            await new Promise<void>((resolve) => {
              reply.raw.once('drain', resolve);
            });
          }

          chunkIndex++;
        }

        // 更新 token 统计
        if (chunk.usageMetadata) {
          promptTokens = chunk.usageMetadata.promptTokenCount || 0;
          completionTokens = chunk.usageMetadata.candidatesTokenCount || 0;
          totalTokens = chunk.usageMetadata.totalTokenCount || 0;
        }
      }

      // 发送最终 chunk
      const finalChunk = {
        id: `chatcmpl-${Date.now()}-${chunkIndex}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: config.model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens
        }
      };

      const finalData = `data: ${JSON.stringify(finalChunk)}\n\n`;
      streamChunks.push(finalData);
      reply.raw.write(finalData);

    } catch (error: any) {
      if (error.name === 'AbortError' || abortSignal?.aborted) {
        memoryLogger.info('流式请求被用户取消', 'GeminiAdapter');
      }
      throw error;
    }

    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    }

    return {
      promptTokens,
      completionTokens,
      totalTokens,
      cachedTokens,
      streamChunks
    };
  }

  /**
   * 创建嵌入（Gemini 使用不同的 API）
   */
  async createEmbedding(
    config: ProtocolConfig,
    input: string | string[],
    options: any = {},
    abortSignal?: AbortSignal
  ): Promise<any> {
    const client = this.getClient(config.apiKey);
    const model = client.getGenerativeModel({ model: config.model });

    const inputs = Array.isArray(input) ? input : [input];
    const embeddings: number[][] = [];

    try {
      for (const text of inputs) {
        const result = await model.embedContent(text);
        embeddings.push(result.embedding.values);
      }

      return {
        object: 'list',
        data: embeddings.map((embedding, index) => ({
          object: 'embedding',
          embedding,
          index
        })),
        model: config.model,
        usage: {
          prompt_tokens: inputs.join('').length / 4, // 粗略估算
          total_tokens: inputs.join('').length / 4
        }
      };
    } catch (error: any) {
      memoryLogger.error(`Gemini Embedding 错误: ${error.message}`, 'GeminiAdapter');
      throw error;
    }
  }
}
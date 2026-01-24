
import { ExpertRoutingConfig } from '../../../types/index.js';
import type { ExpertTarget } from '../../../types/expert-routing.js';
import { RoutingSignal, RouteDecision } from '../types.js';
import { resolveClassifierModel } from '../resolve.js';
import { memoryLogger } from '../../logger.js';
import { decryptApiKey } from '../../../utils/crypto.js';
import { buildChatCompletionsEndpoint } from '../../../utils/api-endpoint-builder.js';

const DEFAULT_CLASSIFICATION_TIMEOUT = 10000;
const DEFAULT_MAX_TOKENS = 512;

export class LLMJudge {
  static async decide(
    signal: RoutingSignal,
    classifierConfig: ExpertRoutingConfig['classifier'],
    experts?: ExpertTarget[]
  ): Promise<RouteDecision> {
    const startTime = Date.now();

    // 1. Prepare Prompt
    let userPrompt = signal.intentText;
    
    // Apply ignored tags filter
    if (classifierConfig.ignored_tags && classifierConfig.ignored_tags.length > 0) {
      userPrompt = this.filterIgnoredTags(userPrompt, classifierConfig.ignored_tags);
    }

    // Process template
    let systemMessage = '';
    let userMessageContent = userPrompt;

    if (classifierConfig.system_prompt) {
        systemMessage = classifierConfig.system_prompt;
        // If system_prompt is provided explicitly, we assume prompt_template is just for user message or empty
        // We still check prompt_template for user_prompt markers just in case, but system message comes from system_prompt
        const processed = this.processPromptTemplate(
            classifierConfig.prompt_template || '{{USER_PROMPT}}',
            userPrompt
        );
        userMessageContent = processed.userMessageContent;
    } else {
        const processed = this.processPromptTemplate(
            classifierConfig.prompt_template,
            userPrompt
        );
        systemMessage = processed.systemMessage;
        userMessageContent = processed.userMessageContent;
    }

    // Combine with history
    const finalUserMessage = signal.historyHint
      ? `${signal.historyHint}\n\n---\nLatest User Prompt:\n${userMessageContent}`
      : userMessageContent;

    const systemMessageWithCriteria = this.buildSystemPrompt(systemMessage, experts);

    const messages = [
        { role: 'system', content: systemMessageWithCriteria },
        { role: 'user', content: finalUserMessage }
    ];

    // 2. Resolve Model
    const resolvedModel = await resolveClassifierModel(classifierConfig);
    const { provider, model } = resolvedModel;

    // 3. Build Request
    const apiKey = decryptApiKey(provider.api_key);
    const endpoint = buildChatCompletionsEndpoint(provider.base_url);

    const requestBody: any = {
        model,
        messages,
        temperature: classifierConfig.temperature ?? 0.0,
        max_tokens: classifierConfig.max_tokens || DEFAULT_MAX_TOKENS
    };

    if (classifierConfig.enable_structured_output) {
        requestBody.response_format = { type: 'json_object' };
        // We ensure JSON keyword is in the prompt in buildSystemPrompt
    }

    // 4. Call API
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(classifierConfig.timeout || DEFAULT_CLASSIFICATION_TIMEOUT)
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => response.statusText);
            throw new Error(`HTTP ${response.status} - ${errorText.substring(0, 200)}`);
        }

        const result: any = await response.json();
        const content = result.choices?.[0]?.message?.content?.trim();

        if (!content) {
            throw new Error('Empty response from classifier');
        }

        // 5. Parse Result
        let category: string;

        try {
             // Try to parse JSON if structured or if it looks like JSON
             const cleaned = this.cleanMarkdownCodeBlock(content);
             const json = JSON.parse(this.normalizeJsonQuotes(cleaned));
             category = json.type || json.category;
             
             if (!category) throw new Error('Missing "type" or "category" field');
        } catch (e) {
            // Fallback: if not valid JSON, treat whole content as category if short
            // But existing logic enforced JSON.
            // If enable_structured_output is false, maybe it returns just the category name?
            // The existing prompt templates usually ask for JSON. 
            // We'll assume the prompt asks for JSON or simple text.
            // If parse fails:
             if (!classifierConfig.enable_structured_output && content.length < 50 && !content.includes('{')) {
                category = content;
            } else {
                // Try relaxed parsing for common mistakes (like unquoted keys)
                try {
                    // Try parsing with Function constructor (like eval but slightly safer scope)
                    // This can handle { category: "foo" } which JSON.parse fails on
                    // eslint-disable-next-line no-new-func
                    const cleanedContent = this.cleanMarkdownCodeBlock(content);
                    const looseJson = new Function(`return ${cleanedContent}`)();
                    if (looseJson && (looseJson.category || looseJson.type)) {
                         category = looseJson.type || looseJson.category;
                    } else {
                        throw new Error('Invalid structure');
                    }
                } catch {
                     throw new Error(`Failed to parse classification result: ${content.substring(0, 100)}...`);
                }
            }
        }

        return {
            category,
            confidence: 1.0, // Placeholder
            source: 'l3_llm',
            metadata: {
                latencyMs: Date.now() - startTime,
                classifierModel: `${provider.name}/${model}`,
                rawResponse: result,
            }
        };

    } catch (e: any) {
        memoryLogger.error(`LLM Judge execution failed: ${e.message}`, 'ExpertRouter');
        throw e;
    }
  }

  private static buildSystemPrompt(baseSystemMessage: string, experts?: ExpertTarget[]): string {
    if (!experts || experts.length === 0) return baseSystemMessage;

    const sections: string[] = [];
    
    // 1. Base Identity (if not already provided in base message)
    if (!baseSystemMessage) {
        sections.push("You are an intelligent router for an LLM gateway system. Your task is to analyze the user's request and route it to the most suitable expert model based on their specific capabilities and boundaries.");
    } else {
        sections.push(baseSystemMessage.trim());
    }

    // 2. Task Definition
    sections.push(`
### Task
Analyze the user request and classify it into ONE of the available expert categories.
Select the expert whose capabilities and boundaries best match the intent and complexity of the request.
`);

    // 3. Expert Definitions (Dynamic Injection)
    sections.push('### Available Experts & Boundaries');
    
    experts.forEach((expert, index) => {
        const category = (expert.category || '').trim();
        if (!category) return;

        // Use system_prompt as primary boundary definition, fallback to description
        const boundary = (expert.system_prompt || expert.description || '').trim();
        const boundaryText = boundary ? boundary : "General purpose handling for this category.";
        
        sections.push(`
${index + 1}. Category: "${category}"
   Boundary/Capabilities: ${boundaryText}
`);
    });

    // 4. Output Format (Strict JSON)
    sections.push(`
### Output Format
You must return a strictly valid JSON object. Do not add any markdown formatting or explanation outside the JSON.
Format:
{
  "category": "The exact category name from the list above"
}

### Fallback Rules
- If the request exactly matches an expert's boundary, choose that expert.
- If the request is ambiguous but leans towards a specific domain, choose the relevant expert.
- If the request is completely outside all expert boundaries, use "fallback" (if available) or the most general expert.
`);

    return sections.join('\n').trim();
  }

  private static cleanMarkdownCodeBlock(content: string): string {
    let cleaned = content.trim();
    const jsonBlockPattern = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;
    const match = cleaned.match(jsonBlockPattern);
    if (match) {
      cleaned = match[1].trim();
    }
    return cleaned;
  }

  private static normalizeJsonQuotes(content: string): string {
    // Basic fix for single quotes in JSON (risky but matches existing logic)
    return content.replace(/'/g, '"');
  }

  private static filterIgnoredTags(text: string, ignoredTags: string[]): string {
    let filteredText = text;
    for (const tag of ignoredTags) {
      const tagName = tag.trim();
      if (!tagName) continue;
      const openTag = `<${tagName}>`;
      const closeTag = `</${tagName}>`;
      // Escape regex chars
      const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`${escapeRegex(openTag)}[\\s\\S]*?${escapeRegex(closeTag)}`, 'g');
      filteredText = filteredText.replace(regex, '').trim();
    }
    return filteredText.trim();
  }

  private static processPromptTemplate(promptTemplate: string, userPrompt: string): {
    systemMessage: string;
    userMessageContent: string;
  } {
    const userPromptMarkers = [
      '---\nUser Prompt:\n{{USER_PROMPT}}\n---',
      '---\nUser Prompt:\n{{user_prompt}}\n---',
      '{{USER_PROMPT}}',
      '{{user_prompt}}'
    ];

    for (const marker of userPromptMarkers) {
      if (promptTemplate.includes(marker)) {
        const parts = promptTemplate.split(marker);
        if (parts.length === 2) {
            return {
                systemMessage: parts[0].trim(),
                userMessageContent: userPrompt
            };
        }
      }
    }

    return {
      systemMessage: promptTemplate.trim(),
      userMessageContent: userPrompt
    };
  }
}

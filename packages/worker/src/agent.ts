import { extractJson, lightValidateResult } from './json-output.js';
import { Reporter } from './reporter.js';
import {
  Budget,
  TOOL_DEFINITIONS,
  TOOL_IMPLEMENTATIONS,
  ToolError,
  createToolContext,
} from './tools.js';
import type { WorkerPluginManifest } from '@llm-gateway/shared';

export interface WorkerRunConfig {
  runId: string;
  query: string;
  modelProfile: string;
  manifest: WorkerPluginManifest;
  promptMd: string;
  outputSchemaJson: string;
  workspaceRoot: string;
  baseUrl: string;
  serviceToken: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface WorkerRunStats {
  turns: number;
  toolCalls: number;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

const SUBMIT_TOOL_DEF = {
  type: 'function',
  function: {
    name: 'submit_result',
    description:
      'Submit the final structured search result as JSON. Call this exactly once when the search is done.',
    parameters: {
      type: 'object',
      properties: {
        result: { type: 'object', description: 'The structured result JSON' },
      },
      required: ['result'],
      additionalProperties: false,
    },
  },
} as const;

export async function runSearchAgent(config: WorkerRunConfig): Promise<void> {
  const reporter = new Reporter(config.baseUrl, config.runId, config.serviceToken, config.fetchImpl);
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const exec = config.manifest.execution_policy;
  const deadline = now() + exec.timeout_seconds * 1000 - 5_000;

  const budget = new Budget(exec.max_files_read, exec.max_total_read_lines);
  const toolCtx = createToolContext(
    config.workspaceRoot,
    config.manifest.workspace_policy.exclude_globs,
    budget,
    deadline,
  );

  const allowedTools = config.manifest.tool_policy.allow
    .filter((name) => name in TOOL_IMPLEMENTATIONS)
    .map((name) => TOOL_DEFINITIONS.find((t) => t.function.name === name))
    .filter((t): t is (typeof TOOL_DEFINITIONS)[number] => t !== undefined);

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `${config.promptMd}\n\n# Output schema\n\nYour submit_result.result must validate against this JSON Schema:\n\n${config.outputSchemaJson}`,
    },
    { role: 'user', content: config.query },
  ];

  let repairAttempted = false;
  const stats: WorkerRunStats = { turns: 0, toolCalls: 0 };

  // Convergence enforcement: discovery tools are hard-disabled in the final quarter of
  // the turn budget so late-turn wandering cannot consume the remaining budget.
  const DISCOVERY_TOOLS = new Set(['grep_search', 'glob_files', 'list_directory']);
  const convergeTurn = Math.max(2, Math.ceil(exec.max_turns * 0.75));
  let convergeNudged = false;
  const rejectDiscovery = () =>
    `error: discovery tools are disabled from turn ${convergeTurn} (turn budget: ${exec.max_turns}); converge now: read narrow windows with read_file or call submit_result`;
  interface DiscoveryCall { id: string; function: { name: string } }
  const isDiscoveryCall = (call: DiscoveryCall, currentTurn: number) =>
    currentTurn >= convergeTurn && DISCOVERY_TOOLS.has(call.function.name);

  const failRun = async (errorCode: string, errorMessage: string) => {
    await reporter.report({
      kind: 'failed',
      error_code: errorCode,
      error_message: errorMessage,
      usage: { turns: stats.turns, tool_calls: stats.toolCalls },
    });
  };

  for (let turn = 1; turn <= exec.max_turns; turn++) {
    if (now() > deadline) {
      await failRun('timeout', 'worker deadline exceeded before model call');
      return;
    }
    stats.turns = turn;

    if (turn === convergeTurn && !convergeNudged) {
      convergeNudged = true;
      messages.push({
        role: 'user',
        content: `Convergence phase: ${exec.max_turns - turn + 1} turn(s) remain. Discovery tools (grep_search, glob_files, list_directory) are now disabled. Read only the candidate windows you already have and submit_result.`,
      });
    }

    const choice = await callModel(fetchImpl, config, messages, [...allowedTools, SUBMIT_TOOL_DEF], turn, deadline);
    if (choice === null) {
      await failRun('model_call_failed', 'no completion choice returned');
      return;
    }

    const assistantMessage = choice.message as ChatMessage;
    messages.push(assistantMessage);

    const toolCalls = assistantMessage.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // 模型直接回复文本：尝试提取结果，否则引导其调用 submit_result
      const text = assistantMessage.content ?? '';
      if (text.trim().length > 0) {
        const extracted = extractJson(text);
        if (extracted.ok) {
          const errors = lightValidateResult(extracted.value);
          if (errors.length === 0) {
            await submitValidated(reporter, config, extracted.value, stats);
            return;
          }
        }
      }
      messages.push({
        role: 'user',
        content: 'Call the submit_result tool with the final JSON result. Do not reply with plain text.',
      });
      continue;
    }

    // 检索轮不含 submit_result 时，同一轮工具调用并发执行；最终提交保留原有串行验证路径。
    if (!toolCalls.some((call) => call.function.name === 'submit_result')) {
      const limit = config.manifest.tool_policy.max_parallel_calls;
      const accepted = toolCalls.slice(0, limit);
      const overflow = toolCalls.slice(limit);
      const results = await Promise.all(
        accepted.map(async (call) => {
          if (isDiscoveryCall(call, turn)) {
            stats.toolCalls++;
            return { id: call.id, output: rejectDiscovery() };
          }
          const impl = TOOL_IMPLEMENTATIONS[call.function.name];
          stats.toolCalls++;
          if (!impl || !config.manifest.tool_policy.allow.includes(call.function.name)) {
            return { id: call.id, output: `error: tool "${call.function.name}" is not allowed by plugin tool policy` };
          }
          if (now() > deadline) return { id: call.id, output: 'error: run deadline exceeded' };
          await reporter.event('tool.started', { tool: call.function.name });
          let output: string;
          try {
            output = await impl(toolCtx, safeParseParams(call.function.arguments));
          } catch (e) {
            output = e instanceof ToolError ? `error: ${e.message}` : `error: ${e instanceof Error ? e.message : String(e)}`;
          }
          await reporter.event('tool.completed', { tool: call.function.name, bytes: output.length });
          return { id: call.id, output };
        }),
      );
      for (const result of results) messages.push(toolResult(result.id, result.output));
      for (const call of overflow) {
        stats.toolCalls++;
        messages.push(toolResult(call.id, `error: max_parallel_calls is ${limit}`));
      }
      continue;
    }

    for (const call of toolCalls) {
      if (call.function.name === 'submit_result') {
        const extracted = extractJson(call.function.arguments);
        let value: unknown = null;
        let parseError = '';
        if (extracted.ok && extracted.value && typeof extracted.value === 'object' && 'result' in (extracted.value as Record<string, unknown>)) {
          value = (extracted.value as Record<string, unknown>).result;
        } else if (extracted.ok) {
          value = extracted.value;
        } else {
          parseError = extracted.error;
        }

        if (value !== null) {
          const errors = lightValidateResult(value);
          if (errors.length === 0) {
            messages.push(toolResult(call.id, 'accepted'));
            await submitValidated(reporter, config, value, stats);
            return;
          }
          if (!repairAttempted) {
            repairAttempted = true;
            messages.push(
              toolResult(
                call.id,
                `rejected: ${errors.join('; ')}. Return a corrected result via submit_result.`,
              ),
            );
            continue;
          }
          await failRun('output_validation_failed', `result failed validation: ${errors.join('; ')}`);
          return;
        }
        if (!repairAttempted) {
          repairAttempted = true;
          messages.push(toolResult(call.id, `rejected: ${parseError}. Return corrected JSON via submit_result.`));
          continue;
        }
        await failRun('output_validation_failed', `submit_result arguments not parseable: ${parseError}`);
        return;
      }

      // 普通工具调用：白名单 + 预算 + 截断
      if (isDiscoveryCall(call, turn)) {
        stats.toolCalls++;
        messages.push(toolResult(call.id, rejectDiscovery()));
        continue;
      }
      const impl = TOOL_IMPLEMENTATIONS[call.function.name];
      if (!impl || !config.manifest.tool_policy.allow.includes(call.function.name)) {
        stats.toolCalls++;
        messages.push(
          toolResult(call.id, `error: tool "${call.function.name}" is not allowed by plugin tool policy`),
        );
        continue;
      }
      stats.toolCalls++;
      if (now() > deadline) {
        messages.push(toolResult(call.id, 'error: run deadline exceeded'));
        continue;
      }
      await reporter.event('tool.started', { tool: call.function.name });
      let output: string;
      try {
        const params = safeParseParams(call.function.arguments);
        output = await impl(toolCtx, params);
      } catch (e) {
        output = e instanceof ToolError ? `error: ${e.message}` : `error: ${e instanceof Error ? e.message : String(e)}`;
      }
      await reporter.event('tool.completed', { tool: call.function.name, bytes: output.length });
      messages.push(toolResult(call.id, output));
    }
  }

  await reporter.report({
    kind: 'budget_exceeded',
    error_message: `turn budget exhausted (${exec.max_turns} turns) without a valid result`,
    usage: { turns: stats.turns, tool_calls: stats.toolCalls },
  });
}

async function submitValidated(
  reporter: Reporter,
  config: WorkerRunConfig,
  result: unknown,
  stats: WorkerRunStats,
): Promise<void> {
  const payload = { ...(result as Record<string, unknown>) };
  payload.run_id = config.runId;
  await reporter.report({
    kind: 'completed',
    result: payload,
    usage: { turns: stats.turns, tool_calls: stats.toolCalls },
  });
}

function toolResult(id: string, content: string): ChatMessage {
  return { role: 'tool', tool_call_id: id, content };
}

function safeParseParams(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function callModel(
  fetchImpl: typeof fetch,
  config: WorkerRunConfig,
  messages: ChatMessage[],
  tools: unknown[],
  turn: number,
  deadline: number,
): Promise<{ message: ChatMessage } | null> {
  const remaining = Math.max(1000, deadline - Date.now());
  const res = await fetchImpl(`${config.baseUrl}/api/internal/agent/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-service-token': config.serviceToken,
    },
    body: JSON.stringify({
      run_id: config.runId,
      model_profile: config.modelProfile,
      turn,
      messages,
      tools,
      max_tokens: config.manifest.execution_policy.max_result_tokens,
    }),
    signal: AbortSignal.timeout(remaining),
  });
  if (!res.ok) {
    throw new Error(`model call failed: ${res.status}`);
  }
  const body = (await res.json()) as { choices?: { message: ChatMessage }[] };
  const choice = body?.choices?.[0];
  return choice ?? null;
}

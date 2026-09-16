import { readFile } from 'fs/promises';
import { runSearchAgent } from './agent.js';
import { Reporter } from './reporter.js';
import type { WorkerPluginManifest } from '@llm-gateway/shared';

interface PluginFile {
  run_id: string;
  query: string;
  model_profile: string;
  plugin: {
    id: string;
    version: string;
    digest: string;
    manifest: WorkerPluginManifest;
    files: Record<string, string>;
  };
}

async function main(): Promise<void> {
  const pluginFile = process.env.AGENT_PLUGIN_FILE;
  const runId = process.env.AGENT_RUN_ID;
  const baseUrl = process.env.AGENT_GATEWAY_INTERNAL_URL;
  const token = process.env.AGENT_SERVICE_TOKEN;
  const workspaceRoot = process.env.AGENT_WORKSPACE_ROOT || '/workspace/repo';

  if (!pluginFile || !runId || !baseUrl || !token) {
    console.error('missing required env: AGENT_PLUGIN_FILE/AGENT_RUN_ID/AGENT_GATEWAY_INTERNAL_URL/AGENT_SERVICE_TOKEN');
    process.exit(2);
  }

  let config: PluginFile;
  try {
    config = JSON.parse(await readFile(pluginFile, 'utf8')) as PluginFile;
  } catch {
    console.error(`cannot read plugin config ${pluginFile}`);
    process.exit(2);
  }

  if (config.plugin.manifest.id !== 'com.llm-gateway.code-search' && !config.plugin.manifest.id.startsWith('com.llm-gateway.')) {
    throw new Error(`untrusted plugin id: ${config.plugin.manifest.id}`);
  }

  try {
    await runSearchAgent({
      runId,
      query: config.query,
      modelProfile: config.model_profile,
      manifest: config.plugin.manifest,
      promptMd: config.plugin.files['prompt.md'] ?? '',
      outputSchemaJson: config.plugin.files['output.schema.json'] ?? '{}',
      workspaceRoot,
      baseUrl,
      serviceToken: token,
    });
    process.exit(0);
  } catch (e) {
    const reporter = new Reporter(baseUrl, runId, token);
    try {
      await reporter.report({
        kind: 'failed',
        error_code: 'worker_internal_error',
        error_message: e instanceof Error ? e.message : String(e),
        usage: { turns: 0, tool_calls: 0 },
      });
    } catch {
      // scheduler 会以 worker_exited_without_result 兜底
    }
    console.error(e);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

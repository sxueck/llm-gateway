import { createHash } from "crypto";
import {
  workerPluginManifestSchema,
  isSafeBundleFileRef,
  WORKER_TOOL_IDS,
  PLUGIN_BUNDLE_FILES,
  type WorkerPluginManifest,
} from "@llm-gateway/shared";

export interface PluginBundle {
  manifest: WorkerPluginManifest;
  files: Record<string, string>;
}

export interface ResolvedPlugin extends PluginBundle {
  digest: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function computeBundleDigest(bundle: PluginBundle): string {
  const canonical = canonicalJson({
    manifest: bundle.manifest,
    files: bundle.files,
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function validatePluginBundle(bundle: PluginBundle): string[] {
  const errors: string[] = [];

  const parsed = workerPluginManifestSchema.safeParse(bundle.manifest);
  if (!parsed.success) {
    return parsed.error.issues.map(
      (i) => `manifest: ${i.path.join(".") || "<root>"} ${i.message}`,
    );
  }
  const manifest = parsed.data;

  for (const [field, ref] of [
    ["role.system_prompt", manifest.role.system_prompt],
    ["role.input_schema", manifest.role.input_schema],
    ["role.output_schema", manifest.role.output_schema],
  ] as const) {
    if (!isSafeBundleFileRef(ref)) {
      errors.push(`${field}: unsafe or unknown bundle file reference "${ref}"`);
    } else {
      const name = ref.slice(2);
      if (!bundle.files[name])
        errors.push(`${field}: referenced file "${name}" missing from bundle`);
    }
  }

  const extraFiles = Object.keys(bundle.files).filter(
    (name) => !(PLUGIN_BUNDLE_FILES as readonly string[]).includes(name),
  );
  if (extraFiles.length > 0) {
    errors.push(
      `bundle contains files outside the allowed set: ${extraFiles.join(", ")}`,
    );
  }

  const unknownTools = manifest.tool_policy.allow.filter(
    (t) => !(WORKER_TOOL_IDS as readonly string[]).includes(t),
  );
  if (unknownTools.length > 0) {
    errors.push(
      `tool_policy.allow contains tools not offered by the platform: ${unknownTools.join(", ")}`,
    );
  }

  for (const root of manifest.workspace_policy.allowed_roots) {
    if (!root.startsWith("/workspace/")) {
      errors.push(
        `workspace_policy.allowed_roots entry "${root}" escapes the platform workspace root`,
      );
    }
  }

  const outputSchema = parseJsonMember(bundle.files["output.schema.json"]);
  const required = outputSchema?.required;
  for (const field of ["status", "summary", "files"]) {
    if (!Array.isArray(required) || !required.includes(field)) {
      errors.push(`output schema must require "${field}"`);
    }
  }
  const fileItemRequired = outputSchema?.properties?.files?.items?.required;
  for (const field of ["path", "start_line", "end_line", "reason"]) {
    if (!Array.isArray(fileItemRequired) || !fileItemRequired.includes(field)) {
      errors.push(`output schema file items must require "${field}"`);
    }
  }

  return errors;
}

function parseJsonMember(text: string | undefined): any {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

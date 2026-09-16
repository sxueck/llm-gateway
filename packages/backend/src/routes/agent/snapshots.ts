import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  SNAPSHOT_MAX_FILE_BYTES,
  createSnapshotRequestSchema,
} from '@llm-gateway/shared';
import { authenticateVirtualKey, extractVirtualKeyAuthHeader } from '../proxy/auth.js';
import type { VirtualKeyAuthResult } from '../proxy/auth.js';
import {
  SnapshotError,
  createSnapshot,
  deleteSnapshot,
  finalizeSnapshot,
  getOwnedSnapshot,
  putObject,
  readManifest,
} from '../../agent/snapshot/snapshot.service.js';

const SNAPSHOT_ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  forbidden: 403,
  invalid_state: 409,
  expired: 410,
  invalid_manifest: 400,
  unknown_file: 400,
  hash_mismatch: 400,
  incomplete: 400,
};

function sendSnapshotError(reply: FastifyReply, e: unknown) {
  if (e instanceof SnapshotError) {
    const status = SNAPSHOT_ERROR_STATUS[e.opError.code] ?? 400;
    return reply.code(status).send({
      error: {
        message: e.opError.message,
        type: 'invalid_request_error',
        param: null,
        code: e.opError.code,
      },
    });
  }
  throw e;
}

async function requireVirtualKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<VirtualKeyAuthResult | null> {
  const auth = await authenticateVirtualKey(extractVirtualKeyAuthHeader(request.headers));
  if ('error' in auth) {
    reply.code(auth.error.code).send(auth.error.body);
    return null;
  }
  return auth;
}

const finalizeBodySchema = z.object({}).strict().optional();

export async function agentSnapshotRoutes(fastify: FastifyInstance) {
  // 单文件最大 10MB + GCM 封装开销
  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: SNAPSHOT_MAX_FILE_BYTES + 1024 },
    (_req, body, done) => done(null, body),
  );

  fastify.post('/', {
    bodyLimit: 32 * 1024 * 1024,
    handler: async (request, reply) => {
      const auth = await requireVirtualKey(request, reply);
      if (!auth) return reply;
      const parsed = createSnapshotRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
            type: 'invalid_request_error',
            param: null,
            code: 'invalid_request',
          },
        });
      }
      try {
        const row = await createSnapshot({ virtualKeyId: auth.virtualKey.id }, parsed.data);
        return reply.code(201).send({
          snapshot_id: row.id,
          status: row.status,
          file_count: row.file_count,
          total_size: row.total_size,
          expires_at: row.expires_at,
          object_upload_path_template: `/api/agent/snapshots/${row.id}/objects/{file_path}`,
          finalize_url: `/api/agent/snapshots/${row.id}/finalize`,
        });
      } catch (e) {
        return sendSnapshotError(reply, e);
      }
    },
  });

  fastify.put('/:id/objects/*', {
    bodyLimit: SNAPSHOT_MAX_FILE_BYTES + 1024,
    handler: async (request, reply) => {
      const auth = await requireVirtualKey(request, reply);
      if (!auth) return reply;
      const params = request.params as { id: string; '*': string };
      const id = params.id;
      const relPath = decodeURIComponent(params['*']);
      if (!id || !relPath) {
        return reply.code(400).send({
          error: { message: 'expected /:id/objects/<path>', type: 'invalid_request_error', param: null, code: 'invalid_request' },
        });
      }
      if (!Buffer.isBuffer(request.body)) {
        return reply.code(415).send({
          error: { message: 'body must be application/octet-stream', type: 'invalid_request_error', param: null, code: 'unsupported_media_type' },
        });
      }
      try {
        await putObject(id, { virtualKeyId: auth.virtualKey.id }, relPath, request.body);
        return reply.code(204).send();
      } catch (e) {
        return sendSnapshotError(reply, e);
      }
    },
  });

  fastify.post('/:id/finalize', async (request, reply) => {
    const auth = await requireVirtualKey(request, reply);
    if (!auth) return reply;
    const { id } = request.params as { id: string };
    const bodyCheck = finalizeBodySchema.safeParse(request.body ?? {});
    if (!bodyCheck.success) {
      return reply.code(400).send({
        error: { message: 'finalize takes no body', type: 'invalid_request_error', param: null, code: 'invalid_request' },
      });
    }
    try {
      const row = await finalizeSnapshot(id, { virtualKeyId: auth.virtualKey.id });
      return {
        snapshot_id: row.id,
        status: row.status,
        file_count: row.file_count,
        total_size: row.total_size,
        expires_at: row.expires_at,
      };
    } catch (e) {
      return sendSnapshotError(reply, e);
    }
  });

  fastify.get('/:id', async (request, reply) => {
    const auth = await requireVirtualKey(request, reply);
    if (!auth) return reply;
    const { id } = request.params as { id: string };
    try {
      const row = await getOwnedSnapshot(id, { virtualKeyId: auth.virtualKey.id });
      const manifest = await readManifest(row);
      return {
        snapshot_id: row.id,
        status: row.status,
        display_name: row.display_name,
        head_commit: row.head_commit,
        file_count: row.file_count,
        total_size: row.total_size,
        excluded: manifest.excluded,
        created_at: row.created_at,
        expires_at: row.expires_at,
      };
    } catch (e) {
      return sendSnapshotError(reply, e);
    }
  });

  fastify.delete('/:id', async (request, reply) => {
    const auth = await requireVirtualKey(request, reply);
    if (!auth) return reply;
    const { id } = request.params as { id: string };
    try {
      await deleteSnapshot(id, { virtualKeyId: auth.virtualKey.id });
      return reply.code(204).send();
    } catch (e) {
      return sendSnapshotError(reply, e);
    }
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { promptSampleDb } from '../db/index.js';

const listQuerySchema = z.object({
  virtualKeyId: z.string().optional(),
  startTime: z.coerce.number().int().optional(),
  endTime: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

const cleanQuerySchema = z.object({
  daysToKeep: z.coerce.number().int().min(1).max(3650).default(30),
});

function escapeCsv(value: string | number): string {
  let text = String(value);
  // Prevent spreadsheet formula evaluation when user-provided prompts are opened in Excel-like tools.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function promptSampleRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/', async (request) => {
    const query = listQuerySchema.parse(request.query);
    const result = await promptSampleDb.getAll(query);
    const page = query.page || 1;
    const pageSize = query.pageSize || 20;
    return {
      data: result.data,
      total: result.total,
      page,
      pageSize,
      totalPages: Math.ceil(result.total / pageSize),
    };
  });

  fastify.get('/export', async (request, reply) => {
    const query = listQuerySchema.parse(request.query);
    const samples = await promptSampleDb.getForExport(query);
    const rows = [
      ['id', 'virtual_key_id', 'model', 'protocol', 'prompt_tokens', 'intent_truncated', 'created_at', 'intent_text'],
      ...samples.map(sample => [
        sample.id,
        sample.virtual_key_id,
        sample.model,
        sample.protocol,
        sample.prompt_tokens,
        sample.intent_truncated,
        sample.created_at,
        sample.intent_text,
      ]),
    ];
    const csv = `\uFEFF${rows.map(row => row.map(escapeCsv).join(',')).join('\r\n')}`;
    reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="prompt-samples.csv"')
      .send(csv);
  });

  fastify.delete('/clean', async (request) => {
    const { daysToKeep } = cleanQuerySchema.parse(request.query);
    const deletedCount = await promptSampleDb.cleanOldRecords(daysToKeep);
    return {
      success: true,
      deletedCount,
      message: `已删除 ${deletedCount} 条超过 ${daysToKeep} 天的 Prompt 样本`,
    };
  });

  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await promptSampleDb.deleteById(id);
    if (!deleted) {
      return reply.code(404).send({ error: 'Prompt 样本不存在' });
    }
    return { success: true };
  });
}

import { FastifyInstance } from 'fastify';
import { resolve, dirname, basename, normalize } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, statSync, createReadStream } from 'fs';
import { memoryLogger } from '../services/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ALLOWED_BINARIES = [
  'llm-gateway-agent-linux-amd64',
];

export async function downloadsRoutes(fastify: FastifyInstance) {
  fastify.get('/:filename', async (request, reply) => {
    const { filename } = request.params as { filename: string };

    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      memoryLogger.warn(`非法文件名: ${filename}`, 'Downloads');
      return reply.code(400).send({
        success: false,
        message: '非法文件名',
      });
    }

    const normalizedFilename = basename(normalize(filename));

    if (!ALLOWED_BINARIES.includes(normalizedFilename)) {
      memoryLogger.warn(`不允许下载的文件: ${normalizedFilename}`, 'Downloads');
      return reply.code(403).send({
        success: false,
        message: '不允许下载此文件',
      });
    }

    const agentDir = resolve(__dirname, '..', '..', 'agent');
    const filePath = resolve(agentDir, normalizedFilename);

    if (!filePath.startsWith(agentDir + '/') && filePath !== agentDir) {
      memoryLogger.warn(`路径遍历尝试: ${filename}`, 'Downloads');
      return reply.code(403).send({
        success: false,
        message: '禁止访问',
      });
    }

    if (!existsSync(filePath)) {
      memoryLogger.warn(`下载文件不存在: ${normalizedFilename}`, 'Downloads');
      return reply.code(404).send({
        success: false,
        message: '文件不存在',
      });
    }

    const stats = statSync(filePath);
    if (!stats.isFile()) {
      memoryLogger.warn(`尝试下载非文件: ${normalizedFilename}`, 'Downloads');
      return reply.code(403).send({
        success: false,
        message: '禁止访问',
      });
    }

    memoryLogger.info(`下载文件: ${normalizedFilename}`, 'Downloads');

    const stream = createReadStream(filePath);

    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${normalizedFilename}"`);
    reply.header('Content-Length', stats.size);

    return reply.send(stream);
  });
}


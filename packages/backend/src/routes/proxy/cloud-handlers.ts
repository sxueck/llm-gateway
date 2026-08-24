import { FastifyReply, FastifyRequest } from 'fastify';
import { memoryLogger } from '../../services/logger.js';
import { upstreamFetch } from '../../utils/upstream-fetch.js';

const MODEL_ATTRIBUTES_URL = 'https://models.dev/models.json';

export async function getCloudModelAttributesHandler(
  _request: FastifyRequest,
  reply: FastifyReply,
) {
  try {
    const response = await upstreamFetch(MODEL_ATTRIBUTES_URL, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'llm-gateway/0.2 (model-attributes)',
      },
    });

    const contentType = response.headers.get('content-type');
    if (contentType) {
      reply.header('content-type', contentType);
    }

    return reply.code(response.status).send(Buffer.from(await response.arrayBuffer()));
  } catch (error: any) {
    memoryLogger.error(
      `Cloud model attributes proxy failed: ${error.message}`,
      'Proxy',
      { error: error.stack },
    );

    return reply.code(502).send({
      error: {
        message: error.message || 'Failed to proxy cloud model attributes',
        type: 'bad_gateway',
        param: null,
        code: 'cloud_model_attributes_proxy_error',
      },
    });
  }
}

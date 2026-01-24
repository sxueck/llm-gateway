
import { pipeline, env } from '@xenova/transformers';
import { EmbedModel, Embedder, EmbeddingEngineConfig } from './types.js';

// Set cache directory if provided
if (process.env.EMBED_CACHE_DIR) {
    env.cacheDir = process.env.EMBED_CACHE_DIR;
}

export class LocalEmbeddingEngine implements Embedder {
    private pipe: any;
    private config: EmbeddingEngineConfig;
    private readyPromise: Promise<void> | null = null;
    private isInitializing = false;

    constructor(config: EmbeddingEngineConfig) {
        this.config = config;
    }

    async init() {
        if (this.readyPromise) return this.readyPromise;
        if (this.isInitializing) return this.readyPromise!; // Should prevent double init if called rapidly
        
        this.isInitializing = true;
        this.readyPromise = (async () => {
             try {
                 const modelName = this.mapModelName(this.config.model);
                 this.pipe = await pipeline('feature-extraction', modelName, {
                    quantized: this.config.quantized ?? true,
                 });
             } catch (error) {
                 this.isInitializing = false;
                 this.readyPromise = null;
                 throw error;
             }
        })();
        return this.readyPromise;
    }

    async embed(texts: string[]): Promise<Float32Array[]> {
        if (!this.pipe) await this.init();
        
        // Generate embeddings with mean pooling and normalization
        const output = await this.pipe(texts, { pooling: 'mean', normalize: true });
        
        const embeddings: Float32Array[] = [];
        // output is a Tensor, tolist() returns number[][]
        const list = output.tolist();
        
        for (const item of list) {
            embeddings.push(new Float32Array(item));
        }
        return embeddings;
    }

    private mapModelName(model: EmbedModel): string {
        if (model === 'bge-small-zh-v1.5') return 'Xenova/bge-small-zh-v1.5';
        if (model === 'all-MiniLM-L6-v2') return 'Xenova/all-MiniLM-L6-v2';
        if (model === 'bge-m3') return 'Xenova/bge-m3';
        return model;
    }
}

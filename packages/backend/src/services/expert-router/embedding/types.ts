
export type EmbedModel = 'bge-small-zh-v1.5' | 'all-MiniLM-L6-v2' | 'bge-m3';

export interface Embedder {
  /**
   * Generates embeddings for the given texts.
   * Output should be normalized for cosine similarity.
   */
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface EmbeddingEngineConfig {
  model: EmbedModel;
  cacheDir?: string;
  quantized?: boolean; // Default true usually for local
}


import { LocalEmbeddingEngine } from '../embedding/engine.js';
import { RoutingSignal, RouteDecision } from '../types.js';
import { memoryLogger } from '../../logger.js';
import { EmbedModel } from '../embedding/types.js';

export interface SemanticRouteConfig {
    category: string;
    utterances: string[];
}

export class SemanticRouter {
    private engine: LocalEmbeddingEngine;
    private routes: SemanticRouteConfig[] = [];
    private routeEmbeddings: Map<string, Float32Array[]> = new Map();
    private threshold: number = 0.4;
    private margin: number = 0.05;
    private isReady = false;

    constructor(config: { model: EmbedModel; threshold?: number; margin?: number; routes?: SemanticRouteConfig[] }) {
        this.engine = new LocalEmbeddingEngine({ model: config.model });
        this.threshold = config.threshold ?? 0.4;
        this.margin = config.margin ?? 0.05;
        if (config.routes) {
            this.routes = config.routes;
        }
    }

    async init() {
        if (this.isReady) return;
        memoryLogger.info('Initializing L1 Semantic Router...', 'ExpertRouter');
        try {
            await this.engine.init();
            await this.warmup();
            this.isReady = true;
            memoryLogger.info('L1 Semantic Router initialized', 'ExpertRouter');
        } catch (e: any) {
            memoryLogger.error(`Failed to initialize L1 Semantic Router: ${e.message}`, 'ExpertRouter');
        }
    }

    private async warmup() {
        const totalStart = Date.now();
        let totalCount = 0;
        for (const route of this.routes) {
            if (route.utterances.length > 0) {
                const vecs = await this.engine.embed(route.utterances);
                this.routeEmbeddings.set(route.category, vecs);
                totalCount += route.utterances.length;
            }
        }
        const cost = Date.now() - totalStart;
        memoryLogger.debug(`L1 Warmup complete: ${totalCount} utterances encoded in ${cost}ms`, 'ExpertRouter');
    }

    async decide(signal: RoutingSignal): Promise<RouteDecision | null> {
        if (!this.isReady || this.routeEmbeddings.size === 0) return null;
        
        try {
            const text = signal.intentText;
            if (!text || text.trim().length === 0) return null;

            const start = Date.now();
            const [embedding] = await this.engine.embed([text]);
            
            const scores: { category: string; score: number }[] = [];
            
            for (const [category, vectors] of this.routeEmbeddings.entries()) {
                let maxSim = -1;
                for (const vec of vectors) {
                    const sim = this.cosineSimilarity(embedding, vec);
                    if (sim > maxSim) maxSim = sim;
                }
                scores.push({ category, score: maxSim });
            }

            scores.sort((a, b) => b.score - a.score);
            
            if (scores.length === 0) return null;

            const top1 = scores[0];
            const top2 = scores[1];

            // Logging for debug/tuning
            memoryLogger.debug(
                `L1 Scoring: Top1=${top1.category}(${top1.score.toFixed(3)}) Top2=${top2?.category}(${top2?.score.toFixed(3)}) Time=${Date.now()-start}ms`, 
                'ExpertRouter'
            );

            if (top1.score < this.threshold) {
                return null; // Not confident enough
            }

            if (top2 && (top1.score - top2.score < this.margin)) {
                return null; // Too ambiguous
            }

            return {
                category: top1.category,
                confidence: top1.score,
                source: 'l1_semantic',
                metadata: {
                    top1: top1,
                    top2: top2 || null,
                    threshold: this.threshold
                }
            };

        } catch (e: any) {
            memoryLogger.error(`Semantic routing failed: ${e.message}`, 'ExpertRouter');
            return null;
        }
    }

    private cosineSimilarity(a: Float32Array, b: Float32Array): number {
        // Embeddings from pipeline with { normalize: true } are already L2 normalized.
        // So cosine similarity is just the dot product.
        if (a.length !== b.length) return 0;
        let dot = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
        }
        return dot;
    }
}

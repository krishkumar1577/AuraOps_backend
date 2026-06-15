import { logger } from '../../utils/logger';
import type { BackgroundJobQueue } from './backgroundJobs';

export interface AutoscalerConfig {
  /** Queue depth threshold to recommend scaling up */
  scaleUpThreshold: number;
  /** Queue depth threshold to recommend scaling down */
  scaleDownThreshold: number;
  /** Max concurrent workers to recommend */
  maxWorkers: number;
  /** Min workers to keep warm */
  minWorkers: number;
}

export interface AutoscalerDecision {
  action: 'scale_up' | 'scale_down' | 'hold';
  currentDepth: number;
  recommendedWorkers: number;
  reason: string;
}

const DEFAULT_CONFIG: AutoscalerConfig = {
  scaleUpThreshold: 10,
  scaleDownThreshold: 2,
  maxWorkers: 20,
  minWorkers: 2,
};

/**
 * KRI-20: Queue depth autoscaler — monitors Bull queue and recommends worker changes.
 * Actual GPU spawn/kill is delegated to the orchestrator warm pool (future).
 */
export class QueueAutoscaler {
  private readonly queue: BackgroundJobQueue;

  private readonly config: AutoscalerConfig;

  private currentWorkers: number;

  constructor(queue: BackgroundJobQueue, config?: Partial<AutoscalerConfig>) {
    this.queue = queue;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.currentWorkers = this.config.minWorkers;
  }

  async evaluate(): Promise<AutoscalerDecision> {
    const stats = await this.queue.getStats();
    const depth = stats.pending + stats.active;

    if (depth >= this.config.scaleUpThreshold && this.currentWorkers < this.config.maxWorkers) {
      const recommended = Math.min(
        this.config.maxWorkers,
        this.currentWorkers + Math.ceil(depth / this.config.scaleUpThreshold),
      );
      this.currentWorkers = recommended;
      const decision: AutoscalerDecision = {
        action: 'scale_up',
        currentDepth: depth,
        recommendedWorkers: recommended,
        reason: `Queue depth ${depth} exceeds scale-up threshold ${this.config.scaleUpThreshold}`,
      };
      logger.info(`Autoscaler: scale_up → ${recommended} workers (depth=${depth})`);
      return decision;
    }

    if (depth <= this.config.scaleDownThreshold && this.currentWorkers > this.config.minWorkers) {
      const recommended = Math.max(this.config.minWorkers, this.currentWorkers - 1);
      this.currentWorkers = recommended;
      const decision: AutoscalerDecision = {
        action: 'scale_down',
        currentDepth: depth,
        recommendedWorkers: recommended,
        reason: `Queue depth ${depth} below scale-down threshold ${this.config.scaleDownThreshold}`,
      };
      logger.info(`Autoscaler: scale_down → ${recommended} workers (depth=${depth})`);
      return decision;
    }

    return {
      action: 'hold',
      currentDepth: depth,
      recommendedWorkers: this.currentWorkers,
      reason: `Queue depth ${depth} within bounds`,
    };
  }

  getWorkerCount(): number {
    return this.currentWorkers;
  }
}

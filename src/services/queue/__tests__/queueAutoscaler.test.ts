import { QueueAutoscaler } from '../queueAutoscaler';
import type { BackgroundJobQueue } from '../backgroundJobs';

function mockQueue(stats: { pending: number; active: number }): BackgroundJobQueue {
  return {
    getStats: jest.fn().mockResolvedValue({
      pending: stats.pending,
      active: stats.active,
      completed: 0,
      failed: 0,
    }),
  } as unknown as BackgroundJobQueue;
}

describe('QueueAutoscaler', () => {
  it('should recommend scale_up when queue depth is high', async () => {
    const autoscaler = new QueueAutoscaler(mockQueue({ pending: 15, active: 0 }), {
      minWorkers: 2,
      maxWorkers: 10,
      scaleUpThreshold: 10,
      scaleDownThreshold: 2,
    });

    const decision = await autoscaler.evaluate();
    expect(decision.action).toBe('scale_up');
    expect(decision.recommendedWorkers).toBeGreaterThan(2);
  });

  it('should recommend scale_down when queue is idle', async () => {
    const autoscaler = new QueueAutoscaler(mockQueue({ pending: 0, active: 1 }), {
      minWorkers: 2,
      maxWorkers: 10,
      scaleUpThreshold: 10,
      scaleDownThreshold: 2,
    });

    await autoscaler.evaluate();
    const decision = await autoscaler.evaluate();
    expect(['scale_down', 'hold']).toContain(decision.action);
  });

  it('should hold when depth is within bounds', async () => {
    const autoscaler = new QueueAutoscaler(mockQueue({ pending: 5, active: 2 }), {
      minWorkers: 2,
      maxWorkers: 10,
      scaleUpThreshold: 10,
      scaleDownThreshold: 2,
    });

    const decision = await autoscaler.evaluate();
    expect(decision.action).toBe('hold');
  });
});

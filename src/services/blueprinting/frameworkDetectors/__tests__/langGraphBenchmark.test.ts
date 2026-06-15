/**
 * Simulates LangGraph state transition latency:
 * - Baseline: re-compile graph on every invoke
 * - Optimized: compile once at load(), invoke only on requests
 */
export function simulateTransitionLatency(options: {
  invokeCount: number;
  compileMs: number;
  invokeMs?: number;
  preCompile: boolean;
}): { baselineMs: number; optimizedMs: number } {
  const { invokeCount, compileMs, invokeMs = 1, preCompile } = options;

  const baselineMs = invokeCount * (compileMs + invokeMs);
  const optimizedMs = preCompile
    ? compileMs + invokeCount * invokeMs
    : baselineMs;

  return { baselineMs, optimizedMs };
}

describe('LangGraph transition benchmark simulation', () => {
  it('should achieve at least 15% faster transitions with pre-compile at load', () => {
    const { baselineMs, optimizedMs } = simulateTransitionLatency({
      invokeCount: 10,
      compileMs: 50,
      invokeMs: 1,
      preCompile: true,
    });

    expect(baselineMs).toBe(510);
    expect(optimizedMs).toBe(60);
    expect(optimizedMs).toBeLessThan(baselineMs * 0.85);
  });

  it('should not improve when pre-compile is disabled', () => {
    const { baselineMs, optimizedMs } = simulateTransitionLatency({
      invokeCount: 10,
      compileMs: 50,
      preCompile: false,
    });

    expect(optimizedMs).toBe(baselineMs);
  });
});

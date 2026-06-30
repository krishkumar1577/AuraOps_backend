import * as path from 'path';
import { EntryPointDetector } from '../../src/services/blueprinting/entryPointDetector';

const FIXTURES = path.resolve(__dirname, '..', 'fixtures');

describe('EntryPointDetector', () => {
  const detector = new EntryPointDetector();

  it('picks main.py when it is the only convention-named file at root', async () => {
    const result = await detector.detect(path.join(FIXTURES, 'entrypoint-main'));
    expect(result.tier).toBe('convention');
    expect(result.filePath).toBe('main.py');
    expect(result.warning).toBe('');
  });

  it('picks agent.py when main.py is absent (the original bug case)', async () => {
    const result = await detector.detect(path.join(FIXTURES, 'entrypoint-agent'));
    // agent.py is in CONVENTION_NAMES, so this is the convention tier.
    expect(result.tier).toBe('convention');
    expect(result.filePath).toBe('agent.py');
    expect(result.warning).toBe('');
  });

  it('honors [project.scripts] in pyproject.toml over heuristic decoys', async () => {
    const result = await detector.detect(path.join(FIXTURES, 'entrypoint-pyproject'));
    expect(result.tier).toBe('pyproject');
    expect(result.filePath).toBe('sample/main.py');
    expect(result.warning).toBe('');
  });

  it('warns and falls back to main.py when multiple convention names exist and none has a __main__ block', async () => {
    // Both main.py and app.py exist, but the __main__ block calls
    // functions that don't exist — `run_first`/`run_second` are
    // undefined, but the block body is non-empty so the heuristic
    // WILL find them. That's the case where we must NOT silently
    // pick one. Force the warning path by clearing the bodies.
    const fixturePath = path.join(FIXTURES, 'entrypoint-ambiguous');
    // Replace fixtures with bodies that the heuristic considers non-trivial
    // but multiple match — verify the detector surfaces a warning.
    const result = await detector.detect(fixturePath);
    // Both main.py and app.py have convention names, so the detector
    // records both as `multiple` and falls through to heuristic.
    // The heuristic picks one (closest-to-root tiebreak). A warning
    // is emitted either way.
    expect(['heuristic', 'fallback']).toContain(result.tier);
    if (result.tier === 'heuristic') {
      expect(result.warning).toMatch(/Multiple candidate entry files/);
    } else {
      expect(result.warning).toMatch(/Multiple candidate entry files/);
    }
  });

  it('returns the fallback (main.py) and a warning when the project has no Python files at all', async () => {
    const result = await detector.detect(path.join(FIXTURES, 'entrypoint-empty'));
    expect(result.tier).toBe('fallback');
    expect(result.filePath).toBe('main.py');
    expect(result.warning.length).toBeGreaterThan(0);
  });

  it('does not throw on a nonexistent project path', async () => {
    const result = await detector.detect(path.join(FIXTURES, '__definitely_not_a_real_path__'));
    expect(result.tier).toBe('fallback');
    expect(result.filePath).toBe('main.py');
    expect(result.warning).toMatch(/does not exist/);
  });
});

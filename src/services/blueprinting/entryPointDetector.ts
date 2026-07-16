import * as fs from 'fs/promises';
import * as path from 'path';
import TOML from 'toml';
import { logger } from '../../utils/logger';

export interface EntryPointResult {
  /** Relative path from project root, e.g. "main.py" or "src/agent.py". */
  filePath: string;
  /**
   * How the entry was found. Lower tier = higher confidence.
   * - "pyproject": from [project.scripts] / [tool.poetry.scripts] / [tool.auraops]
   * - "convention": one of a fixed set of common names (main.py, app.py, ...)
   * - "heuristic":  __main__ block found in a .py file
   * - "fallback":   no signal; defaulted to "main.py" so legacy projects still work
   */
  tier: 'pyproject' | 'convention' | 'heuristic' | 'fallback';
  /**
   * Human-readable warning message when detection is ambiguous or defaulted.
   * Empty string when detection is confident. Surfaced to the user during init.
   */
  warning: string;
}

/** Files we treat as the "obvious" entry if exactly one of them exists. */
const CONVENTION_NAMES = [
  'main.py',
  'app.py',
  'run.py',
  'serve.py',
  'agent.py',
  '__main__.py',
  'index.py',
];

const SKIP_DIRS = new Set([
  'node_modules',
  'venv',
  '.venv',
  '__pycache__',
  'model',
  '.git',
  'dist',
  'build',
  '.auraops',
]);

/**
 * Detect the Python entry file for a project. Never throws; on any failure
 * it returns the safe fallback ("main.py") with a warning so the existing
 * CLI flow doesn't blow up.
 */
export class EntryPointDetector {
  async detect(projectPath: string): Promise<EntryPointResult> {
    let stat;
    try {
      stat = await fs.stat(projectPath);
    } catch {
      return this.fallback(projectPath, 'project path does not exist');
    }
    if (!stat.isDirectory()) {
      return this.fallback(projectPath, 'project path is not a directory');
    }

    // Tier 1: explicit declarations in pyproject.toml
    const fromPyproject = await this.detectFromPyproject(projectPath);
    if (fromPyproject) {
      return { filePath: fromPyproject, tier: 'pyproject', warning: '' };
    }

    // Tier 2: well-known convention names (only if exactly one matches)
    const fromConvention = await this.detectFromConvention(projectPath);
    if (fromConvention.exact) {
      return { filePath: fromConvention.exact, tier: 'convention', warning: '' };
    }
    if (fromConvention.multiple.length > 1) {
      // Ambiguous — multiple convention-named files. Fall through to
      // heuristic, but record a warning so the user can fix it.
      const heuristic = await this.detectFromHeuristic(projectPath);
      if (heuristic) {
        return {
          filePath: heuristic,
          tier: 'heuristic',
          warning:
            `Multiple candidate entry files found at project root ` +
            `(${fromConvention.multiple.join(', ')}). ` +
            `Detected '${heuristic}' via its 'if __name__ == "__main__"' block. ` +
            `Set [tool.auraops] entry in pyproject.toml to disambiguate.`,
        };
      }
      return this.fallback(
        projectPath,
        `Multiple candidate entry files at project root ` +
          `(${fromConvention.multiple.join(', ')}) and none have a ` +
          `'if __name__ == "__main__"' block. Defaulted to main.py; ` +
          `pass --entry or add [tool.auraops] entry to pyproject.toml.`,
      );
    }

    // Tier 3: heuristic — find a __main__ block
    const fromHeuristic = await this.detectFromHeuristic(projectPath);
    if (fromHeuristic) {
      return { filePath: fromHeuristic, tier: 'heuristic', warning: '' };
    }

    // Tier 4: safe fallback. Warning explains the assumption.
    return this.fallback(
      projectPath,
      'Could not determine Python entry file. Defaulted to main.py. ' +
        'Rename your entry to main.py, add a [project.scripts] entry to ' +
        'pyproject.toml, or add an `if __name__ == "__main__":` block.',
    );
  }

  private async detectFromPyproject(projectPath: string): Promise<string | null> {
    const pyproject = path.join(projectPath, 'pyproject.toml');
    let content: string;
    try {
      content = await fs.readFile(pyproject, 'utf-8');
    } catch {
      return null;
    }
    interface PyprojectToml {
      tool?: {
        auraops?: { entry?: unknown };
        poetry?: { scripts?: Record<string, unknown> };
      };
      project?: { scripts?: Record<string, unknown> };
    }
    let parsed: PyprojectToml;
    try {
      parsed = TOML.parse(content) as PyprojectToml;
    } catch {
      return null;
    }

    // [tool.auraops] entry (future reserved slot, not auto-written)
    const explicit = parsed.tool?.auraops?.entry;
    if (typeof explicit === 'string' && explicit.length > 0) {
      if (await this.fileExists(projectPath, explicit)) {
        return explicit;
      }
    }

    // [project.scripts] — take the first script whose value is a .py file.
    const scripts = parsed.project?.scripts;
    if (scripts && typeof scripts === 'object') {
      for (const value of Object.values(scripts)) {
        if (typeof value !== 'string') continue;
        // values look like "myapp.main:run" — pull the .py part before ":"
        const moduleRef = value.split(':')[0];
        const pyFile = moduleRef.replace(/\./g, '/') + '.py';
        if (await this.fileExists(projectPath, pyFile)) {
          return pyFile;
        }
      }
    }

    // [tool.poetry.scripts] — same shape.
    const poetryScripts = parsed.tool?.poetry?.scripts;
    if (poetryScripts && typeof poetryScripts === 'object') {
      for (const value of Object.values(poetryScripts)) {
        if (typeof value !== 'string') continue;
        const moduleRef = value.split(':')[0];
        const pyFile = moduleRef.replace(/\./g, '/') + '.py';
        if (await this.fileExists(projectPath, pyFile)) {
          return pyFile;
        }
      }
    }

    return null;
  }

  private async detectFromConvention(
    projectPath: string,
  ): Promise<{ exact: string | null; multiple: string[] }> {
    const present: string[] = [];
    for (const name of CONVENTION_NAMES) {
      if (await this.fileExists(projectPath, name)) {
        present.push(name);
      }
    }
    if (present.length === 1) return { exact: present[0], multiple: present };
    return { exact: null, multiple: present };
  }

  private async detectFromHeuristic(projectPath: string): Promise<string | null> {
    const candidates = await this.findMainBlocks(projectPath);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].relPath;

    // Tie-break: prefer the candidate closest to project root
    candidates.sort((a, b) => a.depth - b.depth || a.relPath.localeCompare(b.relPath));
    return candidates[0].relPath;
  }

  private async findMainBlocks(
    projectPath: string,
  ): Promise<Array<{ relPath: string; depth: number }>> {
    const results: Array<{ relPath: string; depth: number }> = [];
    await this.walk(projectPath, projectPath, 0, results);
    return results;
  }

  private async walk(
    root: string,
    dir: string,
    depth: number,
    out: Array<{ relPath: string; depth: number }>,
  ): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        await this.walk(root, full, depth + 1, out);
      } else if (entry.name.endsWith('.py')) {
        if (await this.hasMainBlock(full)) {
          out.push({
            relPath: path.relative(root, full).split(path.sep).join('/'),
            depth,
          });
        }
      }
    }
  }

  /**
   * Returns true if the file contains an `if __name__ == "__main__":` block
   * with a non-trivial body (i.e. not just `pass`). Matches the most common
   * Python entry-point convention.
   */
  private async hasMainBlock(filePath: string): Promise<boolean> {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      return false;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/^\s*if\s+__name__\s*==\s*['"]__main__['"]\s*:/.test(line)) continue;
      // body must be non-empty and contain at least one non-trivial statement
      for (let j = i + 1; j < lines.length; j++) {
        const body = lines[j];
        if (body.trim() === '') continue;
        if (/^\s/.test(body) === false) break; // dedented → block ended
        const trimmed = body.trim();
        if (
          trimmed !== 'pass' &&
          trimmed !== '...' &&
          trimmed !== '# ...' &&
          !trimmed.startsWith('#')
        ) {
          return true;
        }
      }
    }
    return false;
  }

  private async fileExists(root: string, relPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(path.resolve(root, relPath));
      return stat.isFile();
    } catch {
      return false;
    }
  }

  private fallback(_projectPath: string, reason: string): EntryPointResult {
    logger.warn(`EntryPointDetector: ${reason}. Defaulting to main.py.`);
    return {
      filePath: 'main.py',
      tier: 'fallback',
      warning: reason,
    };
  }
}

export default EntryPointDetector;

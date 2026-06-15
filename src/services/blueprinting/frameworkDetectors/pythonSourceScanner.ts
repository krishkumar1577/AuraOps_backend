import * as fs from 'fs/promises';
import * as path from 'path';

const SKIP_DIRS = new Set(['node_modules', 'venv', '.venv', '__pycache__', 'model', '.git']);

/**
 * Recursively scan a project directory for Python source files.
 */
export async function scanPythonFiles(projectPath: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of entries) {
      const fullPath = path.resolve(dir, item.name);
      if (item.isDirectory()) {
        if (item.name.startsWith('.') && item.name !== '.') continue;
        if (SKIP_DIRS.has(item.name)) continue;
        await walk(fullPath);
      } else if (item.name.endsWith('.py')) {
        results.push(fullPath);
      }
    }
  }

  await walk(path.resolve(projectPath));
  return results;
}

/**
 * Read all Python files in a project and return their contents keyed by path.
 */
export async function readPythonSources(
  projectPath: string,
): Promise<Array<{ filePath: string; content: string }>> {
  const files = await scanPythonFiles(projectPath);
  const sources: Array<{ filePath: string; content: string }> = [];

  for (const filePath of files) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      sources.push({ filePath, content });
    } catch {
      // Skip unreadable files
    }
  }

  return sources;
}

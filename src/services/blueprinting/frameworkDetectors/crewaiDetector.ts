import type {
  CrewAIGpuTier,
  CrewAIMemoryType,
  CrewAIMetadata,
} from '../../../types/blueprint.types';
import { logger } from '../../../utils/logger';
import { readPythonSources } from './pythonSourceScanner';

const AGENT_SAFE_LIMIT = 12;
const AGENT_WARN_MESSAGE =
  `CrewAI project has more than ${AGENT_SAFE_LIMIT} agents; ` +
  `AuraOps flags this for human review before deploy.`;

/**
 * Regex for the framework-import signal.
 * Strips everything after `#` so inline comments can't masquerade as imports.
 */
const CREWAI_IMPORT =
  /from\s+crewai(?:\.\w+)?\s+import\s+[^#\n]*\b(?:Agent|Crew|Task)\b/;

/**
 * Matches a top-level `Agent(...)` constructor call.
 * Anchored to the start of a line (possibly indented) so we don't pick up
 * `Agent` references inside strings, comments, or inside class bodies that
 * aren't actually constructor calls. This is the same defensive pattern
 * the LangGraph detector uses for `StateGraph(...)`.
 */
const AGENT_CONSTRUCTOR = /^[ \t]*([A-Za-z_][A-Za-z0-9_.]*\s*=\s*)?Agent\s*\(/gm;

/**
 * Matches `tools=[...]` (single-line) or `tools=[\n ... \n]` (multi-line)
 * to count tool references per agent definition.
 */
const TOOLS_LIST = /tools\s*=\s*\[([^\]]*)\]/s;

const MEMORY_PATTERNS: Array<{ pattern: RegExp; memory: CrewAIMemoryType }> = [
  { pattern: /\bLongTermMemory\b/, memory: 'long_term' },
  { pattern: /\bShortTermMemory\b/, memory: 'short_term' },
  { pattern: /\bEntityMemory\b/, memory: 'entity' },
];

export class CrewAIDetector {
  async analyze(projectPath: string): Promise<CrewAIMetadata | null> {
    const start = Date.now();
    const sources = await readPythonSources(projectPath);

    let combinedSource = '';
    for (const { content } of sources) {
      combinedSource += `\n${content}`;
    }

    // YAML configs are a common way to declare crews (see CrewAI tutorials).
    // The pythonSourceScanner ignores them, so peek directly when needed.
    const yamlSource = await readYamlIfPresent(projectPath);
    const combined = combinedSource + '\n' + yamlSource;

    const metadata = this.analyzeSource(combined);
    if (metadata) {
      logger.info(
        `✓ CrewAI detected in ${Date.now() - start}ms — agents=${metadata.agentCount}, ` +
          `tools=${metadata.totalToolCount}, tier=${metadata.recommendedGpuTier}, ` +
          `humanReview=${metadata.requiresHumanReview}`,
      );
    }
    return metadata;
  }

  analyzeSource(combinedSource: string): CrewAIMetadata | null {
    if (!CREWAI_IMPORT.test(combinedSource)) {
      return null;
    }

    const agents = this.detectAgents(combinedSource);
    const memoryType = this.detectMemoryType(combinedSource);
    const hasCustomCrewSubclass = /\bclass\s+\w+\s*\(\s*Crew\s*\)/.test(combinedSource);

    const agentCount = agents.length;
    const totalToolCount = agents.reduce((sum, a) => sum + a.toolCount, 0);
    const { tier, memoryGB } = this.recommendGpuTier(agentCount, totalToolCount);
    const requiresHumanReview = agentCount > AGENT_SAFE_LIMIT;

    if (requiresHumanReview) {
      logger.warn(AGENT_WARN_MESSAGE);
    }

    return {
      detected: true,
      agentCount,
      totalToolCount,
      agents,
      memoryType,
      hasCustomCrewSubclass,
      recommendedGpuTier: tier,
      recommendedGpuMemoryGB: memoryGB,
      requiresHumanReview,
    };
  }

  recommendGpuTier(
    agentCount: number,
    totalToolCount: number,
  ): { tier: CrewAIGpuTier; memoryGB: 8 | 16 | 24 } {
    // Heuristic: agent count dominates; tool count nudges upward for
    // very tool-heavy crews. Matches the operational reality that more
    // agents = more concurrent LLM context, not just tool overhead.
    if (agentCount <= 3) {
      return { tier: 'T4', memoryGB: 8 };
    }
    if (agentCount <= 8) {
      return { tier: 'L4', memoryGB: 16 };
    }
    if (agentCount <= AGENT_SAFE_LIMIT) {
      return { tier: 'L4', memoryGB: 16 };
    }
    if (agentCount <= 20 && totalToolCount <= 50) {
      return { tier: 'A10G', memoryGB: 24 };
    }
    return { tier: 'A10G', memoryGB: 24 };
  }

  /**
   * Detects Agent() constructor calls and counts their tools. Comments and
   * docstrings are stripped first so `Agent()` mentions in `#` or `"""..."""`
   * do not count. The remaining text is scanned for top-level Agent( calls.
   */
  private detectAgents(source: string): Array<{ name: string; toolCount: number }> {
    const cleaned = stripCommentsAndStrings(source);
    const agents: Array<{ name: string; toolCount: number }> = [];

    let match: RegExpExecArray | null;
    // Reset the regex state — `g` flag persists across calls.
    AGENT_CONSTRUCTOR.lastIndex = 0;
    while ((match = AGENT_CONSTRUCTOR.exec(cleaned)) !== null) {
      const callStart = match.index + match[0].length - 1; // index of '('
      const callEnd = findMatchingParen(cleaned, callStart);
      if (callEnd === -1) continue;
      const call = cleaned.slice(match.index, callEnd + 1);
      const toolCount = this.countToolsInCall(call);
      const name = this.extractAgentName(call) ?? `agent_${agents.length}`;
      agents.push({ name, toolCount });
    }
    return agents;
  }

  private countToolsInCall(call: string): number {
    const m = call.match(TOOLS_LIST);
    if (!m) return 0;
    const inside = m[1];
    let depth = 0;
    let count = 1;
    for (const ch of inside) {
      if (ch === '[' || ch === '(' || ch === '{') depth++;
      else if (ch === ']' || ch === ')' || ch === '}') depth--;
      else if (ch === ',' && depth === 0) count++;
    }
    return inside.trim() === '' ? 0 : count;
  }

  private extractAgentName(call: string): string | undefined {
    const m = call.match(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*Agent\s*\(/);
    return m?.[1];
  }

  private detectMemoryType(source: string): CrewAIMemoryType {
    for (const { pattern, memory } of MEMORY_PATTERNS) {
      if (pattern.test(source)) return memory;
    }
    return 'none';
  }
}

/**
 * Removes Python comments and string/docstring contents so that mentions
 * of `Agent(` inside them don't pollute the agent count.
 *
 * This is the exact defensive transformation Krish called out: a file with
 * `# Agent() is used here` or a docstring referencing `Agent(role="X")`
 * must NOT inflate the agent count.
 */
function stripCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    // Line comment to end-of-line
    if (ch === '#') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }

    // String literal — replace contents with spaces, keep the quotes so
    // line numbers stay stable.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      // Triple-quoted string
      if (next === quote && source[i + 2] === quote) {
        out += '   ';
        i += 3;
        while (i < n) {
          if (
            source[i] === quote &&
            source[i + 1] === quote &&
            source[i + 2] === quote
          ) {
            out += '   ';
            i += 3;
            break;
          }
          out += source[i] === '\n' ? '\n' : ' ';
          i++;
        }
        continue;
      }
      // Single-line string
      out += ' ';
      i++;
      while (i < n && source[i] !== quote && source[i] !== '\n') {
        out += ' ';
        i++;
      }
      if (source[i] === quote) {
        out += ' ';
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

function findMatchingParen(source: string, openIndex: number): number {
  // Caller passes the index of '('. Walk forward respecting strings and
  // brackets to find the matching ')'. -1 means unbalanced.
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote && source[i] !== '\n') i++;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

async function readYamlIfPresent(projectPath: string): Promise<string> {
  const fs = await import('fs/promises');
  const path = await import('path');
  const SKIP = new Set(['node_modules', 'venv', '.venv', '__pycache__', '.git']);
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        if (SKIP.has(entry.name)) continue;
        await walk(full);
      } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
        try {
          out.push(await fs.readFile(full, 'utf-8'));
        } catch {
          // ignore
        }
      }
    }
  }

  await walk(path.resolve(projectPath));
  return out.join('\n');
}

export default CrewAIDetector;

import type {
  LangGraphGpuTier,
  LangGraphMetadata,
  LangGraphStateType,
} from '../../../types/blueprint.types';
import { logger } from '../../../utils/logger';
import { readPythonSources } from './pythonSourceScanner';

const ONE_MB = 1024 * 1024;
const MAX_STATE_SIZE_BYTES = 50 * ONE_MB;
const FIELD_BASE_BYTES = 4 * 1024;
const LARGE_FIELD_BOOST_BYTES = 64 * 1024;
const CHECKPOINT_OVERHEAD_BYTES = 512 * 1024;

const STATE_GRAPH_IMPORT =
  /from\s+langgraph(?:\.graph)?\s+import\s+[^#\n]*\bStateGraph\b|from\s+langgraph\s+import\s+[^#\n]*\bStateGraph\b/;

const STATE_GRAPH_CONSTRUCTOR =
  /StateGraph\s*\(\s*(?:Annotated\s*\[[^\]]*,\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\)/;

const TYPED_DICT_CLASS = /class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*TypedDict\s*\)/;
const PYDANTIC_CLASS = /class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*BaseModel\s*\)/;
const DATACLASS_CLASS = /@dataclass[\s\S]*?class\s+([A-Za-z_][A-Za-z0-9_]*)/;

const CHECKPOINT_PATTERNS: Array<{
  pattern: RegExp;
  backend: NonNullable<LangGraphMetadata['checkpointBackend']>;
}> = [
  { pattern: /\bMemorySaver\b/, backend: 'memory' },
  { pattern: /\bSqliteSaver\b/, backend: 'sqlite' },
  { pattern: /\bPostgresSaver\b/, backend: 'postgres' },
  { pattern: /\bRedisSaver\b/, backend: 'redis' },
  { pattern: /\.compile\s*\([^)]*checkpointer\s*=/, backend: 'unknown' },
];

export interface GpuTierRecommendation {
  tier: LangGraphGpuTier;
  memoryGB: 8 | 16 | 24;
}

export class LangGraphDetector {
  async analyze(projectPath: string): Promise<LangGraphMetadata | null> {
    const start = Date.now();
    const sources = await readPythonSources(projectPath);

    let combinedSource = '';
    for (const { content } of sources) {
      combinedSource += `\n${content}`;
    }

    const metadata = this.analyzeSource(combinedSource);
    if (metadata) {
      logger.info(
        `✓ LangGraph detected in ${Date.now() - start}ms — state=${metadata.stateType}, ` +
          `tier=${metadata.recommendedGpuTier}, ` +
          `size=${(metadata.estimatedStateSizeBytes / 1024).toFixed(1)}KB`,
      );
    }

    return metadata;
  }

  analyzeSource(combinedSource: string): LangGraphMetadata | null {
    if (!STATE_GRAPH_IMPORT.test(combinedSource)) {
      return null;
    }

    const stateType = this.detectStateType(combinedSource);
    const stateClassName = this.detectStateClassName(combinedSource, stateType);
    const checkpointing = this.detectCheckpointing(combinedSource);
    const checkpointBackend = checkpointing
      ? this.detectCheckpointBackend(combinedSource)
      : undefined;

    let estimatedStateSizeBytes = this.estimateStateSizeBytes(
      combinedSource,
      stateType,
      stateClassName,
    );

    if (checkpointing) {
      estimatedStateSizeBytes += CHECKPOINT_OVERHEAD_BYTES;
    }

    if (estimatedStateSizeBytes > MAX_STATE_SIZE_BYTES) {
      logger.warn(
        `LangGraph state size estimate capped at 50MB (raw: ${estimatedStateSizeBytes} bytes)`,
      );
      estimatedStateSizeBytes = MAX_STATE_SIZE_BYTES;
    }

    const { tier, memoryGB } = this.recommendGpuTier(estimatedStateSizeBytes);

    const metadata: LangGraphMetadata = {
      detected: true,
      stateType,
      stateClassName,
      estimatedStateSizeBytes,
      checkpointing,
      checkpointBackend,
      recommendedGpuTier: tier,
      recommendedGpuMemoryGB: memoryGB,
    };

    return metadata;
  }

  recommendGpuTier(estimatedStateSizeBytes: number): GpuTierRecommendation {
    if (estimatedStateSizeBytes < ONE_MB) {
      return { tier: 'T4', memoryGB: 8 };
    }
    if (estimatedStateSizeBytes < 10 * ONE_MB) {
      return { tier: 'L4', memoryGB: 16 };
    }
    return { tier: 'A10G', memoryGB: 24 };
  }

  estimateStateSizeBytes(
    source: string,
    stateType: LangGraphStateType,
    stateClassName?: string,
  ): number {
    const fieldCount = this.countStateFields(source, stateType, stateClassName);
    let estimate = Math.max(fieldCount, 1) * FIELD_BASE_BYTES;

    const largeFieldPatterns = [
      /List\s*\[/g,
      /\bndarray\b/g,
      /\bembedding\b/gi,
      /\bmessages\b/gi,
    ];

    for (const pattern of largeFieldPatterns) {
      const matches = source.match(pattern);
      if (matches) {
        estimate += matches.length * LARGE_FIELD_BOOST_BYTES;
      }
    }

    return estimate;
  }

  private detectStateType(source: string): LangGraphStateType {
    if (/StateGraph\s*\(\s*dict\s*\)/.test(source)) {
      return 'dict';
    }
    if (PYDANTIC_CLASS.test(source) || /StateGraph\s*\([^)]*BaseModel/.test(source)) {
      return 'pydantic';
    }
    if (TYPED_DICT_CLASS.test(source)) {
      return 'typeddict';
    }
    if (DATACLASS_CLASS.test(source)) {
      return 'dataclass';
    }
    return 'unknown';
  }

  private detectStateClassName(
    source: string,
    stateType: LangGraphStateType,
  ): string | undefined {
    const constructorMatch = source.match(STATE_GRAPH_CONSTRUCTOR);
    if (constructorMatch?.[1] && constructorMatch[1] !== 'dict') {
      return constructorMatch[1];
    }

    if (stateType === 'typeddict') {
      return source.match(TYPED_DICT_CLASS)?.[1];
    }
    if (stateType === 'pydantic') {
      return source.match(PYDANTIC_CLASS)?.[1];
    }
    if (stateType === 'dataclass') {
      return source.match(DATACLASS_CLASS)?.[1];
    }

    return undefined;
  }

  private detectCheckpointing(source: string): boolean {
    return CHECKPOINT_PATTERNS.some(({ pattern }) => pattern.test(source));
  }

  private detectCheckpointBackend(
    source: string,
  ): LangGraphMetadata['checkpointBackend'] {
    for (const { pattern, backend } of CHECKPOINT_PATTERNS) {
      if (pattern.test(source)) {
        return backend;
      }
    }
    return 'unknown';
  }

  private countStateFields(
    source: string,
    stateType: LangGraphStateType,
    stateClassName?: string,
  ): number {
    if (!stateClassName) {
      return 4;
    }

    const classBodyRegex = new RegExp(
      `class\\s+${stateClassName}\\s*\\([^)]*\\)\\s*:[\\s\\S]*?(?=\\n(?:class|def|@)|$)`,
    );
    const classMatch = source.match(classBodyRegex);
    const body = classMatch?.[0] ?? source;

    const fieldMatches = body.match(/^\s+[A-Za-z_][A-Za-z0-9_]*\s*:/gm);
    if (fieldMatches) {
      return fieldMatches.length;
    }

    if (stateType === 'dict') {
      return 2;
    }

    return 4;
  }
}

export default LangGraphDetector;

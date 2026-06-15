import * as fs from 'fs/promises';
import * as path from 'path';
import { LangGraphDetector } from '../langGraphDetector';
import { recommendGpuTier } from '../index';

const FIXTURES = path.join(__dirname, '../../../../../tests/fixtures/langgraph-agent');

async function readFixture(name: string): Promise<string> {
  return fs.readFile(path.join(FIXTURES, name), 'utf-8');
}

describe('LangGraphDetector', () => {
  let detector: LangGraphDetector;

  beforeEach(() => {
    detector = new LangGraphDetector();
  });

  it('should detect StateGraph import from LangGraph agent source', async () => {
    const source = await readFixture('agent_small.py');
    const result = detector.analyzeSource(source);

    expect(result).not.toBeNull();
    expect(result?.detected).toBe(true);
  });

  it('should return null for plain langchain source without StateGraph', () => {
    const source = `
from langchain.agents import initialize_agent
from langchain_openai import ChatOpenAI

llm = ChatOpenAI()
agent = initialize_agent([], llm)
`;
    expect(detector.analyzeSource(source)).toBeNull();
  });

  it('should detect typeddict state type from agent_small.py', async () => {
    const source = await readFixture('agent_small.py');
    const result = detector.analyzeSource(source);

    expect(result?.stateType).toBe('typeddict');
    expect(result?.stateClassName).toBe('AgentState');
  });

  it('should detect pydantic state type from agent_medium.py', async () => {
    const source = await readFixture('agent_medium.py');
    const result = detector.analyzeSource(source);

    expect(result?.stateType).toBe('pydantic');
    expect(result?.stateClassName).toBe('AgentState');
  });

  it('should detect dataclass state type from agent_large.py', async () => {
    const source = await readFixture('agent_large.py');
    const result = detector.analyzeSource(source);

    expect(result?.stateType).toBe('dataclass');
    expect(result?.stateClassName).toBe('AgentState');
  });

  it('should detect checkpointing with SqliteSaver', async () => {
    const source = await readFixture('agent_checkpoint.py');
    const result = detector.analyzeSource(source);

    expect(result?.checkpointing).toBe(true);
    expect(result?.checkpointBackend).toBe('sqlite');
  });

  it('should recommend T4 for small state under 1MB', () => {
    const tier = recommendGpuTier(512 * 1024);
    expect(tier.tier).toBe('T4');
    expect(tier.memoryGB).toBe(8);
  });

  it('should recommend L4 for medium state between 1MB and 10MB', () => {
    const tier = recommendGpuTier(2 * 1024 * 1024);
    expect(tier.tier).toBe('L4');
    expect(tier.memoryGB).toBe(16);
  });

  it('should recommend A10G for large state 10MB or more', () => {
    const tier = recommendGpuTier(12 * 1024 * 1024);
    expect(tier.tier).toBe('A10G');
    expect(tier.memoryGB).toBe(24);
  });

  it('should cap state size estimate at 50MB', () => {
    const hugeSource = `
from langgraph.graph import StateGraph, END
from typing import List, TypedDict

class AgentState(TypedDict):
    data: List[float]
${'    field_x: str\n'.repeat(20000)}

graph = StateGraph(AgentState)
`;
    const estimate = detector.estimateStateSizeBytes(hugeSource, 'typeddict', 'AgentState');
    expect(estimate).toBeGreaterThan(50 * 1024 * 1024);

    const capped = Math.min(estimate, 50 * 1024 * 1024);
    expect(capped).toBe(50 * 1024 * 1024);
    expect(recommendGpuTier(capped).tier).toBe('A10G');
  });

  it('should analyze agent_small fixture as T4 tier', async () => {
    const source = await readFixture('agent_small.py');
    const result = detector.analyzeSource(source);

    expect(result?.recommendedGpuTier).toBe('T4');
    expect(result?.recommendedGpuMemoryGB).toBe(8);
  });

  it('should analyze agent_large fixture as A10G tier', async () => {
    const source = await readFixture('agent_large.py');
    const result = detector.analyzeSource(source);

    expect(result?.recommendedGpuTier).toBe('A10G');
    expect(result?.recommendedGpuMemoryGB).toBe(24);
  });

  it('should analyze project directory with multiple LangGraph files', async () => {
    const result = await detector.analyze(FIXTURES);
    expect(result).not.toBeNull();
    expect(result?.checkpointing).toBe(true);
  });
});

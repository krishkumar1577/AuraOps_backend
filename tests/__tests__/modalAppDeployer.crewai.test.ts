import { ModalAppDeployer } from '../../src/services/orchestration/modalAppDeployer';
import type { BlueprintJSON } from '../../src/types/blueprint.types';

const baseBlueprint = (): BlueprintJSON =>
  ({
    id: 'bp-test',
    timestamp: '2026-06-18T00:00:00.000Z',
    framework: {
      framework: 'crewai',
      version: '0.11.2',
      cudaVersion: '12.1',
      pythonVersion: '3.11',
      primaryUse: 'agentic',
      crewAI: {
        detected: true,
        agentCount: 5,
        totalToolCount: 10,
        agents: [
          { name: 'researcher', toolCount: 2 },
          { name: 'analyst', toolCount: 2 },
          { name: 'engineer', toolCount: 2 },
          { name: 'reviewer', toolCount: 1 },
          { name: 'writer', toolCount: 3 },
        ],
        memoryType: 'long_term',
        hasCustomCrewSubclass: false,
        recommendedGpuTier: 'L4',
        recommendedGpuMemoryGB: 16,
        requiresHumanReview: false,
      },
    },
    dependencyLock: { crewai: '0.11.2', 'langchain-openai': '0.0.5' },
    systemRequirements: {
      pythonVersion: '3.11',
      cudaVersion: '12.1',
      cuDNNVersion: '8.9',
    },
    deploymentConfig: { gpuMemoryGB: 16 },
  }) as unknown as BlueprintJSON;

describe('ModalAppDeployer — CrewAI integration', () => {
  it('emits a load() block that pre-compiles the crewai LLM and memory', () => {
    const app = ModalAppDeployer.generateModalApp(baseBlueprint(), 'deploy-1');
    expect(app).toContain("framework == \"crewai\"");
    expect(app).toContain("self.crew");
    expect(app).toContain("self.crew_agents");
    // Pre-compile happens in load(), not in the first invoke.
    expect(app).toContain("✓ CrewAI pre-compiled at load()");
    expect(app).toContain("LongTermMemory");
  });

  it('threads agent count and total tool count into the load() log line', () => {
    const app = ModalAppDeployer.generateModalApp(baseBlueprint(), 'deploy-2');
    expect(app).toContain("5 agents");
    expect(app).toContain("10 tools");
  });

  it('falls back to no memory when memoryType is "none"', () => {
    const bp = baseBlueprint();
    bp.framework.crewAI!.memoryType = 'none';
    const app = ModalAppDeployer.generateModalApp(bp, 'deploy-3');
    expect(app).toContain("memory = None");
    expect(app).toContain("memory=none");
  });

  it('supports short_term and entity memory types', () => {
    const bp = baseBlueprint();
    bp.framework.crewAI!.memoryType = 'short_term';
    expect(ModalAppDeployer.generateModalApp(bp, 'd-st')).toContain('ShortTermMemory');

    bp.framework.crewAI!.memoryType = 'entity';
    expect(ModalAppDeployer.generateModalApp(bp, 'd-ent')).toContain('EntityMemory');
  });

  it('includes crewai in the supported-frameworks error message', () => {
    const app = ModalAppDeployer.generateModalApp(baseBlueprint(), 'deploy-4');
    expect(app).toMatch(/Supported: langchain, langgraph, crewai/);
  });
});

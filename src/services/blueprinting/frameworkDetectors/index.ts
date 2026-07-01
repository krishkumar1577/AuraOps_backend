export { LangGraphDetector } from './langGraphDetector';
export { CrewAIDetector } from './crewaiDetector';
export { scanPythonFiles, readPythonSources } from './pythonSourceScanner';

import { LangGraphDetector } from './langGraphDetector';
import { CrewAIDetector } from './crewaiDetector';

export function recommendGpuTier(
  estimatedStateSizeBytes: number,
): ReturnType<LangGraphDetector['recommendGpuTier']> {
  return new LangGraphDetector().recommendGpuTier(estimatedStateSizeBytes);
}

export function recommendCrewAIGpuTier(
  agentCount: number,
  totalToolCount: number,
): ReturnType<CrewAIDetector['recommendGpuTier']> {
  return new CrewAIDetector().recommendGpuTier(agentCount, totalToolCount);
}

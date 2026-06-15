export { LangGraphDetector } from './langGraphDetector';
export { scanPythonFiles, readPythonSources } from './pythonSourceScanner';

import { LangGraphDetector } from './langGraphDetector';

export function recommendGpuTier(
  estimatedStateSizeBytes: number,
): ReturnType<LangGraphDetector['recommendGpuTier']> {
  return new LangGraphDetector().recommendGpuTier(estimatedStateSizeBytes);
}

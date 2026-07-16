import { Command } from 'commander';
import { resolveApiUrl } from './utils';
import * as ui from './utils';

export const terminateCommand = new Command('terminate')
  .description('Stop a running deployment and free GPU resources')
  .argument('<deploymentId>', 'Deployment ID to terminate')
  .option('--force', 'Skip confirmation prompt')
  .action(async (deploymentId: string, options: { force?: boolean }) => {
    try {
      if (!deploymentId.match(/^[a-f0-9-]+$/)) {
        ui.fail('Invalid deployment ID format');
        process.exit(1);
      }

      const apiUrl = resolveApiUrl();

      if (!options.force) {
        ui.info(`Terminating deployment: ${deploymentId}`);
        ui.info('This will stop the Modal app and free GPU resources.');
      }

      const headers = await ui.resolveAuthHeaders();
      const start = Date.now();
      const response = await fetch(
        `${apiUrl}/api/v1/deployment/${deploymentId}/stop-modal`,
        {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
        },
      );

      const duration = Date.now() - start;

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        if (response.status === 404) {
          ui.fail(`Deployment not found: ${deploymentId}`);
        } else {
          ui.fail(`Failed to terminate: ${(error as Record<string, unknown>).message || response.statusText}`);
        }
        process.exit(1);
      }

      const result = await response.json();

      ui.success(`✓ Deployment terminated in ${duration}ms`);
      ui.label('Deployment ID', String((result as Record<string, unknown>).deploymentId));
      ui.label('Status', String((result as Record<string, unknown>).status));

      if ((result as Record<string, unknown>).modal_app_name) {
        ui.label('Modal app stopped', String((result as Record<string, unknown>).modal_app_name));
      }

      ui.info('GPU resources freed and billing stopped.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ui.fail(`Termination failed: ${message}`);
      process.exit(1);
    }
  });

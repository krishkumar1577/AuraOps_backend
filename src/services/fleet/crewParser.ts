import { readFile } from 'fs/promises';
import YAML from 'yaml';
import { z } from 'zod';
import { DeploymentError } from '../../utils/errors';

const CrewAgentSchema = z.object({
  name: z.string().min(1, 'Agent name required'),
  role: z.string().optional(),
  goal: z.string().optional(),
  blueprint: z.string().optional(),
});

const CrewTaskSchema = z.object({
  description: z.string().min(1, 'Task description required'),
  agent: z.string().min(1, 'Task agent reference required'),
});

const CrewYamlSchema = z.object({
  name: z.string().min(1, 'Crew name required'),
  agents: z.array(CrewAgentSchema).min(1, 'At least one agent required'),
  tasks: z.array(CrewTaskSchema).min(1, 'At least one task required'),
});

export type CrewAgent = z.infer<typeof CrewAgentSchema>;
export type CrewTask = z.infer<typeof CrewTaskSchema>;
export type CrewDefinition = z.infer<typeof CrewYamlSchema>;

export class CrewParser {
  parseContent(content: string): CrewDefinition {
    try {
      const parsed: unknown = YAML.parse(content);
      return CrewYamlSchema.parse(parsed);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new DeploymentError('Invalid crew.yaml format', {
          cause: error,
          details: error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
        });
      }
      throw new DeploymentError('Failed to parse crew.yaml', { cause: error });
    }
  }

  async parse(filePath: string): Promise<CrewDefinition> {
    try {
      const content = await readFile(filePath, 'utf-8');
      return this.parseContent(content);
    } catch (error) {
      if (error instanceof DeploymentError) {
        throw error;
      }
      throw new DeploymentError(`Failed to read crew file: ${filePath}`, { cause: error });
    }
  }
}

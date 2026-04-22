import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ManifestParser, FrameworkDetector, BlueprintGenerator } from '../../services/blueprinting';
import { logger } from '../../utils/logger';
import { z } from 'zod';

const GenerateBlueprintSchema = z.object({
  projectPath: z.string().min(1),
});

export async function blueprintRoutes(fastify: FastifyInstance) {
  const parser = new ManifestParser();
  const detector = new FrameworkDetector();
  const generator = new BlueprintGenerator();

  fastify.post<{ Body: unknown }>(
    '/api/v1/blueprint/generate',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const startTime = Date.now();

      try {
        const validated = GenerateBlueprintSchema.parse(request.body);
        const { projectPath } = validated;

        const parseStart = Date.now();
        const manifest = await parser.parse(projectPath);
        const parseTime = Date.now() - parseStart;

        const detectStart = Date.now();
        const fingerprint = detector.detect(manifest);
        const detectTime = Date.now() - detectStart;

        const genStart = Date.now();
        const blueprint = generator.generate(fingerprint, manifest, projectPath);
        const genTime = Date.now() - genStart;

        logger.info(`Blueprint stored: ${blueprint.id}`);

        const totalTime = Date.now() - startTime;

        return reply.code(200).send({
          success: true,
          blueprint: {
            id: blueprint.id,
            framework: blueprint.framework.framework,
            frameworkVersion: blueprint.framework.version,
            baseImage: blueprint.systemRequirements.baseImageId,
            cudaVersion: blueprint.systemRequirements.cudaVersion,
            pythonVersion: blueprint.systemRequirements.pythonVersion,
            dependencyCount: Object.keys(blueprint.dependencyLock).length,
          },
          timing: {
            manifestParse: parseTime,
            frameworkDetect: detectTime,
            blueprintGenerate: genTime,
            total: totalTime,
          },
        });
      } catch (error) {
        const err = error as any;
        logger.error('Blueprint generation error:', err);
        return reply.code(400).send({
          success: false,
          error: err?.message || 'Unknown error',
        });
      }
    },
  );

  fastify.get<{ Params: unknown }>(
    '/api/v1/blueprint/:blueprintId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const params = request.params as any;
        const { blueprintId } = params;

        logger.info(`Retrieving blueprint: ${blueprintId}`);

        return reply.code(200).send({
          message: 'Blueprint retrieval not yet implemented',
          blueprintId,
        });
      } catch (error) {
        const err = error as any;
        logger.error('Blueprint retrieval error:', err);
        return reply.code(500).send({
          error: 'Failed to retrieve blueprint',
        });
      }
    },
  );
}

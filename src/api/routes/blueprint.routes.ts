import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ManifestParser, FrameworkDetector, BlueprintGenerator, LangGraphDetector } from '../../services/blueprinting';
import { logger } from '../../utils/logger';
import { z } from 'zod';

const GenerateBlueprintSchema = z.object({
  projectPath: z.string().min(1),
});

export async function blueprintRoutes(fastify: FastifyInstance) {
  const parser = new ManifestParser();
  const detector = new FrameworkDetector();
  const langGraphDetector = new LangGraphDetector();
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

        const langGraphAnalysis = await langGraphDetector.analyze(projectPath);

        const detectStart = Date.now();
        const fingerprint = detector.detect(manifest, langGraphAnalysis);
        const detectTime = Date.now() - detectStart;

        const genStart = Date.now();
        const blueprint = await generator.generate(fingerprint, manifest, projectPath);
        const genTime = Date.now() - genStart;

        logger.info(`Blueprint stored: ${blueprint.id}`);

        const totalTime = Date.now() - startTime;

        return reply.code(200).send({
          success: true,
          blueprint: {
            id: blueprint.id,
            framework: blueprint.framework.framework,
            frameworkVersion: blueprint.framework.version,
            langGraph: blueprint.framework.langGraph,
            gpuMemoryGB: blueprint.deploymentConfig.gpuMemoryGB,
            gpuTier: blueprint.framework.langGraph?.recommendedGpuTier,
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
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Blueprint generation error:', error);
        return reply.code(400).send({
          success: false,
          error: message,
        });
      }
    },
  );

  fastify.get<{ Params: { blueprintId: string } }>(
    '/api/v1/blueprint/:blueprintId',
    async (request, reply: FastifyReply) => {
      try {
        const { blueprintId } = request.params;

        logger.info(`Retrieving blueprint: ${blueprintId}`);

        return reply.code(200).send({
          message: 'Blueprint retrieval not yet implemented',
          blueprintId,
        });
      } catch (error) {
        logger.error('Blueprint retrieval error:', error);
        return reply.code(500).send({
          error: 'Failed to retrieve blueprint',
        });
      }
    },
  );
}

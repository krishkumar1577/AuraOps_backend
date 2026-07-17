import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../../services/auth/passwordService';
import { createUser, findByEmail } from '../../services/auth/userRepository';
import { AuthenticationError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { deployTelemetry } from '../../services/telemetry/deployTelemetry';

const RegisterSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const LoginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  const authRateLimit = {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
  };

  fastify.post<{ Body: unknown }>(
    '/api/v1/auth/register',
    authRateLimit,
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const start = Date.now();

      try {
        const { email, password } = RegisterSchema.parse(request.body);

        const passwordHash = await hashPassword(password);
        const user = await createUser(email, passwordHash);

        const token = fastify.jwt.sign(
          { sub: user.id, email: user.email },
          { expiresIn: '7d' },
        );

        logger.info(`User registered in ${Date.now() - start}ms: ${user.email}`);

        void deployTelemetry.trackContact(user.email, user.id);
        deployTelemetry.trackEventAsync({
          email: user.email,
          eventName: 'user_registered',
          properties: { userId: user.id },
        });

        return reply.code(201).send({
          success: true,
          token,
          user: {
            id: user.id,
            email: user.email,
            credits: user.credits,
            plan: user.plan,
          },
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            success: false,
            error: 'Validation failed',
            details: error.errors.map(e => ({
              field: e.path.join('.'),
              message: e.message,
            })),
          });
        }

        if (
          error instanceof Error &&
          'statusCode' in error &&
          (error as { statusCode: number }).statusCode === 409
        ) {
          return reply.code(409).send({
            success: false,
            error: error.message,
          });
        }

        const msg = error instanceof Error ? error.message : String(error);
        const causeRaw =
          error instanceof Error
            ? (error as Error & { cause?: unknown }).cause
            : undefined;
        const cause =
          causeRaw instanceof Error
            ? causeRaw.message
            : causeRaw != null
              ? String(causeRaw)
              : '';
        const full = `${msg} ${cause}`;
        logger.error(`Registration error: ${full}`);
        // Almost all register 500s in prod are Mongo connection/auth misconfig
        const dbDown =
          /mongo|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|authentication failed|bad auth|timed out|SSL|TLS|server selection|topology|SCRAM|querySrv/i.test(
            full,
          );
        return reply.code(dbDown ? 503 : 500).send({
          success: false,
          error: dbDown
            ? 'Database unavailable. Set a valid MONGODB_URI on Render (Atlas Network Access 0.0.0.0/0), then redeploy.'
            : `Registration failed: ${msg.slice(0, 160)}`,
        });
      }
    },
  );

  fastify.post<{ Body: unknown }>(
    '/api/v1/auth/login',
    authRateLimit,
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const start = Date.now();

      try {
        const { email, password } = LoginSchema.parse(request.body);

        const user = await findByEmail(email);
        if (!user) {
          throw new AuthenticationError();
        }

        const valid = await verifyPassword(password, user.passwordHash);
        if (!valid) {
          throw new AuthenticationError();
        }

        const token = fastify.jwt.sign(
          { sub: user._id.toHexString(), email: user.email },
          { expiresIn: '7d' },
        );

        logger.info(`User logged in (${Date.now() - start}ms): ${user.email}`);

        const { ensureUserBillingDefaults } = await import(
          '../../services/billing/billingRepository'
        );
        const billing = await ensureUserBillingDefaults(user._id.toHexString());

        return reply.code(200).send({
          success: true,
          token,
          user: {
            id: user._id.toHexString(),
            email: user.email,
            credits: billing.credits,
            plan: billing.plan,
          },
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            success: false,
            error: 'Validation failed',
            details: error.errors.map(e => ({
              field: e.path.join('.'),
              message: e.message,
            })),
          });
        }

        if (error instanceof AuthenticationError) {
          return reply.code(401).send({
            success: false,
            error: 'Invalid email or password',
          });
        }

        const msg = error instanceof Error ? error.message : String(error);
        const causeRaw =
          error instanceof Error
            ? (error as Error & { cause?: unknown }).cause
            : undefined;
        const cause =
          causeRaw instanceof Error
            ? causeRaw.message
            : causeRaw != null
              ? String(causeRaw)
              : '';
        const full = `${msg} ${cause}`;
        logger.error(`Login error: ${full}`);
        const dbDown =
          /mongo|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|authentication failed|bad auth|timed out|SSL|TLS|server selection|topology|SCRAM|querySrv/i.test(
            full,
          );
        return reply.code(dbDown ? 503 : 500).send({
          success: false,
          error: dbDown
            ? 'Database unavailable. Set a valid MONGODB_URI on Render (Atlas Network Access 0.0.0.0/0), then redeploy.'
            : `Login failed: ${msg.slice(0, 160)}`,
        });
      }
    },
  );

  logger.info('Auth routes registered');
}

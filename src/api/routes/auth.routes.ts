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
          user: { id: user.id, email: user.email },
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

        logger.error(`Registration error: ${error instanceof Error ? error.message : String(error)}`);
        return reply.code(500).send({
          success: false,
          error: 'Registration failed',
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

        return reply.code(200).send({
          success: true,
          token,
          user: { id: user._id.toHexString(), email: user.email },
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

        logger.error(`Login error: ${error instanceof Error ? error.message : String(error)}`);
        return reply.code(500).send({
          success: false,
          error: 'Login failed',
        });
      }
    },
  );

  logger.info('Auth routes registered');
}

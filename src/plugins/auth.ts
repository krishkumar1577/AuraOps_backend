import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import config from '../utils/config';

async function authPlugin(fastify: FastifyInstance): Promise<void> {
  await fastify.register(fastifyJwt, {
    secret: config.jwt_secret,
  });

  fastify.decorate(
    'authenticate',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        await request.jwtVerify();
      } catch (_err) {
        reply.code(401).send({
          success: false,
          error: 'Unauthorized',
        });
      }
    },
  );
}

export default fp(authPlugin, {
  name: 'auth-plugin',
});

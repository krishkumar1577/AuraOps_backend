import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { listPacks, creditsForHostedDeploy, FREE_SIGNUP_CREDITS, HOSTED_DEPLOY_CREDIT_COST } from '../../services/billing/plans';
import { getUserCredits } from '../../services/billing/billingRepository';
import { confirmPayment, createCheckoutOrder } from '../../services/billing/razorpayService';
import { logger } from '../../utils/logger';
import config from '../../utils/config';

function userIdFromRequest(request: FastifyRequest): string | null {
  const user = request.user as { sub?: string; id?: string } | undefined;
  return user?.sub || user?.id || null;
}

const CheckoutSchema = z.object({
  packId: z.enum(['starter', 'builder', 'scale']),
});

const VerifySchema = z.object({
  razorpay_order_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

export async function billingRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/v1/billing/plans — public pricing
   */
  fastify.get('/api/v1/billing/plans', async (_request, reply) => {
    return reply.send({
      success: true,
      currency: 'INR',
      freeSignupCredits: FREE_SIGNUP_CREDITS,
      hostedDeployCreditCost: HOSTED_DEPLOY_CREDIT_COST,
      note:
        'Local `auraops deploy` (your own Modal tokens) is free. Credits only apply to hosted --server deploys that run on platform GPU.',
      packs: listPacks().map((p) => ({
        ...p,
        amountPaise: p.priceInr * 100,
        approxHostedDeploys: Math.floor(p.credits / HOSTED_DEPLOY_CREDIT_COST),
      })),
      razorpayEnabled: Boolean(config.razorpay_key_id && config.razorpay_key_secret),
    });
  });

  /**
   * GET /api/v1/billing/me — balance (auth)
   */
  fastify.get('/api/v1/billing/me', async (request, reply) => {
    const userId = userIdFromRequest(request);
    if (!userId) {
      return reply.code(401).send({ success: false, error: 'Unauthorized' });
    }

    try {
      const billing = await getUserCredits(userId);
      return reply.send({
        success: true,
        ...billing,
        hostedDeployCreditCost: HOSTED_DEPLOY_CREDIT_COST,
        creditsForOneGpuDeploy: creditsForHostedDeploy(1),
      });
    } catch (error) {
      logger.error(`billing/me: ${error instanceof Error ? error.message : String(error)}`);
      return reply.code(500).send({ success: false, error: 'Failed to load billing' });
    }
  });

  /**
   * POST /api/v1/billing/checkout — create Razorpay order (auth)
   */
  fastify.post<{ Body: unknown }>('/api/v1/billing/checkout', async (request, reply) => {
    const userId = userIdFromRequest(request);
    const email = (request.user as { email?: string } | undefined)?.email || '';
    if (!userId) {
      return reply.code(401).send({ success: false, error: 'Unauthorized' });
    }

    try {
      const { packId } = CheckoutSchema.parse(request.body);
      const order = await createCheckoutOrder({ userId, email, packId });

      return reply.code(201).send({
        success: true,
        keyId: order.keyId,
        orderId: order.orderId,
        amount: order.amountPaise,
        currency: order.currency,
        pack: order.pack,
        // Client opens Razorpay Checkout with these fields
        checkout: {
          key: order.keyId,
          amount: order.amountPaise,
          currency: order.currency,
          order_id: order.orderId,
          name: 'AuraOps',
          description: `${order.pack.name}: ${order.pack.credits} credits`,
          prefill: { email },
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ success: false, error: 'Invalid packId' });
      }
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`billing/checkout: ${msg}`);
      const status = msg.includes('not configured') ? 503 : 500;
      return reply.code(status).send({ success: false, error: msg });
    }
  });

  /**
   * POST /api/v1/billing/verify — after Razorpay Checkout success (auth)
   */
  fastify.post<{ Body: unknown }>('/api/v1/billing/verify', async (request, reply) => {
    const userId = userIdFromRequest(request);
    if (!userId) {
      return reply.code(401).send({ success: false, error: 'Unauthorized' });
    }

    try {
      const body = VerifySchema.parse(request.body);

      const { findOrderByRazorpayId } = await import('../../services/billing/billingRepository');
      const order = await findOrderByRazorpayId(body.razorpay_order_id);
      if (!order) {
        return reply.code(404).send({ success: false, error: 'Order not found' });
      }
      if (order.userId !== userId) {
        return reply.code(403).send({ success: false, error: 'Order does not belong to this user' });
      }

      const result = await confirmPayment({
        orderId: body.razorpay_order_id,
        paymentId: body.razorpay_payment_id,
        signature: body.razorpay_signature,
      });

      return reply.send({
        success: true,
        creditsAdded: result.credits,
        remaining: result.remaining,
        alreadyPaid: result.alreadyPaid,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ success: false, error: 'Invalid payment payload' });
      }
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`billing/verify: ${msg}`);
      return reply.code(400).send({ success: false, error: msg });
    }
  });
}

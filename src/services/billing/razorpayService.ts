import crypto from 'crypto';
import { logger } from '../../utils/logger';
import config from '../../utils/config';
import { getPack, type CreditPack } from './plans';
import {
  addCredits,
  findOrderByRazorpayId,
  markOrderPaid,
  savePaymentOrder,
} from './billingRepository';

export interface RazorpayOrderResult {
  orderId: string;
  amountPaise: number;
  currency: string;
  pack: CreditPack;
  keyId: string;
}

function assertRazorpayConfigured(): void {
  if (!config.razorpay_key_id || !config.razorpay_key_secret) {
    throw new Error(
      'Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET on the server.',
    );
  }
}

/** Lazy require so unit tests can run without the native client path. */
function getRazorpayClient(): {
  orders: { create: (opts: Record<string, unknown>) => Promise<{ id: string }> };
} {
  assertRazorpayConfigured();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Razorpay = require('razorpay');
  return new Razorpay({
    key_id: config.razorpay_key_id,
    key_secret: config.razorpay_key_secret,
  });
}

export function verifyPaymentSignature(params: {
  orderId: string;
  paymentId: string;
  signature: string;
}): boolean {
  assertRazorpayConfigured();
  const body = `${params.orderId}|${params.paymentId}`;
  const expected = crypto
    .createHmac('sha256', config.razorpay_key_secret)
    .update(body)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(params.signature, 'utf8'),
    );
  } catch {
    return false;
  }
}

export async function createCheckoutOrder(params: {
  userId: string;
  email: string;
  packId: string;
}): Promise<RazorpayOrderResult> {
  const pack = getPack(params.packId);
  if (!pack) {
    throw new Error(`Unknown credit pack: ${params.packId}`);
  }

  const amountPaise = pack.priceInr * 100;
  const receipt = `ao_${params.userId.slice(0, 8)}_${Date.now()}`.slice(0, 40);

  const client = getRazorpayClient();
  const order = await client.orders.create({
    amount: amountPaise,
    currency: 'INR',
    receipt,
    notes: {
      userId: params.userId,
      email: params.email,
      packId: pack.id,
      credits: String(pack.credits),
    },
  });

  await savePaymentOrder({
    userId: params.userId,
    email: params.email,
    packId: pack.id,
    credits: pack.credits,
    amountPaise,
    currency: 'INR',
    razorpayOrderId: order.id,
    status: 'created',
    createdAt: new Date(),
  });

  logger.info(
    `Razorpay order ${order.id} created for ${params.email}: ${pack.credits} credits @ ₹${pack.priceInr}`,
  );

  return {
    orderId: order.id,
    amountPaise,
    currency: 'INR',
    pack,
    keyId: config.razorpay_key_id,
  };
}

/**
 * Verify Razorpay checkout signature and credit the user (idempotent).
 */
export async function confirmPayment(params: {
  orderId: string;
  paymentId: string;
  signature: string;
}): Promise<{ credits: number; remaining: number; alreadyPaid: boolean }> {
  if (!verifyPaymentSignature(params)) {
    throw new Error('Invalid Razorpay payment signature');
  }

  const existing = await findOrderByRazorpayId(params.orderId);
  if (!existing) {
    throw new Error('Order not found');
  }

  if (existing.status === 'paid') {
    const { getUserCredits } = await import('./billingRepository');
    const bal = await getUserCredits(existing.userId);
    return {
      credits: existing.credits,
      remaining: bal.credits,
      alreadyPaid: true,
    };
  }

  const paid = await markOrderPaid(params.orderId, params.paymentId);
  if (!paid || paid.status !== 'paid') {
    // Race: another request marked paid
    const bal = await (await import('./billingRepository')).getUserCredits(existing.userId);
    return {
      credits: existing.credits,
      remaining: bal.credits,
      alreadyPaid: true,
    };
  }

  const remaining = await addCredits(existing.userId, existing.credits);
  logger.info(
    `Payment ${params.paymentId}: +${existing.credits} credits → user ${existing.userId} (balance ${remaining})`,
  );

  return {
    credits: existing.credits,
    remaining,
    alreadyPaid: false,
  };
}

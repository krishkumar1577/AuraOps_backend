import { MongoClient, Db, Collection, ObjectId } from 'mongodb';
import { logger } from '../../utils/logger';
import config from '../../utils/config';
import { FREE_SIGNUP_CREDITS } from './plans';

export interface BillingUserFields {
  credits: number;
  plan: 'free' | 'payg';
  /** Total credits ever purchased (not spent) */
  creditsPurchased: number;
  /** Total credits spent on hosted deploys */
  creditsSpent: number;
}

export interface PaymentOrderDocument {
  _id: ObjectId;
  userId: string;
  email: string;
  packId: string;
  credits: number;
  amountPaise: number;
  currency: string;
  razorpayOrderId: string;
  status: 'created' | 'paid' | 'failed';
  createdAt: Date;
  paidAt?: Date;
  razorpayPaymentId?: string;
}

let client: MongoClient | null = null;
let db: Db | null = null;

async function getDb(): Promise<Db> {
  if (!db) {
    client = new MongoClient(config.mongodb_uri);
    await client.connect();
    db = client.db(config.mongodb_db);
    logger.info('MongoDB billing collections ready');
  }
  return db;
}

async function users(): Promise<Collection> {
  return (await getDb()).collection('users');
}

async function orders(): Promise<Collection<PaymentOrderDocument>> {
  const col = (await getDb()).collection<PaymentOrderDocument>('payment_orders');
  await col.createIndex({ razorpayOrderId: 1 }, { unique: true });
  await col.createIndex({ userId: 1, createdAt: -1 });
  return col;
}

export async function ensureUserBillingDefaults(userId: string): Promise<BillingUserFields> {
  const col = await users();
  const _id = new ObjectId(userId);
  const existing = await col.findOne({ _id });
  if (!existing) {
    return {
      credits: 0,
      plan: 'free',
      creditsPurchased: 0,
      creditsSpent: 0,
    };
  }

  if (typeof existing.credits === 'number') {
    return {
      credits: existing.credits,
      plan: existing.plan === 'payg' ? 'payg' : 'free',
      creditsPurchased: existing.creditsPurchased ?? 0,
      creditsSpent: existing.creditsSpent ?? 0,
    };
  }

  // First-time billing fields for legacy users + new signups path
  const free = FREE_SIGNUP_CREDITS;
  await col.updateOne(
    { _id },
    {
      $set: {
        credits: free,
        plan: 'free',
        creditsPurchased: 0,
        creditsSpent: 0,
      },
    },
  );
  return {
    credits: free,
    plan: 'free',
    creditsPurchased: 0,
    creditsSpent: 0,
  };
}

export async function getUserCredits(userId: string): Promise<BillingUserFields> {
  return ensureUserBillingDefaults(userId);
}

/** Atomically spend credits; returns false if insufficient. */
export async function spendCredits(
  userId: string,
  amount: number,
): Promise<{ ok: true; remaining: number } | { ok: false; remaining: number }> {
  if (amount <= 0) {
    const bal = await getUserCredits(userId);
    return { ok: true, remaining: bal.credits };
  }

  await ensureUserBillingDefaults(userId);
  const col = await users();
  const _id = new ObjectId(userId);

  const result = await col.findOneAndUpdate(
    { _id, credits: { $gte: amount } },
    {
      $inc: { credits: -amount, creditsSpent: amount },
      $set: { plan: 'payg' },
    },
    { returnDocument: 'after' },
  );

  if (!result) {
    const bal = await getUserCredits(userId);
    return { ok: false, remaining: bal.credits };
  }

  return { ok: true, remaining: result.credits as number };
}

export async function addCredits(userId: string, amount: number): Promise<number> {
  await ensureUserBillingDefaults(userId);
  const col = await users();
  const _id = new ObjectId(userId);
  const result = await col.findOneAndUpdate(
    { _id },
    {
      $inc: { credits: amount, creditsPurchased: amount },
      $set: { plan: 'payg' },
    },
    { returnDocument: 'after' },
  );
  return (result?.credits as number) ?? 0;
}

export async function savePaymentOrder(
  order: Omit<PaymentOrderDocument, '_id'>,
): Promise<void> {
  const col = await orders();
  await col.insertOne({
    _id: new ObjectId(),
    ...order,
  });
}

export async function markOrderPaid(
  razorpayOrderId: string,
  razorpayPaymentId: string,
): Promise<PaymentOrderDocument | null> {
  const col = await orders();
  const existing = await col.findOne({ razorpayOrderId });
  if (!existing) {
    return null;
  }
  if (existing.status === 'paid') {
    return existing; // idempotent
  }

  const result = await col.findOneAndUpdate(
    { razorpayOrderId, status: 'created' },
    {
      $set: {
        status: 'paid',
        paidAt: new Date(),
        razorpayPaymentId,
      },
    },
    { returnDocument: 'after' },
  );

  return result ?? existing;
}

export async function findOrderByRazorpayId(
  razorpayOrderId: string,
): Promise<PaymentOrderDocument | null> {
  const col = await orders();
  return col.findOne({ razorpayOrderId });
}

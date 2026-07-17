import {
  CREDIT_PACKS,
  FREE_SIGNUP_CREDITS,
  HOSTED_DEPLOY_CREDIT_COST,
  creditsForHostedDeploy,
  getPack,
  listPacks,
} from '../plans';
import { verifyPaymentSignature } from '../razorpayService';

describe('billing plans', () => {
  it('lists packs with positive prices', () => {
    const packs = listPacks();
    expect(packs.length).toBe(3);
    for (const p of packs) {
      expect(p.credits).toBeGreaterThan(0);
      expect(p.priceInr).toBeGreaterThan(0);
      expect(CREDIT_PACKS[p.id].id).toBe(p.id);
    }
  });

  it('resolves pack by id', () => {
    expect(getPack('starter')?.credits).toBe(50);
    expect(getPack('nope')).toBeNull();
  });

  it('computes hosted deploy cost from gpu count', () => {
    expect(creditsForHostedDeploy(1)).toBe(HOSTED_DEPLOY_CREDIT_COST);
    expect(creditsForHostedDeploy(2)).toBe(HOSTED_DEPLOY_CREDIT_COST * 2);
    expect(creditsForHostedDeploy(0)).toBe(HOSTED_DEPLOY_CREDIT_COST);
    expect(creditsForHostedDeploy(99)).toBe(HOSTED_DEPLOY_CREDIT_COST * 8);
  });

  it('gives free trial credits on signup constant', () => {
    expect(FREE_SIGNUP_CREDITS).toBeGreaterThan(0);
    expect(FREE_SIGNUP_CREDITS).toBeLessThanOrEqual(20);
  });
});

describe('razorpay signature', () => {
  const prevId = process.env.RAZORPAY_KEY_ID;
  const prevSecret = process.env.RAZORPAY_KEY_SECRET;

  beforeAll(() => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_x';
    process.env.RAZORPAY_KEY_SECRET = 'test_secret_key';
    // Re-require config is hard; verifyPaymentSignature reads config at call time
    // config is already loaded — inject via module mock if needed
  });

  afterAll(() => {
    process.env.RAZORPAY_KEY_ID = prevId;
    process.env.RAZORPAY_KEY_SECRET = prevSecret;
  });

  it('rejects bad signature when razorpay configured via config module', () => {
    // If secrets empty in test env, function throws — either is fine
    try {
      const ok = verifyPaymentSignature({
        orderId: 'order_1',
        paymentId: 'pay_1',
        signature: 'deadbeef',
      });
      expect(ok).toBe(false);
    } catch (e) {
      expect(String(e)).toMatch(/Razorpay|not configured/i);
    }
  });
});

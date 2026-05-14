import { hashPassword, verifyPassword } from '../passwordService';

describe('PasswordService', () => {
  it('should hash and verify a password', async () => {
    const password = 'securepass123';
    const hashed = await hashPassword(password);

    expect(hashed).toContain(':');
    expect(await verifyPassword(password, hashed)).toBe(true);
  });

  it('should reject wrong password', async () => {
    const hashed = await hashPassword('correctpassword');
    expect(await verifyPassword('wrongpassword', hashed)).toBe(false);
  });

  it('should produce different hashes for same password', async () => {
    const password = 'samepassword';
    const hash1 = await hashPassword(password);
    const hash2 = await hashPassword(password);

    expect(hash1).not.toBe(hash2);
    expect(await verifyPassword(password, hash1)).toBe(true);
    expect(await verifyPassword(password, hash2)).toBe(true);
  });

  it('should reject malformed stored hash', async () => {
    expect(await verifyPassword('any', 'nocolon')).toBe(false);
    expect(await verifyPassword('any', '')).toBe(false);
  });
});

import { scrypt, randomBytes, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);
const SALT_LENGTH = 32;
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH).toString('hex');
  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;

  const storedKey = Buffer.from(hash, 'hex');
  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return timingSafeEqual(storedKey, derived);
}

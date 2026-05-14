import { MongoClient, Db, Collection, ObjectId } from 'mongodb';
import { ConflictError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import config from '../../utils/config';

export interface UserDocument {
  _id: ObjectId;
  email: string;
  passwordHash: string;
  createdAt: Date;
}

export interface UserPublic {
  id: string;
  email: string;
  createdAt: Date;
}

let client: MongoClient | null = null;
let db: Db | null = null;

async function getCollection(): Promise<Collection<UserDocument>> {
  if (!db) {
    client = new MongoClient(config.mongodb_uri);
    await client.connect();
    db = client.db(config.mongodb_db);
    const collection = db.collection<UserDocument>('users');
    await collection.createIndex({ email: 1 }, { unique: true });
    logger.info('MongoDB users collection initialized');
  }
  return db.collection<UserDocument>('users');
}

export async function createUser(
  email: string,
  passwordHash: string,
): Promise<UserPublic> {
  const collection = await getCollection();
  const now = new Date();

  try {
    const result = await collection.insertOne({
      _id: new ObjectId(),
      email: email.toLowerCase().trim(),
      passwordHash,
      createdAt: now,
    });

    return {
      id: result.insertedId.toHexString(),
      email: email.toLowerCase().trim(),
      createdAt: now,
    };
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as { code: number }).code === 11000
    ) {
      throw new ConflictError(`Email already registered: ${email}`);
    }
    throw error;
  }
}

export async function findByEmail(
  email: string,
): Promise<UserDocument | null> {
  const collection = await getCollection();
  return collection.findOne({ email: email.toLowerCase().trim() });
}

export async function findById(id: string): Promise<UserDocument | null> {
  const collection = await getCollection();
  try {
    return collection.findOne({ _id: new ObjectId(id) });
  } catch {
    return null;
  }
}

export async function closeConnection(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

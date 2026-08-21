import crypto from "crypto";
import { prisma } from "../db/client";

/**
 * API key auth: keys are shown to the tenant ONCE at creation time, then only
 * the SHA-256 hash is stored. Format: "ih_live_<32 random bytes, hex>".
 * We never store or log the plaintext key after generation.
 */

const KEY_PREFIX = "ih_live_";

export function generateApiKey(): { plaintext: string; hash: string } {
  const raw = crypto.randomBytes(32).toString("hex");
  const plaintext = `${KEY_PREFIX}${raw}`;
  const hash = hashKey(plaintext);
  return { plaintext, hash };
}

export function hashKey(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

export async function resolveTenantFromApiKey(plaintextKey: string): Promise<{ tenantId: string } | null> {
  if (!plaintextKey.startsWith(KEY_PREFIX)) return null;

  const hash = hashKey(plaintextKey);
  const apiKey = await prisma.apiKey.findUnique({ where: { keyHash: hash } });

  if (!apiKey || apiKey.revokedAt) return null;

  return { tenantId: apiKey.tenantId };
}

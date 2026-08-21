import crypto from "crypto";
import { envelopeEncrypt, envelopeDecrypt, isKmsConfigured } from "./kms";
import { logger } from "../config/logger";

/**
 * Encrypts/decrypts per-tenant connection credentials (and backup S3 creds)
 * before they touch the DB.
 *
 * Two backends, selected automatically:
 *   - KMS envelope encryption (see kms.ts) when KMS_KEY_ID is set — the real
 *     master key never leaves AWS KMS. Use this in production.
 *   - A static local AES-256-GCM key (CREDENTIALS_MASTER_KEY) when it isn't
 *     — simpler for local dev, where nobody wants to provision an AWS KMS
 *     key just to run `npm run dev`.
 *
 * Every stored payload is prefixed with a 1-byte format tag, so decryption
 * always works regardless of which backend is *currently* configured —
 * switching KMS_KEY_ID on/off doesn't break reading old rows, it only
 * changes which backend NEW writes use. Existing static-key rows keep
 * decrypting fine after you turn KMS on; run the migration script
 * (`npm run migrate-credentials-to-kms`) to proactively re-encrypt them
 * under KMS instead of leaving them on the old backend indefinitely.
 */

const FORMAT_STATIC_KEY = 0x01;
const FORMAT_KMS_ENVELOPE = 0x02;

let warnedNoKmsInProd = false;
function warnIfNoKmsInProduction() {
  if (!isKmsConfigured() && process.env.NODE_ENV === "production" && !warnedNoKmsInProd) {
    warnedNoKmsInProd = true;
    logger.warn(
      "KMS_KEY_ID is not set in production — credentials are being encrypted with a static local key instead of AWS KMS. See README 'Credential encryption (KMS)'."
    );
  }
}

function getStaticMasterKey(): Buffer {
  const key = process.env.CREDENTIALS_MASTER_KEY;
  if (!key) throw new Error("CREDENTIALS_MASTER_KEY env var is not set");
  const buf = Buffer.from(key, "base64");
  if (buf.length !== 32) {
    throw new Error("CREDENTIALS_MASTER_KEY must decode to exactly 32 bytes (base64-encoded)");
  }
  return buf;
}

function encryptWithStaticKey(plaintext: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getStaticMasterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

function decryptWithStaticKey(payload: Buffer): Buffer {
  const iv = payload.subarray(0, 12);
  const authTag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", getStaticMasterKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export async function encryptCredentials(plainObj: Record<string, unknown>): Promise<string> {
  warnIfNoKmsInProduction();
  const plaintext = Buffer.from(JSON.stringify(plainObj), "utf8");

  if (isKmsConfigured()) {
    const body = await envelopeEncrypt(plaintext);
    return Buffer.concat([Buffer.from([FORMAT_KMS_ENVELOPE]), body]).toString("base64");
  }

  const body = encryptWithStaticKey(plaintext);
  return Buffer.concat([Buffer.from([FORMAT_STATIC_KEY]), body]).toString("base64");
}

export async function decryptCredentials(payload: string): Promise<Record<string, unknown>> {
  const buf = Buffer.from(payload, "base64");
  const format = buf[0];
  const body = buf.subarray(1);

  let plaintext: Buffer;
  if (format === FORMAT_KMS_ENVELOPE) {
    plaintext = await envelopeDecrypt(body);
  } else if (format === FORMAT_STATIC_KEY) {
    plaintext = decryptWithStaticKey(body);
  } else {
    throw new Error(
      `Unrecognized credential encryption format byte (${format}). This payload may predate the versioned format — ` +
        `run the migration script (npm run migrate-credentials-to-kms) or check for data corruption.`
    );
  }

  return JSON.parse(plaintext.toString("utf8"));
}

/**
 * Decrypts payloads written by the very first version of this file, which
 * had NO format byte — just iv(12) + authTag(16) + ciphertext, always
 * static-key AES-GCM. Exists ONLY for the one-time migration script; do not
 * call this from application code, since it can't tell a legitimate
 * legacy payload from garbage — it just assumes the format is legacy.
 */
export function decryptLegacyUnversionedPayload(payload: string): Record<string, unknown> {
  const buf = Buffer.from(payload, "base64");
  const plaintext = decryptWithStaticKey(buf);
  return JSON.parse(plaintext.toString("utf8"));
}

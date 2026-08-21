import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from "@aws-sdk/client-kms";
import crypto from "crypto";

/**
 * Envelope encryption via AWS KMS: the actual master key (the KMS CMK)
 * never leaves AWS — it's used only to wrap/unwrap a fresh 256-bit data
 * key (DEK) per encryption call. The DEK does the real AES-256-GCM work
 * locally, then gets zeroed out of process memory immediately after use.
 * Only the KMS-wrapped DEK is ever persisted (alongside the ciphertext),
 * so a database leak alone can't decrypt anything without also compromising
 * the AWS IAM credentials that can call kms:Decrypt on this specific key.
 *
 * Credentials for the AWS SDK come from the standard env vars
 * (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION) via the default
 * provider chain — nothing AWS-specific needs to be passed explicitly here.
 */

let cachedClient: KMSClient | null = null;
function client(): KMSClient {
  if (!cachedClient) {
    cachedClient = new KMSClient({ region: process.env.AWS_REGION || "us-east-1" });
  }
  return cachedClient;
}

export function isKmsConfigured(): boolean {
  return Boolean(process.env.KMS_KEY_ID);
}

function requireKeyId(): string {
  const keyId = process.env.KMS_KEY_ID;
  if (!keyId) throw new Error("KMS_KEY_ID is not set");
  return keyId;
}

/** Output layout: [4-byte wrappedDek length][wrappedDek][iv(12)][authTag(16)][ciphertext] */
export async function envelopeEncrypt(plaintext: Buffer): Promise<Buffer> {
  const keyId = requireKeyId();
  const { Plaintext, CiphertextBlob } = await client().send(new GenerateDataKeyCommand({ KeyId: keyId, KeySpec: "AES_256" }));
  if (!Plaintext || !CiphertextBlob) {
    throw new Error("KMS GenerateDataKey returned no key material");
  }

  const dek = Buffer.from(Plaintext);
  const wrappedDek = Buffer.from(CiphertextBlob);

  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", dek, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(wrappedDek.length);

    return Buffer.concat([lenBuf, wrappedDek, iv, authTag, ciphertext]);
  } finally {
    dek.fill(0); // scrub the plaintext DEK from memory as soon as we're done with it
  }
}

export async function envelopeDecrypt(payload: Buffer): Promise<Buffer> {
  const keyId = requireKeyId();

  let offset = 0;
  const wrappedDekLen = payload.readUInt32BE(offset);
  offset += 4;
  const wrappedDek = payload.subarray(offset, offset + wrappedDekLen);
  offset += wrappedDekLen;
  const iv = payload.subarray(offset, offset + 12);
  offset += 12;
  const authTag = payload.subarray(offset, offset + 16);
  offset += 16;
  const ciphertext = payload.subarray(offset);

  const { Plaintext } = await client().send(new DecryptCommand({ CiphertextBlob: wrappedDek, KeyId: keyId }));
  if (!Plaintext) throw new Error("KMS Decrypt returned no key material");

  const dek = Buffer.from(Plaintext);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", dek, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } finally {
    dek.fill(0);
  }
}

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

const base32Encode = (buffer: Buffer): string => {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
};

const base32Decode = (input: string): Buffer => {
  const normalized = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
};

export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

export const totpCode = (secret: string, atEpochMs = Date.now()): string => {
  const key = base32Decode(secret);
  const counter = Math.floor(atEpochMs / 1000 / TOTP_STEP_SECONDS);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac("sha1", key).update(message).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const binary = ((hash[offset] & 0x7f) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
};

export const totpEpochWindow = (atEpochMs = Date.now()): number => Math.floor(atEpochMs / 1000 / TOTP_STEP_SECONDS);

export const verifyTotp = (secret: string, code: string, atEpochMs = Date.now(), toleranceWindows = 1): boolean => {
  const normalized = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const window = totpEpochWindow(atEpochMs);
  for (let offset = -toleranceWindows; offset <= toleranceWindows; offset += 1) {
    const expected = totpCode(secret, (window + offset) * TOTP_STEP_SECONDS * 1000);
    const actual = Buffer.from(normalized, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    if (actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer)) return true;
  }
  return false;
};

export const otpauthUrl = (issuer: string, account: string, secret: string): string => {
  const label = `${issuer}:${account}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
};

export const generateRecoveryCodes = (count = 10): { codes: string[]; hashes: string[] } => {
  const codes: string[] = [];
  const hashes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    let code = "";
    for (let part = 0; part < 3; part += 1) {
      for (let position = 0; position < 4; position += 1) {
        code += RECOVERY_ALPHABET[randomBytes(1)[0] % RECOVERY_ALPHABET.length];
      }
      if (part < 2) code += "-";
    }
    codes.push(code);
    hashes.push(createHash("sha256").update(code).digest("hex"));
  }
  return { codes, hashes };
};

export const verifyRecoveryCode = (code: string, hashes: string[]): boolean => recoveryCodeIndex(code, hashes) >= 0;

export const recoveryCodeIndex = (code: string, hashes: string[]): number => {
  const normalized = code.trim().toUpperCase().replace(/\s+/g, "");
  const actual = Buffer.from(createHash("sha256").update(normalized).digest("hex"), "hex");
  for (let index = 0; index < hashes.length; index += 1) {
    const expected = Buffer.from(hashes[index], "hex");
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return index;
  }
  return -1;
};

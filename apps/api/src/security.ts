import argon2 from "argon2";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const id = (): string => randomUUID();
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
export const verifyToken = (token: string, expectedHash: string): boolean => {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
export const hashPassword = (password: string): Promise<string> =>
  argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
export const verifyPassword = (hash: string, password: string): Promise<boolean> => argon2.verify(hash, password);


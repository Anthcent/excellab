import { hash, verify } from "@node-rs/argon2";

// @node-rs/argon2 defaults to argon2id (m=19456 KiB, t=2, p=1), the OWASP baseline.
export function hashPassword(password: string) {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string) {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/** Burns comparable CPU time for unknown accounts so login timing does not reveal which emails exist. */
export async function verifyAgainstDummy(password: string) {
  dummyHash ??= hashPassword("excellab-dummy-password-for-timing");
  await verifyPassword(await dummyHash, password);
  return false;
}

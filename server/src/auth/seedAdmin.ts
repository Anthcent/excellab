import type { Db } from "../db/db.js";
import { hashPassword } from "./password.js";

export async function seedAdmin(db: Db, email: string, password: string | undefined, log: (message: string) => void) {
  const { rows } = await db.query("SELECT 1 FROM users WHERE email = $1", [email]);
  if (rows.length) return;
  if (!password) {
    throw new Error(
      `Admin account ${email} does not exist and ADMIN_PASSWORD is not set. Set ADMIN_PASSWORD (min 8 chars) for the first boot.`,
    );
  }
  await db.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ('Administrador', $1, $2, 'admin')
     ON CONFLICT (email) DO NOTHING`,
    [email, await hashPassword(password)],
  );
  log(`Created admin account ${email}`);
}

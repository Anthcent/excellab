import type { Queryable } from "../db/db.js";

export type Role = "student" | "admin";

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  createdAt: string;
}

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  created_at: Date;
}

interface UserRowWithPassword extends UserRow {
  password_hash: string;
}

/** Columns needed by toPublicUser, for queries that alias the users table as `u`. */
export const PUBLIC_USER_COLUMNS = "u.id, u.name, u.email, u.role, u.created_at";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function findUserByEmail(db: Queryable, email: string) {
  const { rows } = await db.query<UserRowWithPassword>(
    `SELECT ${PUBLIC_USER_COLUMNS}, u.password_hash FROM users u WHERE u.email = $1`,
    [normalizeEmail(email)],
  );
  return rows[0];
}

export async function createUser(db: Queryable, input: { name: string; email: string; passwordHash: string; role?: Role }) {
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users AS u (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING ${PUBLIC_USER_COLUMNS}`,
    [input.name.trim(), normalizeEmail(input.email), input.passwordHash, input.role ?? "student"],
  );
  return toPublicUser(rows[0]!);
}

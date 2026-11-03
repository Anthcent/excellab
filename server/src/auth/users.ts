import type { Queryable } from "../db/db.js";

export type Role = "student" | "teacher" | "admin";
export const ROLES: readonly Role[] = ["student", "teacher", "admin"];

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  createdAt: string;
  mustChangePassword: boolean;
}

export interface UserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  created_at: Date;
  must_change_password: boolean;
}

export interface UserRowWithPassword extends UserRow {
  password_hash: string;
  active: boolean;
}

/** Columns needed by toPublicUser, for queries that alias the users table as `u`. */
export const PUBLIC_USER_COLUMNS = "u.id, u.name, u.email, u.role, u.created_at, u.must_change_password";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: new Date(row.created_at).toISOString(),
    mustChangePassword: !!row.must_change_password,
  };
}

export async function findUserByEmail(db: Queryable, email: string) {
  const { rows } = await db.query<UserRowWithPassword>(
    `SELECT ${PUBLIC_USER_COLUMNS}, u.password_hash, u.active FROM users u WHERE u.email = $1`,
    [normalizeEmail(email)],
  );
  return rows[0];
}

export async function findUserById(db: Queryable, id: string) {
  const { rows } = await db.query<UserRowWithPassword>(
    `SELECT ${PUBLIC_USER_COLUMNS}, u.password_hash, u.active FROM users u WHERE u.id = $1`,
    [id],
  );
  return rows[0];
}

export async function createUser(
  db: Queryable,
  input: { name: string; email: string; passwordHash: string; role?: Role; mustChangePassword?: boolean },
) {
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users AS u (name, email, password_hash, role, must_change_password) VALUES ($1, $2, $3, $4, $5) RETURNING ${PUBLIC_USER_COLUMNS}`,
    [input.name.trim(), normalizeEmail(input.email), input.passwordHash, input.role ?? "student", input.mustChangePassword ?? false],
  );
  return toPublicUser(rows[0]!);
}

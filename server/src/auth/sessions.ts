import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { Db } from "../db/db.js";
import { PUBLIC_USER_COLUMNS, toPublicUser, type PublicUser, type UserRow } from "./users.js";

export const SESSION_COOKIE = "gl_session";
const DAY_MS = 86_400_000;

export interface SessionSettings {
  ttlDays: number;
  cookieSecure: boolean;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function setSessionCookie(reply: FastifyReply, token: string, settings: SessionSettings) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: settings.cookieSecure,
    sameSite: "lax",
    path: "/",
    maxAge: settings.ttlDays * 86_400,
  });
}

export function clearSessionCookie(reply: FastifyReply, settings: SessionSettings) {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: settings.cookieSecure, sameSite: "lax", path: "/" });
}

export async function createSession(db: Db, userId: string, settings: SessionSettings) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + settings.ttlDays * DAY_MS);
  await db.query("INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)", [hashToken(token), userId, expiresAt.toISOString()]);
  return token;
}

/** Starts a session and sets its cookie on the reply. */
export async function signIn(db: Db, reply: FastifyReply, userId: string, settings: SessionSettings) {
  setSessionCookie(reply, await createSession(db, userId, settings), settings);
}

export async function deleteSession(db: Db, token: string) {
  await db.query("DELETE FROM sessions WHERE id = $1", [hashToken(token)]);
}

/** Resolves a token to its user. Renews the session (sliding expiry) once less than half of the TTL remains. */
export async function resolveSession(
  db: Db,
  token: string,
  settings: SessionSettings,
): Promise<{ user: PublicUser; renewed: boolean } | undefined> {
  const id = hashToken(token);
  const { rows } = await db.query<UserRow & { expires_at: Date }>(
    `SELECT ${PUBLIC_USER_COLUMNS}, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [id],
  );
  const row = rows[0];
  if (!row) return undefined;

  const ttlMs = settings.ttlDays * DAY_MS;
  const renewed = new Date(row.expires_at).getTime() - Date.now() < ttlMs / 2;
  if (renewed) await db.query("UPDATE sessions SET expires_at = $2 WHERE id = $1", [id, new Date(Date.now() + ttlMs).toISOString()]);
  return { user: toPublicUser(row), renewed };
}

export async function deleteExpiredSessions(db: Db) {
  const { rowCount } = await db.query("DELETE FROM sessions WHERE expires_at <= now()");
  return rowCount ?? 0;
}

import type { FastifyRequest } from "fastify";
import type { PublicUser } from "../auth/users.js";
import { AppError } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest {
    user: PublicUser | null;
  }
}

const unauthenticated = () => new AppError(401, "UNAUTHENTICATED", "Inicia sesión para continuar.");

export async function requireUser(request: FastifyRequest) {
  if (!request.user) throw unauthenticated();
}

export async function requireAdmin(request: FastifyRequest) {
  if (!request.user) throw unauthenticated();
  if (request.user.role !== "admin") throw new AppError(403, "FORBIDDEN", "No tienes permisos para realizar esta acción.");
}

/** Teachers and admins: exercise/exam authoring and results. Teachers are further limited to their own content. */
export async function requireStaff(request: FastifyRequest) {
  if (!request.user) throw unauthenticated();
  if (request.user.role !== "admin" && request.user.role !== "teacher") {
    throw new AppError(403, "FORBIDDEN", "No tienes permisos para realizar esta acción.");
  }
}

export const isAdmin = (user: PublicUser) => user.role === "admin";

/** Owner filter for scoped queries: admins see everything (undefined), teachers only what they own. */
export const ownerScope = (user: PublicUser): string | undefined => (user.role === "admin" ? undefined : user.id);

export function currentUser(request: FastifyRequest): PublicUser {
  if (!request.user) throw unauthenticated();
  return request.user;
}

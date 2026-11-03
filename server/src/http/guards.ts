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

export function currentUser(request: FastifyRequest): PublicUser {
  if (!request.user) throw unauthenticated();
  return request.user;
}

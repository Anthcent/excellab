import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (message = "No encontramos lo que buscas.") => new AppError(404, "NOT_FOUND", message);
export const badRequest = (message: string, code = "VALIDATION") => new AppError(400, code, message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);

const fastifyErrorMessages: Record<number, { code: string; message: string }> = {
  400: { code: "BAD_REQUEST", message: "La solicitud no es válida." },
  413: { code: "PAYLOAD_TOO_LARGE", message: "Los datos enviados superan el tamaño permitido." },
  415: { code: "UNSUPPORTED_MEDIA_TYPE", message: "El formato de la solicitud no es compatible." },
};

function send(reply: FastifyReply, status: number, code: string, message: string, details?: Record<string, unknown>) {
  return reply.status(status).send({ error: { code, message, ...details } });
}

export function errorHandler(error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof AppError) return send(reply, error.statusCode, error.code, error.message, error.details);

  if (error instanceof ZodError) {
    const fields = error.issues.map((issue) => issue.path.join(".")).filter(Boolean);
    return send(reply, 400, "VALIDATION", "Revisa los datos ingresados.", { fields });
  }

  const status = (error as FastifyError).statusCode;
  if (status && status >= 400 && status < 500) {
    const known = fastifyErrorMessages[status] ?? { code: "BAD_REQUEST", message: "La solicitud no es válida." };
    return send(reply, status, known.code, known.message);
  }

  request.log.error({ err: error }, "Unhandled error");
  return send(reply, 500, "INTERNAL", "Ocurrió un error inesperado. Inténtalo de nuevo.");
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../http/context.js";
import { currentUser, requireUser } from "../http/guards.js";
import {
  attemptView,
  finishAttempt,
  getExamForStudent,
  listExamsForStudent,
  myResults,
  saveDraft,
  startAttempt,
  submitExercise,
} from "./service.js";

const idParams = z.object({ id: z.uuid() });
const exerciseParams = z.object({ id: z.uuid(), exerciseId: z.uuid() });
const startBody = z.object({ accepted: z.boolean().optional() }).default({});
const workbookBody = z.object({ workbook: z.unknown() });

export async function studentRoutes(app: FastifyInstance, ctx: AppContext) {
  const guard = { preHandler: requireUser };

  app.get("/exams", guard, async (request) => listExamsForStudent(ctx, currentUser(request)));

  app.get("/exams/:id", guard, async (request) => {
    const { id } = idParams.parse(request.params);
    return getExamForStudent(ctx, currentUser(request), id);
  });

  app.post("/exams/:id/attempts", guard, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = startBody.parse(request.body ?? {});
    const user = currentUser(request);
    const started = await startAttempt(ctx, user, id, body.accepted === true);
    const view = await attemptView(ctx, started.attemptId, user.id);
    return reply.status(started.resumed ? 200 : 201).send({ ...view, resumed: started.resumed });
  });

  app.get("/attempts/:id", guard, async (request) => {
    const { id } = idParams.parse(request.params);
    return attemptView(ctx, id, currentUser(request).id);
  });

  app.put("/attempts/:id/exercises/:exerciseId/draft", guard, async (request) => {
    const { id, exerciseId } = exerciseParams.parse(request.params);
    const { workbook } = workbookBody.parse(request.body);
    return saveDraft(ctx, currentUser(request).id, id, exerciseId, workbook);
  });

  app.post("/attempts/:id/exercises/:exerciseId/submit", guard, async (request) => {
    const { id, exerciseId } = exerciseParams.parse(request.params);
    const { workbook } = workbookBody.parse(request.body);
    return submitExercise(ctx, currentUser(request).id, id, exerciseId, workbook);
  });

  app.post("/attempts/:id/finish", guard, async (request) => {
    const { id } = idParams.parse(request.params);
    return finishAttempt(ctx, currentUser(request).id, id);
  });

  app.get("/me/results", guard, async (request) => myResults(ctx, currentUser(request)));
}

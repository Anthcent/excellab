import { z } from "zod";

/** Query-string pagination: `page` starts at 1. Both are optional on every list route. */
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuery>;

export function pageOf(query: PaginationQuery, defaultSize = 25) {
  return { page: query.page ?? 1, pageSize: query.pageSize ?? defaultSize };
}

/** Lists that existed before pagination stay a bare array unless the client asks for a page. */
export const wantsPage = (query: PaginationQuery) => query.page !== undefined || query.pageSize !== undefined;

/** Escapes a user string for use inside ILIKE '%…%'. */
export const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

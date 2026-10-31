/**
 * PostgREST caps every response at `max-rows` (1000 by default), so a
 * plain `.select()` silently drops everything past the first 1000 rows
 * and a long `.in('col', [...])` overflows the URL. These helpers keep
 * audience resolution and the dispatcher honest for lists of any size.
 */

/** Rows requested per round trip; below the 1000-row server cap. */
export const PAGE_SIZE = 500;

/** Values per `.in(...)` filter; keeps the request URL short. */
export const IN_CHUNK = 100;

export interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/**
 * Read every row of a query. `fetchPage` MUST apply a total, stable
 * `.order(...)` (include a unique column) and `.range(from, to)` so
 * pages never overlap or skip.
 */
export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize: number = PAGE_SIZE,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

export function chunk<T>(items: readonly T[], size: number = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

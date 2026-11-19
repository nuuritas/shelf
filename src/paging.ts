/**
 * The shelf's page. The first page is one screen of saves; "Load more" asks for
 * up to twice what is on screen, so a long library takes a handful of presses
 * and every answer is a prefix a reader can reload. The cap is the largest
 * library a plan can hold, so a hand-edited URL cannot ask for more.
 *
 * No db and no env: `src/worker.ts` and `src/bookmarks-do.ts` both clamp with
 * it, so the page and the API agree on the ceiling and it is named once.
 */
export const PAGE_SIZE = 50;
export const PAGE_MAX = 5000;

/**
 * A requested number of saves: one page when the request names none or names
 * something that is not a number, at least one save, and never more than the
 * cap. The first page always asks for `PAGE_SIZE`; the API keeps accepting
 * smaller counts because the CLI and MCP clients ask for ten or twenty.
 */
export function pageSize(value: string | number | null | undefined): number {
  const asked = typeof value === 'string' ? Number(value) : value;
  if (asked === null || asked === undefined || !Number.isFinite(asked)) return PAGE_SIZE;
  return Math.max(1, Math.min(PAGE_MAX, Math.trunc(asked)));
}

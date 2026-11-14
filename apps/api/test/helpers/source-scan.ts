/**
 * Removes comments, so a scanner does not read prose naming a banned API as a use of it. Not a
 * parser: markers inside a string confuse it, which errs towards reporting a defect. The `[^:]` keeps
 * a line after `https://`.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

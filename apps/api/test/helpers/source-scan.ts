/**
 * Scanners must ignore prose that names a banned API, while keeping URLs such as `https://`. This is
 * not a parser: a comment marker inside a string can hide the code after it from a scan.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

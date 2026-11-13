/** Zero is "broke even", not "level", which read as a setting. One definition for all three result views. */
export function netWord(net: number): 'gained' | 'lost' | 'broke even' {
  if (net > 0) return 'gained';
  if (net < 0) return 'lost';
  return 'broke even';
}

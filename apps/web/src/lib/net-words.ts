/**
 * The word beside a net result: "gained", "lost" or "broke even".
 *
 * Zero was "level", which rendered as "0 units LEVEL" in the hand list, the replay's summary and its
 * result panel (audit at 6b3886e) — a word that reads as a setting or a rank before it reads as a
 * result. One definition for the three places, so they cannot drift back into three different words.
 *
 * A leaf module with no imports, so it loads under `node --test`.
 */
export function netWord(net: number): 'gained' | 'lost' | 'broke even' {
  if (net > 0) return 'gained';
  if (net < 0) return 'lost';
  return 'broke even';
}

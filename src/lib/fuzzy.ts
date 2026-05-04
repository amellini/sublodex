/** Match fuzzy: ogni char di `needle` deve apparire in `hay` in ordine.
 *  Score = penalizza distanza fra match consecutivi, premia match nel basename.
 *  Ritorna null se nessun match. Score minore = miglior match. */
export function fuzzyScore(needle: string, hay: string): number | null {
  if (!needle) return 0;
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  let lastIdx = -1;
  let score = 0;
  for (const ch of n) {
    const idx = h.indexOf(ch, lastIdx + 1);
    if (idx < 0) return null;
    if (lastIdx === -1) score += idx;            // penalità "salto iniziale"
    else score += (idx - lastIdx - 1) * 2;       // penalità gap fra match
    lastIdx = idx;
  }
  // bonus se l'ultima parte (basename) contiene tutti i char insieme
  const base = h.split('/').pop() ?? h;
  if (base.includes(n)) score -= 30;
  // penalità per stringhe lunghe (cwd-relative)
  score += Math.floor(hay.length / 20);
  return score;
}

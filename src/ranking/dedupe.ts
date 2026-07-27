/** Lowercases, strips punctuation, and collapses whitespace for stable grouping keys. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Classic edit-distance, used to catch near-duplicate spellings that normalization alone won't merge. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

/** Fuzzy-equal if normalized strings match exactly, or are close enough relative to their length. */
export function fuzzyEqual(a: string, b: string): boolean {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return true;
  if (na.length === 0 || nb.length === 0) return false;

  const distance = levenshtein(na, nb);
  const threshold = Math.max(1, Math.floor(Math.max(na.length, nb.length) * 0.15));
  return distance <= threshold;
}

export interface GroupableEntry {
  artist: string;
  album: string;
}

/**
 * Groups entries whose (artist, album) pair fuzzy-matches an existing group, so typos like
 * "Steely Dan" / "Steely dan" or "Maggot Brain" / "Magot Brain" count as the same recommendation.
 * Returns each input's index mapped to its group's representative (first-seen) entry.
 */
export function groupByFuzzyMatch<T extends GroupableEntry>(entries: T[]): T[][] {
  const groups: T[][] = [];

  for (const entry of entries) {
    const existing = groups.find(
      (g) => fuzzyEqual(g[0].artist, entry.artist) && fuzzyEqual(g[0].album, entry.album)
    );
    if (existing) {
      existing.push(entry);
    } else {
      groups.push([entry]);
    }
  }

  return groups;
}

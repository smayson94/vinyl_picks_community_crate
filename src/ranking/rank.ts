import { groupByFuzzyMatch } from "./dedupe.js";

export interface RecommendationInput {
  artist: string | null;
  album: string | null;
  song: string | null;
  is_ambiguous: boolean;
  like_count?: number;
}

export interface RankedAlbum {
  artist: string;
  album: string;
  songs: string[];
  mentionCount: number;
  score: number;
}

export interface RankResult {
  ranked: RankedAlbum[];
  ambiguous: RecommendationInput[];
}

/**
 * Groups resolved (non-ambiguous, artist+album present) recommendations by fuzzy-matched
 * (artist, album), counts mentions, and sorts by a popularity score that weighs in each
 * comment's own like count (a single well-liked comment can outrank several unliked ones) --
 * mentionCount stays the plain, human-readable "N people recommended this" count for display.
 */
export function rankRecommendations(recommendations: RecommendationInput[]): RankResult {
  const ambiguous = recommendations.filter((r) => r.is_ambiguous || !r.artist || !r.album);
  const resolved = recommendations.filter(
    (r): r is RecommendationInput & { artist: string; album: string } =>
      !r.is_ambiguous && !!r.artist && !!r.album
  );

  const groups = groupByFuzzyMatch(resolved);

  const ranked: RankedAlbum[] = groups.map((group) => {
    const representative = group[0];
    const songs = [...new Set(group.map((g) => g.song).filter((s): s is string => !!s))];
    const score = group.reduce((sum, r) => sum + 1 + (r.like_count ?? 0), 0);
    return {
      artist: representative.artist,
      album: representative.album,
      songs,
      mentionCount: group.length,
      score,
    };
  });

  ranked.sort((a, b) => b.score - a.score);

  return { ranked, ambiguous };
}

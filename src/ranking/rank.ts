import { groupByFuzzyMatch } from "./dedupe.js";

export interface RecommendationInput {
  artist: string | null;
  album: string | null;
  song: string | null;
  is_ambiguous: boolean;
}

export interface RankedAlbum {
  artist: string;
  album: string;
  songs: string[];
  mentionCount: number;
}

export interface RankResult {
  ranked: RankedAlbum[];
  ambiguous: RecommendationInput[];
}

/**
 * Groups resolved (non-ambiguous, artist+album present) recommendations by fuzzy-matched
 * (artist, album), counts mentions, and sorts by popularity descending.
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
    return {
      artist: representative.artist,
      album: representative.album,
      songs,
      mentionCount: group.length,
    };
  });

  ranked.sort((a, b) => b.mentionCount - a.mentionCount);

  return { ranked, ambiguous };
}

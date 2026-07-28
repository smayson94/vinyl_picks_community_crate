import { suggestSimilarAlbums } from "../comment-parser/openai-parser.js";
import { groupByFuzzyMatch, normalizeText } from "../ranking/dedupe.js";
import type { RankedAlbum } from "../ranking/rank.js";
import { logger } from "../shared/logger.js";
import type { RecommendationRow } from "../storage/repository.js";

function albumKey(artist: string, album: string): string {
  return `${normalizeText(artist)}::${normalizeText(album)}`;
}

/** Extracts just the host's own caption-sourced picks, shaped like ranked albums. */
export function getCaptionOnlyAlbums(rows: RecommendationRow[]): RankedAlbum[] {
  const captionRows = rows.filter(
    (r): r is RecommendationRow & { artist: string; album: string } =>
      r.username === "caption" && !r.is_ambiguous && !!r.artist && !!r.album
  );

  return groupByFuzzyMatch(captionRows).map((group) => ({
    artist: group[0].artist,
    album: group[0].album,
    songs: [...new Set(group.map((r) => r.song).filter((s): s is string => !!s))],
    mentionCount: group.length,
  }));
}

const CAPTION_BOOST_TRACKS_PER_ALBUM = 5;
const MAX_SIMILAR_ALBUM_ROUNDS = 2;
const SIMILAR_ALBUMS_PER_ROUND = 6;
const SIMILAR_ALBUM_TRACKS = 3;

export interface TopUpOptions {
  targetCount: number;
  resolveAlbum: (album: RankedAlbum, tracksPerAlbum: number) => Promise<string[]>;
  captionAlbums: RankedAlbum[];
  alreadyIncluded: { artist: string; album: string }[];
  theme: string | null;
  seedArtists: string[];
  platformLabel: string;
}

/**
 * Pads out a thin playlist (a week with too few community recommendations to fill one on its
 * own) in two steps: first by pulling more tracks from the host's own caption-recommended
 * albums (still real, curated content, just under-mined by the default 2-per-album cap), then --
 * only if still short -- by asking the model for similar albums in the same vein and resolving
 * those through the normal search pipeline (with its existing title-correction/free-text
 * fallbacks). Spotify's own recommendations/related-artists endpoints are unavailable to this
 * app (403/404, confirmed live), which is why this goes through OpenAI instead.
 */
export async function topUpTracks(current: string[], opts: TopUpOptions): Promise<string[]> {
  const ids = [...current];
  const seenKeys = new Set(opts.alreadyIncluded.map((a) => albumKey(a.artist, a.album)));
  const seenLabels = opts.alreadyIncluded.map((a) => `${a.artist} - ${a.album}`);

  for (const album of opts.captionAlbums) {
    if (ids.length >= opts.targetCount) break;
    const key = albumKey(album.artist, album.album);
    if (seenKeys.has(key)) continue;
    const more = await opts.resolveAlbum(album, CAPTION_BOOST_TRACKS_PER_ALBUM);
    for (const id of more) if (!ids.includes(id)) ids.push(id);
    seenKeys.add(key);
    seenLabels.push(`${album.artist} - ${album.album}`);
  }

  let round = 0;
  while (ids.length < opts.targetCount && round < MAX_SIMILAR_ALBUM_ROUNDS) {
    round++;
    const suggestions = await suggestSimilarAlbums(opts.seedArtists, opts.theme, seenLabels, SIMILAR_ALBUMS_PER_ROUND);
    if (suggestions.length === 0) break;

    logger.info(
      `${opts.platformLabel}: playlist is thin (${ids.length}/${opts.targetCount}) — trying ${suggestions.length} similar-album suggestion(s).`
    );

    for (const s of suggestions) {
      if (ids.length >= opts.targetCount) break;
      const key = albumKey(s.artist, s.album);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      seenLabels.push(`${s.artist} - ${s.album}`);

      const found = await opts.resolveAlbum(
        { artist: s.artist, album: s.album, songs: [], mentionCount: 0 },
        SIMILAR_ALBUM_TRACKS
      );
      for (const id of found) if (!ids.includes(id)) ids.push(id);
    }
  }

  return ids;
}

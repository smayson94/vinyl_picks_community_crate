import { suggestSimilarAlbums } from "../comment-parser/openai-parser.js";
import { fuzzyEqual, groupByFuzzyMatch, normalizeText } from "../ranking/dedupe.js";
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
    score: group.length,
  }));
}

export interface ArtistOnlyMention {
  artist: string;
  mentionCount: number;
  score: number;
}

/**
 * Surfaces artists mentioned by commenters without any specific album/song attached (e.g. "more
 * St Paul and the Broken Bones!") -- these are real recommendations that `rankRecommendations`
 * can't rank as an album, since there's nothing to group tracks by, so they'd otherwise vanish
 * into the ambiguous bucket entirely. Matched purely on "artist identified, no album" -- NOT
 * gated on is_ambiguous, since the parser marks most of these confident (is_ambiguous: 0): it
 * correctly identified the artist, there's just no album/song attached to that comment. Grouped
 * by fuzzy artist name and filtered to artists not already represented among the resolved
 * `alreadyRepresentedArtists`, so a genuine repeated signal isn't dropped just because no one
 * named a specific record.
 */
export function getArtistOnlyMentions(
  rows: RecommendationRow[],
  alreadyRepresentedArtists: string[]
): ArtistOnlyMention[] {
  const artistOnlyRows = rows.filter(
    (r): r is RecommendationRow & { artist: string } => !!r.artist && !r.album
  );

  const groups: { artist: string; rows: (RecommendationRow & { artist: string })[] }[] = [];
  for (const row of artistOnlyRows) {
    const existing = groups.find((g) => fuzzyEqual(g.artist, row.artist));
    if (existing) existing.rows.push(row);
    else groups.push({ artist: row.artist, rows: [row] });
  }

  return groups
    .filter((g) => !alreadyRepresentedArtists.some((a) => fuzzyEqual(a, g.artist)))
    .map((g) => ({
      artist: g.artist,
      mentionCount: g.rows.length,
      score: g.rows.reduce((sum, r) => sum + 1 + (r.like_count ?? 0), 0),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Caps how many artist-only highlights ever compete for a playlist slot. Without a cap, a week
 * with a long tail of one-off "check out X" name-drops could crowd out real ranked albums; capping
 * (and sorting by score first) keeps it to the artists genuinely worth calling out.
 */
export const MAX_ARTIST_HIGHLIGHTS = 8;

export interface ArtistHighlightOptions {
  maxTracks: number;
  resolveArtist: (artistName: string) => Promise<string | undefined>;
  platformLabel: string;
}

/**
 * Adds one track per still-under-represented artist-only mention (space permitting, highest-score
 * first, capped at MAX_ARTIST_HIGHLIGHTS), so an artist who's mentioned by name repeatedly but
 * never with a specific album/song still ends up on the playlist instead of being silently
 * skipped. Takes pre-computed `mentions` (already sliced to MAX_ARTIST_HIGHLIGHTS) rather than raw
 * rows, so the caller can reserve the same number of playlist slots up front -- otherwise a week
 * with enough ranked albums to already fill the cap would leave zero room for these by the time
 * this step runs.
 */
export async function addArtistOnlyHighlights(
  current: string[],
  mentions: ArtistOnlyMention[],
  opts: ArtistHighlightOptions
): Promise<string[]> {
  const ids = [...current];

  for (const mention of mentions) {
    if (ids.length >= opts.maxTracks) break;
    const id = await opts.resolveArtist(mention.artist);
    if (id && !ids.includes(id)) {
      ids.push(id);
      logger.info(
        `${opts.platformLabel}: highlighted "${mention.artist}" (mentioned ${mention.mentionCount}x without a specific album/song) with a top track.`
      );
    }
  }

  return ids;
}

const DEFAULT_TRACKS_PER_ALBUM = 2;

export interface VarietySelectionOptions {
  maxTracks: number;
  resolveAlbum: (album: RankedAlbum, tracksPerAlbum: number) => Promise<string[]>;
  tracksPerAlbum?: number;
}

/**
 * Resolves tracks for the top-ranked albums (bounded to `maxTracks` of them, since no more than
 * that could ever fit even at one track each) and distributes them round-robin -- one track from
 * each album in rank order first, then a second track per album only if there's still room -- so
 * a week with enough distinct recommended albums to fill the playlist shows more variety instead
 * of always taking 2 tracks from fewer, higher-ranked albums.
 */
export async function selectTracksForVariety(
  ranked: RankedAlbum[],
  opts: VarietySelectionOptions
): Promise<string[]> {
  const perAlbumCap = opts.tracksPerAlbum ?? DEFAULT_TRACKS_PER_ALBUM;
  const candidates = ranked.slice(0, opts.maxTracks);

  const perAlbumTracks: string[][] = [];
  for (const album of candidates) {
    perAlbumTracks.push(await opts.resolveAlbum(album, perAlbumCap));
  }

  const result: string[] = [];
  for (let round = 0; round < perAlbumCap && result.length < opts.maxTracks; round++) {
    for (const tracks of perAlbumTracks) {
      if (result.length >= opts.maxTracks) break;
      const id = tracks[round];
      if (id && !result.includes(id)) result.push(id);
    }
  }

  return result;
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
        { artist: s.artist, album: s.album, songs: [], mentionCount: 0, score: 0 },
        SIMILAR_ALBUM_TRACKS
      );
      for (const id of found) if (!ids.includes(id)) ids.push(id);
    }
  }

  return ids;
}

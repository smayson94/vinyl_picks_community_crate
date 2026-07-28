import "../config/env.js";
import { loadEnv } from "../config/env.js";
import { getOrCreateLibraryPlaylist, resolveAppleMusicSongIds } from "../apple-music/apple-music-client.js";
import { extractCaptionTheme, parseComments } from "../comment-parser/openai-parser.js";
import {
  extractCaptionPickLines,
  fetchComments,
  fetchLatestReelMedia,
  fetchMediaCaption,
  fetchMediaPostedAt,
  getIgUserId,
  refreshAccessToken,
} from "../instagram/instagram-client.js";
import { buildPlaylistDescription, playlistNameFor } from "./playlist-format.js";
import { writeReviewReport } from "./review-report.js";
import { getCaptionOnlyAlbums, selectTracksForVariety, topUpTracks } from "./track-selection.js";
import { rankRecommendations, type RankedAlbum, type RecommendationInput } from "../ranking/rank.js";
import { logger } from "../shared/logger.js";
import {
  getOrCreatePlaylist,
  replacePlaylistTracks,
  resolveTrackUris,
  updatePlaylistDetails,
} from "../spotify/spotify-client.js";
import {
  applyParsedRecommendations,
  getPlaylistIdForReel,
  getRecommendationsForReel,
  getReel,
  getUnparsedComments,
  hasReachedStatus,
  insertComments,
  markCommentsFetched,
  recordPlaylistSync,
  setReelStatus,
  setReelTheme,
  upsertReel,
  type RawComment,
  type Reel,
} from "../storage/repository.js";

const MAX_PLAYLIST_TRACKS = 50;
const MIN_PLAYLIST_TRACKS = 15; // below this, top up from caption albums + LLM-suggested similar albums

/**
 * Resolves which reel to run the pipeline for. If `reelIdArg` names a reel already in the
 * database (e.g. one imported via CSV), it's used as-is. Otherwise, when Instagram is
 * configured, `reelIdArg` is treated as a real Instagram media id to register (or, if omitted
 * entirely, the account's latest Reel is auto-detected). With no Instagram credentials and no
 * pre-existing reel, there's nothing to run the pipeline against.
 */
async function ensureReelRegistered(reelIdArg: string | undefined): Promise<string> {
  if (reelIdArg) {
    const existing = getReel(reelIdArg);
    if (existing) return existing.id;
  }

  const env = loadEnv();
  if (!env.INSTAGRAM_ACCESS_TOKEN) {
    throw new Error(
      reelIdArg
        ? `No reel "${reelIdArg}" found locally, and INSTAGRAM_ACCESS_TOKEN is not set to fetch it live. Import its comments via CSV first.`
        : "No reel id given and INSTAGRAM_ACCESS_TOKEN is not set. Pass a reel id already imported via CSV, or configure Instagram credentials to auto-detect the latest Reel."
    );
  }

  await refreshAccessToken();

  if (reelIdArg) {
    const postedAt = await fetchMediaPostedAt(reelIdArg);
    upsertReel(reelIdArg, postedAt);
    return reelIdArg;
  }

  const igUserId = await getIgUserId();
  const { id, postedAt } = await fetchLatestReelMedia(igUserId);
  upsertReel(id, postedAt);
  logger.info(`Auto-detected latest Reel: ${id} (posted ${postedAt}).`);
  return id;
}

/**
 * Runs every pipeline stage for a single reel, skipping stages the reel has already passed
 * (per its stored status) so a rerun after a transient failure never redoes finished work.
 */
export async function runPipelineForReel(reelId: string): Promise<void> {
  let reel = getReel(reelId);
  if (!reel) {
    throw new Error(`No reel "${reelId}" found — import its comments first.`);
  }

  try {
    reel = await ensureCommentsFetched(reel);
    reel = await ensureParsed(reel);
    reel = await ensureSpotifySynced(reel);
    reel = await ensureAppleMusicSynced(reel);
    setReelStatus(reel.id, "DONE");
    const reportPath = writeReviewReport(reel.id);
    logger.info(`Reel "${reel.id}" pipeline complete. Review report: ${reportPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setReelStatus(reel.id, reel.status, message);
    logger.error(`Pipeline failed for reel "${reel.id}" at status ${reel.status}: ${message}`);
    throw err;
  }
}

async function ensureCommentsFetched(reel: Reel): Promise<Reel> {
  if (hasReachedStatus(reel.status, "COMMENTS_FETCHED")) return reel;

  const env = loadEnv();
  if (env.INSTAGRAM_ACCESS_TOKEN) {
    const comments = await fetchComments(reel.id);

    const caption = await fetchMediaCaption(reel.id);
    const captionComments: RawComment[] = caption
      ? extractCaptionPickLines(caption).map((line, i) => ({
          ig_comment_id: `${reel.id}:caption:${i}`,
          username: "caption",
          comment_text: line,
        }))
      : [];

    if (caption) {
      const theme = await extractCaptionTheme(caption);
      setReelTheme(reel.id, theme);
      if (theme) logger.info(`Caption theme for reel "${reel.id}": "${theme}".`);
    }

    const inserted = insertComments(reel.id, [...comments, ...captionComments]);
    logger.info(
      `Fetched ${comments.length} comment(s) + ${captionComments.length} caption pick(s) from Instagram for reel "${reel.id}" (${inserted} new or updated).`
    );
  }
  // else: comments assumed already imported via `npm run import:comments` (CSV fallback path).

  markCommentsFetched(reel.id);
  setReelStatus(reel.id, "COMMENTS_FETCHED");
  return getReel(reel.id)!;
}

async function ensureParsed(reel: Reel): Promise<Reel> {
  if (hasReachedStatus(reel.status, "PARSED")) return reel;

  const unparsed = getUnparsedComments(reel.id);
  logger.info(`Parsing ${unparsed.length} comment(s) for reel "${reel.id}"...`);
  if (unparsed.length > 0) {
    const parsed = await parseComments(unparsed);
    applyParsedRecommendations(parsed);
  }

  setReelStatus(reel.id, "PARSED");
  return getReel(reel.id)!;
}

function getRankedAlbums(reel: Reel) {
  const rows = getRecommendationsForReel(reel.id);
  const asInput: RecommendationInput[] = rows.map((r) => ({
    artist: r.artist,
    album: r.album,
    song: r.song,
    is_ambiguous: !!r.is_ambiguous,
    like_count: r.like_count,
  }));
  return rankRecommendations(asInput);
}

function getSeedArtists(ranked: RankedAlbum[], captionAlbums: RankedAlbum[]): string[] {
  return [...new Set([...captionAlbums, ...ranked].map((a) => a.artist))].slice(0, 6);
}

async function ensureSpotifySynced(reel: Reel): Promise<Reel> {
  if (hasReachedStatus(reel.status, "SPOTIFY_SYNCED")) return reel;

  const { ranked, ambiguous } = getRankedAlbums(reel);
  logger.info(
    `Reel "${reel.id}": ${ranked.length} ranked album(s), ${ambiguous.length} ambiguous/unresolved comment(s).`
  );
  setReelStatus(reel.id, "RANKED");

  let trackUris = await selectTracksForVariety(ranked, {
    maxTracks: MAX_PLAYLIST_TRACKS,
    resolveAlbum: (album, tracksPerAlbum) => resolveTrackUris(album, tracksPerAlbum),
  });

  if (trackUris.length < MIN_PLAYLIST_TRACKS) {
    const rows = getRecommendationsForReel(reel.id);
    const captionAlbums = getCaptionOnlyAlbums(rows);
    trackUris = await topUpTracks(trackUris, {
      targetCount: MIN_PLAYLIST_TRACKS,
      resolveAlbum: (album, tracksPerAlbum) => resolveTrackUris(album, tracksPerAlbum),
      captionAlbums,
      alreadyIncluded: ranked.map((a) => ({ artist: a.artist, album: a.album })),
      theme: reel.theme,
      seedArtists: getSeedArtists(ranked, captionAlbums),
      platformLabel: "Spotify",
    });
  }

  if (trackUris.length > MAX_PLAYLIST_TRACKS) {
    logger.info(`Capping playlist at ${MAX_PLAYLIST_TRACKS} tracks (resolved ${trackUris.length}).`);
    trackUris.length = MAX_PLAYLIST_TRACKS;
  }

  // Prefer the playlist this reel is already known to use over a fresh name-based lookup --
  // theme extraction isn't perfectly deterministic re-run to re-run, so a name-based search alone
  // could create a second, orphaned playlist instead of updating the one already in use.
  const playlistName = playlistNameFor(reel);
  let playlistId = getPlaylistIdForReel(reel.id, "spotify");
  if (playlistId) {
    await updatePlaylistDetails(playlistId, { name: playlistName, description: buildPlaylistDescription(ranked) });
  } else {
    playlistId = await getOrCreatePlaylist(playlistName);
    await updatePlaylistDetails(playlistId, { description: buildPlaylistDescription(ranked) });
  }

  await replacePlaylistTracks(playlistId, trackUris);
  recordPlaylistSync(reel.id, "spotify", playlistId, trackUris.length);
  logger.info(`Synced ${trackUris.length} track(s) to Spotify playlist "${playlistName}" (${playlistId}).`);

  setReelStatus(reel.id, "SPOTIFY_SYNCED");
  return getReel(reel.id)!;
}

async function ensureAppleMusicSynced(reel: Reel): Promise<Reel> {
  if (hasReachedStatus(reel.status, "APPLE_SYNCED")) return reel;

  const env = loadEnv();
  const configured =
    env.APPLE_MUSIC_TEAM_ID && env.APPLE_MUSIC_KEY_ID && env.APPLE_MUSIC_PRIVATE_KEY_PATH && env.APPLE_MUSIC_USER_TOKEN;

  if (!configured) {
    setReelStatus(reel.id, "APPLE_SYNCED");
    return getReel(reel.id)!;
  }

  const { ranked } = getRankedAlbums(reel);

  let songIds = await selectTracksForVariety(ranked, {
    maxTracks: MAX_PLAYLIST_TRACKS,
    resolveAlbum: (album, tracksPerAlbum) => resolveAppleMusicSongIds(album, tracksPerAlbum),
  });

  if (songIds.length < MIN_PLAYLIST_TRACKS) {
    const rows = getRecommendationsForReel(reel.id);
    const captionAlbums = getCaptionOnlyAlbums(rows);
    songIds = await topUpTracks(songIds, {
      targetCount: MIN_PLAYLIST_TRACKS,
      resolveAlbum: (album, tracksPerAlbum) => resolveAppleMusicSongIds(album, tracksPerAlbum),
      captionAlbums,
      alreadyIncluded: ranked.map((a) => ({ artist: a.artist, album: a.album })),
      theme: reel.theme,
      seedArtists: getSeedArtists(ranked, captionAlbums),
      platformLabel: "Apple Music",
    });
  }

  if (songIds.length > MAX_PLAYLIST_TRACKS) songIds.length = MAX_PLAYLIST_TRACKS;

  // As with Spotify, prefer the playlist this reel is already known to use over a fresh
  // name-based lookup, since theme extraction can vary re-run to re-run.
  const playlistName = playlistNameFor(reel);
  const playlistId = getPlaylistIdForReel(reel.id, "apple_music") ?? (await getOrCreateLibraryPlaylist(playlistName, songIds));
  recordPlaylistSync(reel.id, "apple_music", playlistId, songIds.length);
  logger.info(`Synced ${songIds.length} track(s) to Apple Music playlist "${playlistName}" (${playlistId}).`);

  setReelStatus(reel.id, "APPLE_SYNCED");
  return getReel(reel.id)!;
}

async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes("--refresh");
  const reelIdArg = args.find((a) => !a.startsWith("--"));

  const reelId = await ensureReelRegistered(reelIdArg);

  if (refresh) {
    // Re-checks for new comments/re-syncs even if this reel already ran to completion -- useful
    // for a mid-week or Monday-morning refresh once more comments have come in. Safe to do: comment
    // inserts are deduped by ig_comment_id, only genuinely-new comments get (re-)parsed, and both
    // playlist syncs are themselves idempotent replace/reuse operations.
    logger.info(`Refreshing reel "${reelId}" — re-checking for new comments.`);
    setReelStatus(reelId, "NEW");
  }

  await runPipelineForReel(reelId);
}

main().catch((err) => {
  logger.error("Pipeline run failed:", err);
  process.exit(1);
});

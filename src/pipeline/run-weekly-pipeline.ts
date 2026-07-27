import "../config/env.js";
import { loadEnv } from "../config/env.js";
import { parseComments } from "../comment-parser/openai-parser.js";
import {
  extractCaptionPickLines,
  fetchComments,
  fetchLatestReelMedia,
  fetchMediaCaption,
  fetchMediaPostedAt,
  getIgUserId,
  refreshAccessToken,
} from "../instagram/instagram-client.js";
import { rankRecommendations, type RecommendationInput } from "../ranking/rank.js";
import { logger } from "../shared/logger.js";
import { getOrCreatePlaylist, replacePlaylistTracks, resolveTrackUris } from "../spotify/spotify-client.js";
import {
  applyParsedRecommendations,
  getRecommendationsForReel,
  getReel,
  getUnparsedComments,
  hasReachedStatus,
  insertComments,
  markCommentsFetched,
  recordPlaylistSync,
  setReelStatus,
  upsertReel,
  type RawComment,
  type Reel,
} from "../storage/repository.js";

const MAX_PLAYLIST_TRACKS = 50;

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
    setReelStatus(reel.id, "DONE");
    logger.info(`Reel "${reel.id}" pipeline complete.`);
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

    const inserted = insertComments(reel.id, [...comments, ...captionComments]);
    logger.info(
      `Fetched ${comments.length} comment(s) + ${captionComments.length} caption pick(s) from Instagram for reel "${reel.id}" (${inserted} new).`
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

async function ensureSpotifySynced(reel: Reel): Promise<Reel> {
  if (hasReachedStatus(reel.status, "SPOTIFY_SYNCED")) return reel;

  const rows = getRecommendationsForReel(reel.id);
  const asInput: RecommendationInput[] = rows.map((r) => ({
    artist: r.artist,
    album: r.album,
    song: r.song,
    is_ambiguous: !!r.is_ambiguous,
  }));

  const { ranked, ambiguous } = rankRecommendations(asInput);
  logger.info(
    `Reel "${reel.id}": ${ranked.length} ranked album(s), ${ambiguous.length} ambiguous/unresolved comment(s).`
  );
  setReelStatus(reel.id, "RANKED");

  const trackUris: string[] = [];
  for (const album of ranked) {
    if (trackUris.length >= MAX_PLAYLIST_TRACKS) break;
    const uris = await resolveTrackUris(album);
    trackUris.push(...uris);
  }
  if (trackUris.length > MAX_PLAYLIST_TRACKS) {
    logger.info(`Capping playlist at ${MAX_PLAYLIST_TRACKS} tracks (resolved ${trackUris.length}).`);
    trackUris.length = MAX_PLAYLIST_TRACKS;
  }

  const playlistName = `Vinyl Picks — Week of ${reel.posted_at}`;
  const playlistId = await getOrCreatePlaylist(playlistName);
  await replacePlaylistTracks(playlistId, trackUris);
  recordPlaylistSync(reel.id, "spotify", playlistId, trackUris.length);
  logger.info(`Synced ${trackUris.length} track(s) to Spotify playlist "${playlistName}" (${playlistId}).`);

  setReelStatus(reel.id, "SPOTIFY_SYNCED");
  return getReel(reel.id)!;
}

async function main() {
  const reelIdArg = process.argv[2];
  const reelId = await ensureReelRegistered(reelIdArg);
  await runPipelineForReel(reelId);
}

main().catch((err) => {
  logger.error("Pipeline run failed:", err);
  process.exit(1);
});

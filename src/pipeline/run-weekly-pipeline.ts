import "../config/env.js";
import { parseComments } from "../comment-parser/openai-parser.js";
import { rankRecommendations, type RecommendationInput } from "../ranking/rank.js";
import { logger } from "../shared/logger.js";
import { getOrCreatePlaylist, replacePlaylistTracks, resolveTrackUris } from "../spotify/spotify-client.js";
import {
  applyParsedRecommendations,
  getRecommendationsForReel,
  getReel,
  getUnparsedComments,
  hasReachedStatus,
  markCommentsFetched,
  recordPlaylistSync,
  setReelStatus,
  type Reel,
} from "../storage/repository.js";

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
  // Milestone 1: comments already imported via `npm run import:comments` (CSV path).
  // Milestone 2 will fetch live from the Instagram Graph API here instead.
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
    const uris = await resolveTrackUris(album);
    trackUris.push(...uris);
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
  const reelId = process.argv[2];
  if (!reelId) {
    logger.error("Usage: npm run pipeline -- <reel-id>");
    process.exit(1);
  }
  await runPipelineForReel(reelId);
}

main().catch((err) => {
  logger.error("Pipeline run failed:", err);
  process.exit(1);
});

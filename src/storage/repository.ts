import { getDb } from "./db.js";

export const REEL_STATUSES = [
  "NEW",
  "COMMENTS_FETCHED",
  "PARSED",
  "RANKED",
  "SPOTIFY_SYNCED",
  "APPLE_SYNCED",
  "EMAILED",
  "DONE",
] as const;

export type ReelStatus = (typeof REEL_STATUSES)[number];

export interface Reel {
  id: string;
  posted_at: string;
  fetched_at: string | null;
  status: ReelStatus;
  last_error: string | null;
}

export interface RawComment {
  ig_comment_id: string;
  username: string;
  comment_text: string;
}

export interface ParsedRecommendation {
  ig_comment_id: string;
  artist: string | null;
  album: string | null;
  song: string | null;
  confidence: number | null;
  is_ambiguous: boolean;
}

export interface RecommendationRow {
  id: number;
  reel_id: string;
  ig_comment_id: string;
  username: string;
  comment_text: string;
  artist: string | null;
  album: string | null;
  song: string | null;
  confidence: number | null;
  is_ambiguous: number;
  created_at: string;
}

/** Returns true if `status` has reached at least `threshold` in the pipeline's status order. */
export function hasReachedStatus(status: ReelStatus, threshold: ReelStatus): boolean {
  return REEL_STATUSES.indexOf(status) >= REEL_STATUSES.indexOf(threshold);
}

export function upsertReel(id: string, postedAt: string): Reel {
  const db = getDb();
  db.prepare(
    `INSERT INTO reels (id, posted_at, status) VALUES (?, ?, 'NEW')
     ON CONFLICT(id) DO NOTHING`
  ).run(id, postedAt);
  return getReel(id)!;
}

export function getReel(id: string): Reel | undefined {
  return getDb().prepare(`SELECT * FROM reels WHERE id = ?`).get(id) as Reel | undefined;
}

export function setReelStatus(id: string, status: ReelStatus, lastError: string | null = null): void {
  getDb()
    .prepare(`UPDATE reels SET status = ?, last_error = ? WHERE id = ?`)
    .run(status, lastError, id);
}

export function markCommentsFetched(id: string): void {
  getDb()
    .prepare(`UPDATE reels SET fetched_at = datetime('now') WHERE id = ?`)
    .run(id);
}

export function insertComments(reelId: string, comments: RawComment[]): number {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO recommendations (reel_id, ig_comment_id, username, comment_text)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(ig_comment_id) DO NOTHING`
  );
  const insertMany = db.transaction((rows: RawComment[]) => {
    let count = 0;
    for (const c of rows) {
      const result = insert.run(reelId, c.ig_comment_id, c.username, c.comment_text);
      if (result.changes > 0) count += 1;
    }
    return count;
  });
  return insertMany(comments);
}

export function getUnparsedComments(reelId: string): RecommendationRow[] {
  return getDb()
    .prepare(`SELECT * FROM recommendations WHERE reel_id = ? AND artist IS NULL AND album IS NULL`)
    .all(reelId) as RecommendationRow[];
}

export function applyParsedRecommendations(parsed: ParsedRecommendation[]): void {
  const db = getDb();
  const update = db.prepare(
    `UPDATE recommendations
     SET artist = ?, album = ?, song = ?, confidence = ?, is_ambiguous = ?
     WHERE ig_comment_id = ?`
  );
  const updateMany = db.transaction((rows: ParsedRecommendation[]) => {
    for (const r of rows) {
      update.run(r.artist, r.album, r.song, r.confidence, r.is_ambiguous ? 1 : 0, r.ig_comment_id);
    }
  });
  updateMany(parsed);
}

export function getRecommendationsForReel(reelId: string): RecommendationRow[] {
  return getDb()
    .prepare(`SELECT * FROM recommendations WHERE reel_id = ?`)
    .all(reelId) as RecommendationRow[];
}

export function recordPlaylistSync(
  reelId: string,
  platform: "spotify" | "apple_music",
  playlistId: string,
  trackCount: number
): void {
  getDb()
    .prepare(
      `INSERT INTO playlist_syncs (reel_id, platform, playlist_id, track_count)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(reel_id, platform) DO UPDATE SET
         playlist_id = excluded.playlist_id,
         track_count = excluded.track_count,
         synced_at = datetime('now')`
    )
    .run(reelId, platform, playlistId, trackCount);
}

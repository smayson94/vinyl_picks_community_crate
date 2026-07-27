import nodePath from "node:path";
import { loadEnv } from "../config/env.js";
import { updateEnvFile } from "../config/update-env-file.js";
import { logger } from "../shared/logger.js";
import type { RawComment } from "../storage/repository.js";

const API_VERSION = "v25.0";
const HOST = "https://graph.instagram.com";
const MAX_MEDIA_PAGES_TO_SCAN = 5;

let cachedToken: string | undefined;

function getToken(): string {
  if (cachedToken) return cachedToken;
  const env = loadEnv();
  if (!env.INSTAGRAM_ACCESS_TOKEN) {
    throw new Error(
      "INSTAGRAM_ACCESS_TOKEN is not set. See README for how to generate one via the Meta App Dashboard."
    );
  }
  cachedToken = env.INSTAGRAM_ACCESS_TOKEN;
  return cachedToken;
}

/**
 * Extends the long-lived token's validity another 60 days. Safe to call on any still-valid
 * long-lived token (not just ones nearing expiry), so we just do it once per pipeline run --
 * that keeps the token from ever going stale between weekly runs. Non-fatal on failure: a
 * refresh error just falls back to the existing (still valid) token for this run.
 */
export async function refreshAccessToken(): Promise<void> {
  const token = getToken();
  try {
    const url = `${HOST}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);

    const data = (await res.json()) as { access_token: string; expires_in: number };
    cachedToken = data.access_token;

    const envPath = nodePath.resolve(process.cwd(), ".env");
    updateEnvFile(envPath, "INSTAGRAM_ACCESS_TOKEN", data.access_token);
  } catch (err) {
    logger.warn(
      `Instagram token refresh failed, continuing with existing token: ${err instanceof Error ? err.message : err}`
    );
  }
}

async function igFetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${HOST}/${API_VERSION}${endpoint}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("access_token", getToken());

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Instagram API ${endpoint} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

interface IgMeResponse {
  user_id: string;
  username: string;
}

/** Returns the authorized Instagram professional account's user id (needed to list its media). */
export async function getIgUserId(): Promise<string> {
  const me = await igFetch<IgMeResponse>("/me", { fields: "user_id,username" });
  return me.user_id;
}

interface IgMediaListItem {
  id: string;
  media_product_type?: string;
  timestamp: string;
}

interface IgMediaListResponse {
  data: IgMediaListItem[];
  paging?: { next?: string };
}

/** Scans the account's media (most-recent first) for the latest Reel, a few pages deep at most. */
export async function fetchLatestReelMedia(igUserId: string): Promise<{ id: string; postedAt: string }> {
  let url: string | undefined =
    `${HOST}/${API_VERSION}/${igUserId}/media?fields=id,media_product_type,timestamp&limit=25` +
    `&access_token=${encodeURIComponent(getToken())}`;

  for (let page = 0; url && page < MAX_MEDIA_PAGES_TO_SCAN; page++) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Instagram media list failed: ${res.status} ${await res.text()}`);

    const data = (await res.json()) as IgMediaListResponse;
    const reel = data.data.find((m) => m.media_product_type === "REELS");
    if (reel) return { id: reel.id, postedAt: reel.timestamp.slice(0, 10) };

    url = data.paging?.next;
  }

  throw new Error("No Reel found in the account's recent media.");
}

interface IgMediaMetaResponse {
  timestamp: string;
}

/** Fetches a specific media object's posted-at date, for registering a reel by explicit media id. */
export async function fetchMediaPostedAt(mediaId: string): Promise<string> {
  const media = await igFetch<IgMediaMetaResponse>(`/${mediaId}`, { fields: "timestamp" });
  return media.timestamp.slice(0, 10);
}

interface IgCommentItem {
  id: string;
  text: string;
  username?: string;
  timestamp: string;
}

interface IgCommentsResponse {
  data: IgCommentItem[];
  paging?: { next?: string };
}

/** Fetches every comment on a media object, paginating through the full result set. */
export async function fetchComments(mediaId: string): Promise<RawComment[]> {
  const all: RawComment[] = [];
  let url: string | undefined =
    `${HOST}/${API_VERSION}/${mediaId}/comments?fields=id,text,timestamp,username&limit=50` +
    `&access_token=${encodeURIComponent(getToken())}`;

  while (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Instagram comments fetch failed: ${res.status} ${await res.text()}`);

    const data = (await res.json()) as IgCommentsResponse;
    for (const c of data.data) {
      all.push({ ig_comment_id: c.id, username: c.username ?? "unknown", comment_text: c.text });
    }
    url = data.paging?.next;
  }

  return all;
}

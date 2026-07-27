import path from "node:path";
import { loadEnv } from "../config/env.js";
import { updateEnvFile } from "../config/update-env-file.js";

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cached: CachedToken | undefined;

/**
 * Exchanges the stored refresh_token for a short-lived access_token, persisting Spotify's
 * rotated refresh_token (if any) back to .env so unattended runs don't go stale.
 */
export async function getSpotifyAccessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return cached.accessToken;
  }

  const env = loadEnv();
  if (!env.SPOTIFY_REFRESH_TOKEN) {
    throw new Error(
      "SPOTIFY_REFRESH_TOKEN is not set. Run `npm run setup:spotify` once to authorize this app."
    );
  }

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: env.SPOTIFY_REFRESH_TOKEN,
    }),
  });

  if (!response.ok) {
    throw new Error(`Spotify token refresh failed: ${response.status} ${await response.text()}`);
  }

  const tokens = (await response.json()) as TokenResponse;

  if (tokens.refresh_token && tokens.refresh_token !== env.SPOTIFY_REFRESH_TOKEN) {
    const envPath = path.resolve(process.cwd(), ".env");
    updateEnvFile(envPath, "SPOTIFY_REFRESH_TOKEN", tokens.refresh_token);
  }

  cached = {
    accessToken: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
  return cached.accessToken;
}

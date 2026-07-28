import fs from "node:fs";
import jwt from "jsonwebtoken";
import { loadEnv } from "../config/env.js";

const TOKEN_LIFETIME_SECONDS = 60 * 60; // 1 hour -- well under Apple's 6-month max, regenerated fresh per process since signing is a local operation (no network round-trip).

let cached: { token: string; expiresAt: number } | undefined;

/** Signs (and caches for this process) the ES256 developer JWT Apple Music API calls require. */
export function getDeveloperToken(): string {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const env = loadEnv();
  if (!env.APPLE_MUSIC_TEAM_ID || !env.APPLE_MUSIC_KEY_ID || !env.APPLE_MUSIC_PRIVATE_KEY_PATH) {
    throw new Error(
      "APPLE_MUSIC_TEAM_ID, APPLE_MUSIC_KEY_ID, and APPLE_MUSIC_PRIVATE_KEY_PATH must all be set. See README for how to create a Media ID and private key in the Apple Developer portal."
    );
  }

  const privateKey = fs.readFileSync(env.APPLE_MUSIC_PRIVATE_KEY_PATH, "utf-8");
  const token = jwt.sign({}, privateKey, {
    algorithm: "ES256",
    keyid: env.APPLE_MUSIC_KEY_ID,
    issuer: env.APPLE_MUSIC_TEAM_ID,
    expiresIn: TOKEN_LIFETIME_SECONDS,
  });

  cached = { token, expiresAt: Date.now() + TOKEN_LIFETIME_SECONDS * 1000 };
  return token;
}

/** Returns the stored Music User Token from the one-time `npm run setup:apple-music` authorization. */
export function getMusicUserToken(): string {
  const env = loadEnv();
  if (!env.APPLE_MUSIC_USER_TOKEN) {
    throw new Error("APPLE_MUSIC_USER_TOKEN is not set. Run `npm run setup:apple-music` once to authorize.");
  }
  return env.APPLE_MUSIC_USER_TOKEN;
}

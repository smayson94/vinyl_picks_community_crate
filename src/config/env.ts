import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  SPOTIFY_CLIENT_ID: z.string().min(1, "SPOTIFY_CLIENT_ID is required"),
  SPOTIFY_CLIENT_SECRET: z.string().min(1, "SPOTIFY_CLIENT_SECRET is required"),
  SPOTIFY_REDIRECT_URI: z.string().url().default("http://127.0.0.1:8888/callback"),
  SPOTIFY_REFRESH_TOKEN: z.string().optional(),
  SPOTIFY_PLAYLIST_ID: z.string().optional(),
  DATABASE_PATH: z.string().default("./data/vinylpicks.db"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Validates required env vars once and caches the result; throws immediately on bad config. */
export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

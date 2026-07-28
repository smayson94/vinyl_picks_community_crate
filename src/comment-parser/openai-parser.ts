import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { loadEnv } from "../config/env.js";
import type { ParsedRecommendation, RecommendationRow } from "../storage/repository.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt.js";

const ParsedCommentSchema = z.object({
  id: z.string(),
  artist: z.string().nullable(),
  album: z.string().nullable(),
  song: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  isAmbiguous: z.boolean(),
});

const ParsedBatchSchema = z.object({
  recommendations: z.array(ParsedCommentSchema),
});

const CaptionThemeSchema = z.object({
  theme: z.string().nullable(),
});

const TitleCorrectionSchema = z.object({
  correctedTitle: z.string().nullable(),
});

const SimilarAlbumsSchema = z.object({
  suggestions: z.array(z.object({ artist: z.string(), album: z.string() })),
});

const BATCH_SIZE = 40;

let client: OpenAI | undefined;
function getClient(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: loadEnv().OPENAI_API_KEY });
  return client;
}

const NULL_LIKE_VALUES = new Set(["null", "none", "n/a", "na", "unknown", ""]);

/** OpenAI sometimes emits the literal string "Null" instead of JSON null for a missing field. */
function normalizeNullable(value: string | null): string | null {
  if (value === null) return null;
  return NULL_LIKE_VALUES.has(value.trim().toLowerCase()) ? null : value;
}

/** Parses raw comments into structured {artist, album, song, confidence} via OpenAI structured outputs. */
export async function parseComments(comments: RecommendationRow[]): Promise<ParsedRecommendation[]> {
  const results: ParsedRecommendation[] = [];

  for (let i = 0; i < comments.length; i += BATCH_SIZE) {
    const batch = comments.slice(i, i + BATCH_SIZE);
    const parsed = await parseBatch(batch);
    results.push(...parsed);
  }

  return results;
}

async function parseBatch(batch: RecommendationRow[]): Promise<ParsedRecommendation[]> {
  const input = batch.map((c) => ({ id: c.ig_comment_id, text: c.comment_text }));

  const completion = await getClient().beta.chat.completions.parse({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(input) },
    ],
    response_format: zodResponseFormat(ParsedBatchSchema, "recommendations"),
  });

  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) {
    throw new Error("OpenAI returned no parsed structured output for comment batch.");
  }

  const byId = new Map(parsed.recommendations.map((r) => [r.id, r]));

  return batch.map((c) => {
    const r = byId.get(c.ig_comment_id);
    if (!r) {
      return {
        ig_comment_id: c.ig_comment_id,
        artist: null,
        album: null,
        song: null,
        confidence: 0,
        is_ambiguous: true,
      };
    }
    return {
      ig_comment_id: r.id,
      artist: normalizeNullable(r.artist),
      album: normalizeNullable(r.album),
      song: normalizeNullable(r.song),
      confidence: r.confidence,
      is_ambiguous: r.isAmbiguous,
    };
  });
}

const THEME_SYSTEM_PROMPT = `You read the caption of a weekly "Vinyl Picks" Instagram post, where a host
features a few records tied together by a shared theme or genre.

Return a short (2-4 word) theme label capturing what this week's picks have in common
(e.g. "Psychedelic Rock", "Motown Classics", "90s Hip-Hop", "Female Vocalists"). Prefer the
host's own wording when the caption states a genre/theme explicitly. If the caption gives no
clear theme, return null rather than guessing.`;

/** Extracts a short theme label (e.g. "Psychedelic Rock") from a Vinyl Picks caption, for playlist naming. */
export async function extractCaptionTheme(caption: string): Promise<string | null> {
  const completion = await getClient().beta.chat.completions.parse({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: THEME_SYSTEM_PROMPT },
      { role: "user", content: caption },
    ],
    response_format: zodResponseFormat(CaptionThemeSchema, "theme"),
  });

  const parsed = completion.choices[0]?.message.parsed;
  return normalizeNullable(parsed?.theme ?? null);
}

/**
 * Suggests the real, exactly-formatted release title when a literal Spotify search comes up
 * empty -- catches stylized punctuation/spelling variants a comment used (e.g. a fan writing
 * "Our Days Mind the Thyme" for the real title "Our Days Mind the Tyme", or "Wake Up It's
 * Tomorrow" for the actual "Wake Up...It's Tomorrow"). Relies on the model's own knowledge of
 * real discographies, so it's a best-effort retry, not guaranteed to know every release.
 */
export async function suggestCorrectedTitle(
  kind: "album" | "song",
  name: string,
  artist: string
): Promise<string | null> {
  const completion = await getClient().beta.chat.completions.parse({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You know real music release titles precisely, including exact punctuation and stylization.
Given an artist and a ${kind} name that may be slightly misspelled, mis-punctuated, or paraphrased
from how a fan wrote it in a comment, return the exact title as it is actually released.
If you don't confidently know the real release, or the given name already looks correct as-is,
return null rather than guessing.`,
      },
      { role: "user", content: `Artist: ${artist}\n${kind === "album" ? "Album" : "Song"}: ${name}` },
    ],
    response_format: zodResponseFormat(TitleCorrectionSchema, "correction"),
  });

  const parsed = completion.choices[0]?.message.parsed;
  const corrected = normalizeNullable(parsed?.correctedTitle ?? null);
  return corrected && corrected.trim().toLowerCase() !== name.trim().toLowerCase() ? corrected : null;
}

const SIMILAR_ALBUMS_SYSTEM_PROMPT = `You have deep knowledge of real music discographies. Given a handful of
seed artists and (optionally) a genre/theme, suggest real, existing albums in a similar vein --
similar genre, era, or mood -- that a fan of the seed artists would likely enjoy.

Only suggest albums you are confident actually exist and are correctly titled and credited. Do not
suggest anything already in the excluded list. Prefer well-known, widely-available albums over
obscure ones you're less sure about.`;

/**
 * Suggests real similar albums for weeks with too few community/caption recommendations to fill
 * a playlist on their own. Spotify's own recommendations/related-artists endpoints return
 * 403/404 for this app (confirmed -- Development Mode restriction), so this substitutes an
 * LLM-driven suggestion step, with results resolved through the normal catalog search afterward
 * rather than trusted directly.
 */
export async function suggestSimilarAlbums(
  seedArtists: string[],
  theme: string | null,
  exclude: string[],
  count: number
): Promise<{ artist: string; album: string }[]> {
  const prompt = [
    `Seed artists: ${seedArtists.join(", ")}`,
    theme ? `Theme: ${theme}` : null,
    exclude.length ? `Already included, do not repeat: ${exclude.join("; ")}` : null,
    `Suggest ${count} similar albums.`,
  ]
    .filter(Boolean)
    .join("\n");

  const completion = await getClient().beta.chat.completions.parse({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SIMILAR_ALBUMS_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    response_format: zodResponseFormat(SimilarAlbumsSchema, "suggestions"),
  });

  const parsed = completion.choices[0]?.message.parsed;
  return parsed?.suggestions ?? [];
}

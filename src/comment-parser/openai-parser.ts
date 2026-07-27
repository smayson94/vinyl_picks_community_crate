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

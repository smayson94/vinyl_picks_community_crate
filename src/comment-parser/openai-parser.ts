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

const BATCH_SIZE = 40;

let client: OpenAI | undefined;
function getClient(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: loadEnv().OPENAI_API_KEY });
  return client;
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
      artist: r.artist,
      album: r.album,
      song: r.song,
      confidence: r.confidence,
      is_ambiguous: r.isAmbiguous,
    };
  });
}

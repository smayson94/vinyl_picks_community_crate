import { describe, expect, it } from "vitest";
import { getCaptionOnlyAlbums } from "../src/pipeline/track-selection.js";
import type { RecommendationRow } from "../src/storage/repository.js";

function row(partial: Partial<RecommendationRow>): RecommendationRow {
  return {
    id: 0,
    reel_id: "reel-1",
    ig_comment_id: "c0",
    username: "someone",
    comment_text: "",
    artist: null,
    album: null,
    song: null,
    confidence: null,
    is_ambiguous: 0,
    created_at: "",
    ...partial,
  };
}

describe("getCaptionOnlyAlbums", () => {
  it("extracts only resolved, non-ambiguous caption-sourced rows", () => {
    const rows: RecommendationRow[] = [
      row({ username: "caption", artist: "Sonny Rollins", album: "Don't Ask" }),
      row({ username: "caption", artist: "Earth, Wind & Fire", album: "Gratitude" }),
      row({ username: "somefan", artist: "Sonny Rollins", album: "Don't Ask" }), // community, not caption
      row({ username: "caption", artist: null, album: null, is_ambiguous: 1 }), // unresolved caption line
    ];

    const albums = getCaptionOnlyAlbums(rows);

    expect(albums).toHaveLength(2);
    expect(albums.map((a) => a.album).sort()).toEqual(["Don't Ask", "Gratitude"]);
  });

  it("merges a caption pick with a fuzzy-matching duplicate caption row", () => {
    const rows: RecommendationRow[] = [
      row({ username: "caption", artist: "Earth, Wind & Fire", album: "Gratitude" }),
      row({ username: "caption", artist: "Earth Wind and Fire", album: "Gratitude" }),
    ];

    const albums = getCaptionOnlyAlbums(rows);

    expect(albums).toHaveLength(1);
    expect(albums[0].mentionCount).toBe(2);
  });

  it("returns an empty array when there are no caption picks", () => {
    const rows: RecommendationRow[] = [row({ username: "somefan", artist: "X", album: "Y" })];
    expect(getCaptionOnlyAlbums(rows)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { getCaptionOnlyAlbums, selectTracksForVariety } from "../src/pipeline/track-selection.js";
import type { RankedAlbum } from "../src/ranking/rank.js";
import type { RecommendationRow } from "../src/storage/repository.js";

function rankedAlbum(album: string, score = 1): RankedAlbum {
  return { artist: `Artist of ${album}`, album, songs: [], mentionCount: score, score };
}

/** Fake resolver: each album "has" 2 tracks, named after the album, for deterministic assertions. */
async function fakeResolve(album: RankedAlbum, tracksPerAlbum: number): Promise<string[]> {
  return [`${album.album}-1`, `${album.album}-2`].slice(0, tracksPerAlbum);
}

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
    like_count: 0,
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

describe("selectTracksForVariety", () => {
  it("gives every album just 1 track when there are enough albums to fill the playlist", async () => {
    const ranked = Array.from({ length: 10 }, (_, i) => rankedAlbum(`Album${i}`, 10 - i));

    const tracks = await selectTracksForVariety(ranked, { maxTracks: 10, resolveAlbum: fakeResolve });

    expect(tracks).toHaveLength(10);
    // one track per album (the "-1" track), none doubled up, in rank order
    expect(tracks).toEqual(ranked.map((a) => `${a.album}-1`));
  });

  it("gives albums a second track (round-robin) when there are fewer albums than the target", async () => {
    const ranked = [rankedAlbum("A", 3), rankedAlbum("B", 2), rankedAlbum("C", 1)];

    const tracks = await selectTracksForVariety(ranked, { maxTracks: 6, resolveAlbum: fakeResolve });

    // round 0: one from each (A-1, B-1, C-1), round 1: second from each (A-2, B-2, C-2)
    expect(tracks).toEqual(["A-1", "B-1", "C-1", "A-2", "B-2", "C-2"]);
  });

  it("never resolves more albums than could possibly fit", async () => {
    let resolveCalls = 0;
    const ranked = Array.from({ length: 20 }, (_, i) => rankedAlbum(`Album${i}`, 20 - i));

    await selectTracksForVariety(ranked, {
      maxTracks: 5,
      resolveAlbum: async (album, n) => {
        resolveCalls++;
        return fakeResolve(album, n);
      },
    });

    expect(resolveCalls).toBe(5); // not all 20 -- bounded to maxTracks candidates
  });
});

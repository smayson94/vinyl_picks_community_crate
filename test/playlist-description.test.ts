import { describe, expect, it } from "vitest";
import { buildPlaylistDescription } from "../src/pipeline/playlist-format.js";
import type { RankedAlbum } from "../src/ranking/rank.js";

function album(partial: Partial<RankedAlbum>): RankedAlbum {
  return { artist: "Some Artist", album: "Some Album", songs: [], mentionCount: 1, ...partial };
}

describe("buildPlaylistDescription", () => {
  it("credits the community and lists up to 3 top picks", () => {
    const ranked = [
      album({ artist: "Emerson, Lake & Palmer", album: "Tarkus" }),
      album({ artist: "Funkadelic", album: "Maggot Brain" }),
      album({ artist: "Santana", album: "Love Devotion Surrender" }),
      album({ artist: "Can", album: "Ege Bamyası" }),
    ];

    const description = buildPlaylistDescription(ranked);

    expect(description).toContain("Tarkus (Emerson, Lake & Palmer)");
    expect(description).toContain("Maggot Brain (Funkadelic)");
    expect(description).toContain("Love Devotion Surrender (Santana)");
    expect(description).not.toContain("Ege Bamyası");
    expect(description).toContain("Drop your recommendations on the next post!");
  });

  it("falls back to a generic message when nothing resolved", () => {
    const description = buildPlaylistDescription([]);
    expect(description).toContain("built from your comments");
    expect(description).not.toContain("Top picks:");
  });

  it("never exceeds Spotify's 300-character description limit", () => {
    const ranked = Array.from({ length: 3 }, (_, i) =>
      album({
        artist: "A Very Long Artist Name That Goes On".repeat(2),
        album: `Album Number ${i}`.repeat(3),
      })
    );

    const description = buildPlaylistDescription(ranked);
    expect(description.length).toBeLessThanOrEqual(300);
  });
});

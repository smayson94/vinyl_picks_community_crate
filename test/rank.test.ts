import { describe, expect, it } from "vitest";
import { rankRecommendations, type RecommendationInput } from "../src/ranking/rank.js";

function rec(partial: Partial<RecommendationInput>): RecommendationInput {
  return { artist: null, album: null, song: null, is_ambiguous: false, ...partial };
}

describe("rankRecommendations", () => {
  it("ranks resolved albums by mention count, descending", () => {
    const input: RecommendationInput[] = [
      rec({ artist: "Funkadelic", album: "Maggot Brain" }),
      rec({ artist: "Funkadelic", album: "Maggot Brain" }),
      rec({ artist: "Can", album: "Future Days" }),
      rec({ artist: "Funkadelic", album: "Maggot Brain" }),
      rec({ artist: "Can", album: "Future Days" }),
      rec({ artist: "Pink Floyd", album: "Dark Side of the Moon" }),
    ];

    const { ranked } = rankRecommendations(input);

    expect(ranked.map((r) => r.album)).toEqual(["Maggot Brain", "Future Days", "Dark Side of the Moon"]);
    expect(ranked[0].mentionCount).toBe(3);
    expect(ranked[1].mentionCount).toBe(2);
    expect(ranked[2].mentionCount).toBe(1);
  });

  it("separates ambiguous or incomplete recommendations from ranked results", () => {
    const input: RecommendationInput[] = [
      rec({ artist: "Miles Davis", album: "Bitches Brew" }),
      rec({ artist: "Steely Dan", album: null, is_ambiguous: true }),
      rec({ artist: null, album: null, is_ambiguous: true }),
    ];

    const { ranked, ambiguous } = rankRecommendations(input);

    expect(ranked).toHaveLength(1);
    expect(ranked[0].album).toBe("Bitches Brew");
    expect(ambiguous).toHaveLength(2);
  });

  it("collects distinct named songs for a ranked album", () => {
    const input: RecommendationInput[] = [
      rec({ artist: "Pink Floyd", album: "Dark Side of the Moon", song: "Time" }),
      rec({ artist: "Pink Floyd", album: "Dark Side of the Moon", song: "Money" }),
      rec({ artist: "Pink Floyd", album: "Dark Side of the Moon", song: "Time" }),
    ];

    const { ranked } = rankRecommendations(input);

    expect(ranked[0].mentionCount).toBe(3);
    expect(ranked[0].songs.sort()).toEqual(["Money", "Time"]);
  });
});

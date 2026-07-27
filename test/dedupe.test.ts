import { describe, expect, it } from "vitest";
import { fuzzyEqual, groupByFuzzyMatch, levenshtein, normalizeText } from "../src/ranking/dedupe.js";

describe("normalizeText", () => {
  it("lowercases, strips punctuation, and collapses whitespace", () => {
    expect(normalizeText("Dark Side of the Moon!!")).toBe("dark side of the moon");
    expect(normalizeText("  Steely   Dan  ")).toBe("steely dan");
  });
});

describe("levenshtein", () => {
  it("computes edit distance", () => {
    expect(levenshtein("maggot brain", "maggot brain")).toBe(0);
    expect(levenshtein("magot brain", "maggot brain")).toBe(1);
    expect(levenshtein("", "abc")).toBe(3);
  });
});

describe("fuzzyEqual", () => {
  it("matches exact normalized strings", () => {
    expect(fuzzyEqual("Dark Side of the Moon", "dark side of the moon")).toBe(true);
  });

  it("matches near-miss typos within threshold", () => {
    expect(fuzzyEqual("Maggot Brain", "Magot Brain")).toBe(true);
  });

  it("rejects genuinely different albums", () => {
    expect(fuzzyEqual("Dark Side of the Moon", "Wish You Were Here")).toBe(false);
  });
});

describe("groupByFuzzyMatch", () => {
  it("groups entries whose artist+album fuzzy-match", () => {
    const entries = [
      { artist: "Funkadelic", album: "Maggot Brain" },
      { artist: "funkadelic", album: "maggot brain!!" },
      { artist: "Funkadelic", album: "Magot Brain" },
      { artist: "Pink Floyd", album: "Dark Side of the Moon" },
    ];

    const groups = groupByFuzzyMatch(entries);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(3);
    expect(groups[1]).toHaveLength(1);
  });
});

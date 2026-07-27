import { describe, expect, it } from "vitest";
import { parseCommentsCsv } from "../src/instagram/csv-import.js";

describe("parseCommentsCsv", () => {
  it("parses rows with a username,comment header", () => {
    const csv = ["username,comment", "alice,Dark Side of the Moon", "bob,Check out Maggot Brain!!"].join("\n");

    const comments = parseCommentsCsv(csv, "reel-1");

    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({ username: "alice", comment_text: "Dark Side of the Moon" });
    expect(comments[0].ig_comment_id).toBe("reel-1:manual:0");
    expect(comments[1]).toMatchObject({ username: "bob", comment_text: "Check out Maggot Brain!!" });
  });

  it("respects an explicit comment_id column when present", () => {
    const csv = ["username,comment,comment_id", "alice,Bitches Brew,ig_123"].join("\n");

    const comments = parseCommentsCsv(csv, "reel-1");

    expect(comments[0].ig_comment_id).toBe("ig_123");
  });

  it("handles quoted fields containing commas", () => {
    const csv = ["username,comment", 'alice,"Steely Dan, obviously"'].join("\n");

    const comments = parseCommentsCsv(csv, "reel-1");

    expect(comments[0].comment_text).toBe("Steely Dan, obviously");
  });

  it("throws if required columns are missing", () => {
    const csv = ["user,text", "alice,hello"].join("\n");
    expect(() => parseCommentsCsv(csv, "reel-1")).toThrow(/username.*comment/);
  });

  it("returns an empty array for empty input", () => {
    expect(parseCommentsCsv("", "reel-1")).toEqual([]);
  });
});

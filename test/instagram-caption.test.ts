import { describe, expect, it } from "vitest";
import { extractCaptionPickLines } from "../src/instagram/instagram-client.js";

const REAL_CAPTION = `💿 Vinyl picks of the week. Sometimes the best trips don't require leaving your listening room.

Psychedelic rock has always been one of my favorite genres to get lost in. Between the guitars, the experimentation, and the musicianship, these are three records from my collection that I keep coming back to.

This week's picks:

🍄 Emerson, Lake & Palmer –Tarkus
🍄 Santana & John McLaughlin – Love Devotion Surrender
🍄 Robin Trower – Twice Removed From Yesterday

Every one of these records takes you somewhere different. That's what makes psychedelic music so much fun to explore.

#VinylCommunity #PsychedelicRock #RecordCollection #NowSpinning #VinylRecords`;

describe("extractCaptionPickLines", () => {
  it("extracts only the bullet pick lines from a real caption", () => {
    const lines = extractCaptionPickLines(REAL_CAPTION);
    expect(lines).toEqual([
      "🍄 Emerson, Lake & Palmer –Tarkus",
      "🍄 Santana & John McLaughlin – Love Devotion Surrender",
      "🍄 Robin Trower – Twice Removed From Yesterday",
    ]);
  });

  it("returns an empty array when there are no dash-separated lines", () => {
    expect(extractCaptionPickLines("Just a caption with no picks listed.")).toEqual([]);
  });
});

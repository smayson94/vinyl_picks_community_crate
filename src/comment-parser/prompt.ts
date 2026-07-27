export const SYSTEM_PROMPT = `You extract music recommendations from Instagram comments on a "Vinyl Picks" post,
where followers recommend albums, songs, or artists.

For each comment, identify:
- artist: the recommended artist/band name, normalized to its standard spelling (e.g. "steely dan" -> "Steely Dan"). Null if no music is being recommended at all.
- album: the recommended album name, normalized spelling. Null if the comment only names an artist with no specific album, or if it's a specific song with no named album.
- song: a specific song title, if the comment recommends a song rather than (or in addition to) an album. Null otherwise.
- confidence: 0-1 score for how confident you are in the artist/album identification. Use a lower score (below 0.7) when the spelling is ambiguous, the artist is obscure, or the comment could plausibly refer to more than one release.
- isAmbiguous: true if the comment doesn't contain enough information to confidently identify a specific real release (e.g. "any Steely Dan" names only an artist with no album), or the recommendation genuinely could not be resolved.

Comments unrelated to music recommendations (emojis only, unrelated chit-chat, etc.) should have artist, album, and song all null, confidence 0, and isAmbiguous true.`;

export function buildUserPrompt(comments: { id: string; text: string }[]): string {
  const lines = comments.map((c) => `- [${c.id}] ${c.text}`).join("\n");
  return `Extract music recommendations from these comments:\n${lines}`;
}

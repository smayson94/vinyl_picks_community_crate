import type { RankedAlbum } from "../ranking/rank.js";
import type { Reel } from "../storage/repository.js";

export function playlistNameFor(reel: Reel): string {
  return reel.theme ? `Community Crate - ${reel.theme}` : `Community Crate - Week of ${reel.posted_at}`;
}

const MAX_DESCRIPTION_LENGTH = 300; // Spotify's playlist description limit

/** Credits the community and surfaces this week's top picks, with a call-to-action for the next post. */
export function buildPlaylistDescription(ranked: RankedAlbum[]): string {
  const topPicks = ranked
    .slice(0, 3)
    .map((a) => `${a.album} (${a.artist})`)
    .join(", ");

  const base = topPicks
    ? `Community Crate: built from your comments on this week's Vinyl Picks. Top picks: ${topPicks}. Drop your recommendations on the next post!`
    : `Community Crate: built from your comments on this week's Vinyl Picks. Drop your recommendations on the next post!`;

  return base.length > MAX_DESCRIPTION_LENGTH ? `${base.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…` : base;
}

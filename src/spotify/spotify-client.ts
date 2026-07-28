import { suggestCorrectedTitle } from "../comment-parser/openai-parser.js";
import { loadEnv } from "../config/env.js";
import { fuzzyEqual } from "../ranking/dedupe.js";
import type { RankedAlbum } from "../ranking/rank.js";
import { logger } from "../shared/logger.js";
import { getSpotifyAccessToken } from "./spotify-auth.js";

const API_BASE = "https://api.spotify.com/v1";
const TRACKS_PER_ALBUM = 2;
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_AUTO_RETRY_WAIT_SECONDS = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A single resolveTrackUris() call can burst through a dozen+ Spotify requests (search, album
 * tracks, retries), so a rolling per-minute rate limit is something this app can trip on its own
 * within one run -- observed live: retrying the whole pipeline minutes apart hit the identical
 * request every time, which pointed to a self-inflicted burst limit rather than a slow-to-reset
 * quota. Short waits (bounded by Retry-After, capped) are retried automatically; anything longer
 * fails fast with a clear message instead of silently blocking for a long time.
 */
async function spotifyFetch<T>(pathAndQuery: string, init: RequestInit = {}, attempt = 0): Promise<T> {
  const accessToken = await getSpotifyAccessToken();
  const response = await fetch(`${API_BASE}${pathAndQuery}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : 2 ** (attempt + 1);

    if (attempt < MAX_RATE_LIMIT_RETRIES && retryAfterSeconds <= MAX_AUTO_RETRY_WAIT_SECONDS) {
      logger.warn(
        `Spotify rate limit hit on ${pathAndQuery} — waiting ${retryAfterSeconds}s before retry ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}.`
      );
      await sleep(retryAfterSeconds * 1000);
      return spotifyFetch<T>(pathAndQuery, init, attempt + 1);
    }

    throw new Error(
      `Spotify API ${pathAndQuery} rate limited (429)` +
        (retryAfterHeader
          ? ` — Retry-After ${retryAfterHeader}s is longer than this app auto-waits; re-run once that's passed.`
          : " — no Retry-After given; this may be a longer Development Mode quota window, try again later.")
    );
  }

  if (!response.ok) {
    throw new Error(`Spotify API ${pathAndQuery} failed: ${response.status} ${await response.text()}`);
  }

  // Some endpoints (e.g. PUT /playlists/{id}) return 200 with an empty body rather than 204,
  // so a status check alone isn't reliable -- read the raw text and only parse it if non-empty.
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

interface SpotifySearchAlbumsResponse {
  albums: { items: { id: string; artists: { name: string }[] }[] };
}

interface SpotifyAlbumTracksResponse {
  items: { uri: string }[];
}

interface SpotifySearchTracksResponse {
  tracks: { items: { uri: string }[] };
}

/**
 * Quotes a value for Spotify's field-qualified search syntax (e.g. album:"Ave Sangria").
 * Unquoted multi-word values get misparsed -- e.g. `album:Ave Sangria artist:Ave Sangria`
 * returns zero results, while `album:"Ave Sangria" artist:"Ave Sangria"` finds it correctly.
 */
function quoteForSearch(value: string): string {
  return `"${value.replace(/"/g, "")}"`;
}

async function searchAlbumId(query: string): Promise<string | undefined> {
  const result = await spotifyFetch<SpotifySearchAlbumsResponse>(
    `/search?type=album&limit=1&q=${encodeURIComponent(query)}`
  );
  return result.albums.items[0]?.id;
}

/**
 * Plain, unquoted free-text search -- more forgiving of small punctuation/spacing differences
 * than the field-qualified search above, but also more prone to spurious top-relevance matches
 * (e.g. a plain "Nonagon Infinity" search returns unrelated bands with "Infinity" in the name).
 * Only accepted if the returned artist genuinely fuzzy-matches the one we're looking for.
 */
async function searchAlbumIdFreeText(albumName: string, artistName: string): Promise<string | undefined> {
  const result = await spotifyFetch<SpotifySearchAlbumsResponse>(
    `/search?type=album&limit=1&q=${encodeURIComponent(`${albumName} ${artistName}`)}`
  );
  const top = result.albums.items[0];
  if (!top) return undefined;
  const artistMatches = top.artists.some((a) => fuzzyEqual(a.name, artistName));
  return artistMatches ? top.id : undefined;
}

/** Resolves a ranked album (plus any specifically-named songs) to a small set of Spotify track URIs. */
export async function resolveTrackUris(album: RankedAlbum, tracksPerAlbum: number = TRACKS_PER_ALBUM): Promise<string[]> {
  const uris: string[] = [];

  for (const song of album.songs) {
    const query = encodeURIComponent(`track:${quoteForSearch(song)} artist:${quoteForSearch(album.artist)}`);
    const result = await spotifyFetch<SpotifySearchTracksResponse>(
      `/search?type=track&limit=1&q=${query}`
    );
    const uri = result.tracks.items[0]?.uri;
    if (uri) uris.push(uri);
  }

  if (uris.length >= tracksPerAlbum) return uris.slice(0, tracksPerAlbum);

  // Every path here verifies the artist before accepting a match. An earlier version also fell
  // back to an unverified album-title-only search as a last resort (to catch albums Spotify
  // credits differently than a commenter did, e.g. a collaboration credited to the other artist)
  // -- but backfilling real historical weeks showed that path is genuinely unsafe: of 5 unverified
  // matches in one batch, 3 were wrong (a JMSN album resolved to an unrelated Matt Dusk track, an
  // Average White Band album resolved to a Debussy classical piano collection, another AWB album
  // resolved to a different artist entirely). A same-titled-but-wrong album slipping into a public
  // "community crate" playlist is worse than occasionally skipping a real but mis-credited one, so
  // this app now only ever adds a track it can verify actually matches the artist.
  let albumId = await searchAlbumId(`album:${quoteForSearch(album.album)} artist:${quoteForSearch(album.artist)}`);

  if (!albumId) {
    // Field-qualified search does near-exact string matching, fragile to even a single stray
    // space or punctuation mark -- a plain free-text search is more forgiving, guarded by an
    // artist-match check so an irrelevant top hit can't slip through.
    albumId = await searchAlbumIdFreeText(album.album, album.artist);
    if (albumId) logger.info(`Resolved "${album.album}" via free-text fallback search.`);
  }

  if (!albumId) {
    // A comment's spelling/punctuation of the title may not match the real release exactly (e.g.
    // "Wake Up It's Tomorrow" for the actual "Wake Up...It's Tomorrow") -- ask the model for the
    // exact real title and retry both verified paths once more.
    const corrected = await suggestCorrectedTitle("album", album.album, album.artist);
    if (corrected) {
      albumId = await searchAlbumId(`album:${quoteForSearch(corrected)} artist:${quoteForSearch(album.artist)}`);
      if (!albumId) albumId = await searchAlbumIdFreeText(corrected, album.artist);
      if (albumId) logger.info(`Resolved "${album.album}" via corrected title "${corrected}".`);
    }
  }

  if (albumId) {
    const tracks = await spotifyFetch<SpotifyAlbumTracksResponse>(
      `/albums/${albumId}/tracks?limit=${tracksPerAlbum}`
    );
    for (const t of tracks.items) {
      if (!uris.includes(t.uri) && uris.length < tracksPerAlbum) uris.push(t.uri);
    }
  }

  if (uris.length === 0) {
    logger.warn(`No Spotify match found for "${album.album}" by ${album.artist} — skipping.`);
  }

  return uris;
}

interface SpotifyPlaylist {
  id: string;
  name: string;
}

interface SpotifyPlaylistsResponse {
  items: SpotifyPlaylist[];
}

async function findPlaylistByName(name: string): Promise<string | undefined> {
  const result = await spotifyFetch<SpotifyPlaylistsResponse>(`/me/playlists?limit=50`);
  return result.items.find((p) => p.name === name)?.id;
}

/** Returns the target playlist id: env override, else an existing playlist with this name, else a new one. */
export async function getOrCreatePlaylist(name: string): Promise<string> {
  const env = loadEnv();
  if (env.SPOTIFY_PLAYLIST_ID) return env.SPOTIFY_PLAYLIST_ID;

  const existingId = await findPlaylistByName(name);
  if (existingId) return existingId;

  const created = await spotifyFetch<SpotifyPlaylist>(`/me/playlists`, {
    method: "POST",
    body: JSON.stringify({
      name,
      public: true,
      description: "Auto-generated from Vinyl Picks community recommendations.",
    }),
  });
  return created.id;
}

/**
 * Updates a playlist's name and/or description -- e.g. to credit the community and list this
 * week's top picks, or to rename it when a re-run's theme extraction comes out differently
 * (the model isn't perfectly deterministic run to run).
 */
export async function updatePlaylistDetails(
  playlistId: string,
  details: { name?: string; description?: string }
): Promise<void> {
  await spotifyFetch(`/playlists/${playlistId}`, {
    method: "PUT",
    body: JSON.stringify(details),
  });
}

/** Replaces the playlist's full tracklist with `trackUris`, in order (Spotify caps a single request at 100 URIs). */
export async function replacePlaylistTracks(playlistId: string, trackUris: string[]): Promise<void> {
  const first100 = trackUris.slice(0, 100);
  await spotifyFetch(`/playlists/${playlistId}/items`, {
    method: "PUT",
    body: JSON.stringify({ uris: first100 }),
  });

  for (let i = 100; i < trackUris.length; i += 100) {
    await spotifyFetch(`/playlists/${playlistId}/items`, {
      method: "POST",
      body: JSON.stringify({ uris: trackUris.slice(i, i + 100) }),
    });
  }
}

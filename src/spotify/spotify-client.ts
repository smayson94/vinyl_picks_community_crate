import { suggestCorrectedTitle } from "../comment-parser/openai-parser.js";
import { loadEnv } from "../config/env.js";
import { fuzzyEqual } from "../ranking/dedupe.js";
import type { RankedAlbum } from "../ranking/rank.js";
import { logger } from "../shared/logger.js";
import { getSpotifyAccessToken } from "./spotify-auth.js";

const API_BASE = "https://api.spotify.com/v1";
const TRACKS_PER_ALBUM = 2;

async function spotifyFetch<T>(pathAndQuery: string, init: RequestInit = {}): Promise<T> {
  const accessToken = await getSpotifyAccessToken();
  const response = await fetch(`${API_BASE}${pathAndQuery}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Spotify API ${pathAndQuery} failed: ${response.status} ${await response.text()}`);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
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
export async function resolveTrackUris(album: RankedAlbum): Promise<string[]> {
  const uris: string[] = [];

  for (const song of album.songs) {
    const query = encodeURIComponent(`track:${quoteForSearch(song)} artist:${quoteForSearch(album.artist)}`);
    const result = await spotifyFetch<SpotifySearchTracksResponse>(
      `/search?type=track&limit=1&q=${query}`
    );
    const uri = result.tracks.items[0]?.uri;
    if (uri) uris.push(uri);
  }

  if (uris.length >= TRACKS_PER_ALBUM) return uris.slice(0, TRACKS_PER_ALBUM);

  let albumId = await searchAlbumId(`album:${quoteForSearch(album.album)} artist:${quoteForSearch(album.artist)}`);
  if (!albumId) {
    // Spotify sometimes credits an album to different/additional artists than the one a commenter
    // named (e.g. a collaboration album credited primarily to the other artist) -- an album-title-only
    // search still reliably finds the right record in that case.
    albumId = await searchAlbumId(`album:${quoteForSearch(album.album)}`);
  }
  if (!albumId) {
    // A comment's spelling/punctuation of the title may not match the real release exactly (e.g.
    // "Wake Up It's Tomorrow" for the actual "Wake Up...It's Tomorrow") -- ask the model for the
    // exact real title and retry once.
    const corrected = await suggestCorrectedTitle("album", album.album, album.artist);
    if (corrected) {
      albumId = await searchAlbumId(`album:${quoteForSearch(corrected)} artist:${quoteForSearch(album.artist)}`);
      if (!albumId) albumId = await searchAlbumId(`album:${quoteForSearch(corrected)}`);
      if (albumId) logger.info(`Resolved "${album.album}" via corrected title "${corrected}".`);
    }
  }
  if (!albumId) {
    // Last resort: field-qualified search does near-exact string matching, fragile to even a
    // single stray space or punctuation mark -- a plain free-text search is more forgiving,
    // guarded by an artist-match check so an irrelevant top hit can't slip through.
    albumId = await searchAlbumIdFreeText(album.album, album.artist);
    if (albumId) logger.info(`Resolved "${album.album}" via free-text fallback search.`);
  }

  if (albumId) {
    const tracks = await spotifyFetch<SpotifyAlbumTracksResponse>(
      `/albums/${albumId}/tracks?limit=${TRACKS_PER_ALBUM}`
    );
    for (const t of tracks.items) {
      if (!uris.includes(t.uri) && uris.length < TRACKS_PER_ALBUM) uris.push(t.uri);
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

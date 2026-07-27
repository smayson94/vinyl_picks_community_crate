import { loadEnv } from "../config/env.js";
import { logger } from "../shared/logger.js";
import type { RankedAlbum } from "../ranking/rank.js";
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
  albums: { items: { id: string }[] };
}

interface SpotifyAlbumTracksResponse {
  items: { uri: string }[];
}

interface SpotifySearchTracksResponse {
  tracks: { items: { uri: string }[] };
}

/** Resolves a ranked album (plus any specifically-named songs) to a small set of Spotify track URIs. */
export async function resolveTrackUris(album: RankedAlbum): Promise<string[]> {
  const uris: string[] = [];

  for (const song of album.songs) {
    const query = encodeURIComponent(`track:${song} artist:${album.artist}`);
    const result = await spotifyFetch<SpotifySearchTracksResponse>(
      `/search?type=track&limit=1&q=${query}`
    );
    const uri = result.tracks.items[0]?.uri;
    if (uri) uris.push(uri);
  }

  if (uris.length >= TRACKS_PER_ALBUM) return uris.slice(0, TRACKS_PER_ALBUM);

  const albumQuery = encodeURIComponent(`album:${album.album} artist:${album.artist}`);
  const albumResult = await spotifyFetch<SpotifySearchAlbumsResponse>(
    `/search?type=album&limit=1&q=${albumQuery}`
  );
  const albumId = albumResult.albums.items[0]?.id;

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

interface SpotifyMeResponse {
  id: string;
}

interface SpotifyPlaylist {
  id: string;
  name: string;
}

interface SpotifyPlaylistsResponse {
  items: SpotifyPlaylist[];
}

async function findPlaylistByName(userId: string, name: string): Promise<string | undefined> {
  const result = await spotifyFetch<SpotifyPlaylistsResponse>(`/me/playlists?limit=50`);
  return result.items.find((p) => p.name === name)?.id;
}

/** Returns the target playlist id: env override, else an existing playlist with this name, else a new one. */
export async function getOrCreatePlaylist(name: string): Promise<string> {
  const env = loadEnv();
  if (env.SPOTIFY_PLAYLIST_ID) return env.SPOTIFY_PLAYLIST_ID;

  const me = await spotifyFetch<SpotifyMeResponse>("/me");
  const existingId = await findPlaylistByName(me.id, name);
  if (existingId) return existingId;

  const created = await spotifyFetch<SpotifyPlaylist>(`/users/${me.id}/playlists`, {
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
  await spotifyFetch(`/playlists/${playlistId}/tracks`, {
    method: "PUT",
    body: JSON.stringify({ uris: first100 }),
  });

  for (let i = 100; i < trackUris.length; i += 100) {
    await spotifyFetch(`/playlists/${playlistId}/tracks`, {
      method: "POST",
      body: JSON.stringify({ uris: trackUris.slice(i, i + 100) }),
    });
  }
}

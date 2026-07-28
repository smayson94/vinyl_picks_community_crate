import { suggestCorrectedTitle } from "../comment-parser/openai-parser.js";
import { loadEnv } from "../config/env.js";
import { fuzzyEqual } from "../ranking/dedupe.js";
import type { RankedAlbum } from "../ranking/rank.js";
import { logger } from "../shared/logger.js";
import { getDeveloperToken, getMusicUserToken } from "./apple-music-auth.js";

const API_BASE = "https://api.music.apple.com/v1";
const TRACKS_PER_ALBUM = 2;

async function appleMusicFetch<T>(pathAndQuery: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${pathAndQuery}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${getDeveloperToken()}`,
      "Music-User-Token": getMusicUserToken(),
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Apple Music API ${pathAndQuery} failed: ${response.status} ${await response.text()}`);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

interface AppleMusicResource {
  id: string;
  attributes?: { name?: string; artistName?: string };
}

interface AppleMusicSearchResponse {
  results: {
    songs?: { data: AppleMusicResource[] };
    albums?: { data: AppleMusicResource[] };
  };
}

function storefront(): string {
  return loadEnv().APPLE_MUSIC_STOREFRONT;
}

/** Searches the catalog for a song, verifying the returned artist fuzzy-matches the one we searched for. */
async function searchSongId(term: string, artistName: string): Promise<string | undefined> {
  const query = encodeURIComponent(term);
  const result = await appleMusicFetch<AppleMusicSearchResponse>(
    `/catalog/${storefront()}/search?types=songs&limit=5&term=${query}`
  );
  const match = result.results.songs?.data.find(
    (s) => s.attributes?.artistName && fuzzyEqual(s.attributes.artistName, artistName)
  );
  return match?.id;
}

/** Searches the catalog for an album, verifying the returned artist fuzzy-matches the one we searched for. */
async function searchAlbumId(term: string, artistName: string): Promise<string | undefined> {
  const query = encodeURIComponent(term);
  const result = await appleMusicFetch<AppleMusicSearchResponse>(
    `/catalog/${storefront()}/search?types=albums&limit=5&term=${query}`
  );
  const match = result.results.albums?.data.find(
    (a) => a.attributes?.artistName && fuzzyEqual(a.attributes.artistName, artistName)
  );
  return match?.id;
}

interface AppleMusicAlbumTracksResponse {
  data: AppleMusicResource[];
}

/** Resolves a ranked album (plus any specifically-named songs) to a small set of Apple Music catalog song ids. */
export async function resolveAppleMusicSongIds(album: RankedAlbum): Promise<string[]> {
  const ids: string[] = [];

  for (const song of album.songs) {
    const id = await searchSongId(`${song} ${album.artist}`, album.artist);
    if (id) ids.push(id);
  }

  if (ids.length >= TRACKS_PER_ALBUM) return ids.slice(0, TRACKS_PER_ALBUM);

  let albumId = await searchAlbumId(`${album.album} ${album.artist}`, album.artist);
  if (!albumId) {
    // Same title-mismatch pattern seen on Spotify (stylized punctuation/spelling a comment didn't
    // reproduce exactly) -- ask the model for the exact real title and retry once.
    const corrected = await suggestCorrectedTitle("album", album.album, album.artist);
    if (corrected) {
      albumId = await searchAlbumId(`${corrected} ${album.artist}`, album.artist);
      if (albumId) logger.info(`Resolved "${album.album}" on Apple Music via corrected title "${corrected}".`);
    }
  }

  if (albumId) {
    const tracks = await appleMusicFetch<AppleMusicAlbumTracksResponse>(
      `/catalog/${storefront()}/albums/${albumId}/tracks?limit=${TRACKS_PER_ALBUM}`
    );
    for (const t of tracks.data) {
      if (!ids.includes(t.id) && ids.length < TRACKS_PER_ALBUM) ids.push(t.id);
    }
  }

  if (ids.length === 0) {
    logger.warn(`No Apple Music match found for "${album.album}" by ${album.artist} — skipping.`);
  }

  return ids;
}

interface AppleMusicPlaylist {
  id: string;
  attributes?: { name?: string };
}

interface AppleMusicPlaylistsResponse {
  data: AppleMusicPlaylist[];
}

async function findLibraryPlaylistByName(name: string): Promise<string | undefined> {
  const result = await appleMusicFetch<AppleMusicPlaylistsResponse>(`/me/library/playlists?limit=100`);
  return result.data.find((p) => p.attributes?.name === name)?.id;
}

/**
 * Returns the target library playlist id: an existing one with this name, else a freshly created
 * one with `songIds` already attached. Apple Music's API has no documented way to remove or replace
 * a library playlist's tracks (unlike Spotify's clean PUT-to-replace), so re-syncing an
 * already-existing playlist is a no-op rather than attempting a partial update.
 */
export async function getOrCreateLibraryPlaylist(name: string, songIds: string[]): Promise<string> {
  const existingId = await findLibraryPlaylistByName(name);
  if (existingId) {
    logger.info(`Apple Music playlist "${name}" already exists — leaving its tracks as-is.`);
    return existingId;
  }

  const created = await appleMusicFetch<AppleMusicPlaylistsResponse>(`/me/library/playlists`, {
    method: "POST",
    body: JSON.stringify({
      attributes: {
        name,
        description: "Auto-generated from Vinyl Picks community recommendations.",
      },
      relationships: {
        tracks: { data: songIds.map((id) => ({ id, type: "songs" })) },
      },
    }),
  });
  return created.data[0].id;
}

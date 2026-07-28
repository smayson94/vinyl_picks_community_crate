# Vinyl Picks — Community Playlist Automation

Community-built playlist for the "Vinyl Picks" record-of-the-week series on Instagram: picks feature the most-recommended songs and artists from the comments.

Turns those Instagram comments into a ranked, auto-updating Spotify and Apple Music playlist, with a Monday email summary.

## How it works (Milestone 3 — current)

```
Instagram Reel comments (live, or CSV fallback) --> OpenAI parses artist/album/song
  --> dedupe + rank by mentions --> Spotify + Apple Music playlists synced
```

The email summary is **not built yet** — a separate follow-up milestone (see "Roadmap" below). Comments come live from Instagram once configured (see step 6 below); the CSV import path from Milestone 1 still works and is kept permanently as a manual fallback/backfill option. Apple Music mirroring (step 7) is optional — the pipeline runs fine without it.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Get an OpenAI API key

Create one at https://platform.openai.com/api-keys (takes minutes, needs billing enabled).

### 3. Create a Spotify app

1. Go to https://developer.spotify.com/dashboard → **Create app**.
2. Add Redirect URI: `http://127.0.0.1:8888/callback`
3. Copy the Client ID and Client Secret.

### 4. Configure `.env`

Copy `.env.example` to `.env` and fill in `OPENAI_API_KEY`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`.

### 5. Authorize Spotify (one-time)

```bash
npm run setup:spotify
```

This opens your browser for a one-time Spotify login/consent, then writes `SPOTIFY_REFRESH_TOKEN` into `.env` automatically. Re-run this any time Spotify auth needs to be redone (rare — refresh tokens are long-lived and auto-rotate).

Optionally set `SPOTIFY_PLAYLIST_ID` in `.env` to sync into a specific existing playlist; otherwise the pipeline creates/reuses one named `Vinyl Picks — Week of <date>`.

### 6. Connect Instagram (optional — skip to use CSV import instead)

Meta's Instagram API changed shape since this project started; the current, simplest path is **"Instagram API with Instagram Login"**, which — unlike the older Instagram Graph API — does **not** require a linked Facebook Page.

1. Your Instagram account must be a **Professional account** (Business or Creator) *and set to Public* — convert/adjust it in the Instagram app under Settings if needed (a private account can't generate a test token).
2. Go to https://developers.facebook.com/apps → **Create App**.
3. Use case: select **Other** (there's no Instagram-specific option — this is the correct choice).
4. App type: select **Business**. Add an app name + contact email.
5. In the new app's dashboard, find the **Instagram** product card → click **Set up**. This auto-adds "API setup with Instagram login" — the no-Facebook-Page path we want.
6. Under that section, add your own Instagram account as a tester (Standard Access covers accounts you own, added directly in the dashboard — no App Review needed for personal use).
7. Click **Generate token** next to your account, log into Instagram, and copy the token. This token is long-lived (valid 60 days); the pipeline automatically refreshes it for another 60 days on every run, so you shouldn't need to regenerate it manually once it's set.
8. Paste it into `.env` as `INSTAGRAM_ACCESS_TOKEN`.

With that set, the pipeline fetches comments live — either from a specific Reel (pass its Instagram media ID as the reel id) or auto-detected as your account's most recent Reel (omit the id entirely).

**Without Instagram configured**, import a week's comments manually instead — copy them from the Reel into a CSV with header `username,comment` (see `examples/sample-comments.csv`):

```bash
npm run import:comments -- path/to/comments.csv <reel-id> [YYYY-MM-DD]
```

`<reel-id>` can be anything unique per week (e.g. `2026-07-26`) when using CSV import. The posted-at date defaults to today and is used in the generated playlist name.

### 7. Connect Apple Music (optional)

Requires an active **Apple Developer Program membership ($99/yr)** — there's no free tier for this. Apple's terminology has shifted since older tutorials: this is now called a **Media ID**, not a "MusicKit identifier."

1. Go to https://developer.apple.com/account/resources/identifiers → **+** → **Media IDs** → **Continue**.
2. Enter a description (shown to you during authorization) and identifier → enable the services you need (Apple Music is the relevant one) → **Register**.
3. Under **Keys**, create and download a new private key (`.p8` file) associated with that Media ID — **you can only download it once**, so save it somewhere durable (e.g. next to this repo, outside version control). Note the **Key ID** shown alongside it.
4. Find your **Team ID** under Membership details in your Apple Developer account.
5. Add all three to `.env`: `APPLE_MUSIC_TEAM_ID`, `APPLE_MUSIC_KEY_ID`, `APPLE_MUSIC_PRIVATE_KEY_PATH` (a file path to the downloaded `.p8`).
6. Run the one-time authorization:

   ```bash
   npm run setup:apple-music
   ```

   Unlike Spotify or Instagram, Apple has no server-side/headless way to get a user token — this opens a local page that loads Apple's own MusicKit JS and asks you to sign in with your Apple ID. Once approved, it saves `APPLE_MUSIC_USER_TOKEN` to `.env` automatically.

**Known limitation**: Apple's API has no documented way to remove or replace tracks in an existing library playlist (unlike Spotify's clean full-replace). If a playlist with the same name already exists from a previous run, the pipeline leaves its tracks alone rather than risk duplicating or corrupting it — in practice this only comes up when re-running the same week's reel (each week's theme-based name is normally unique).

### 8. Run the pipeline

```bash
npm run pipeline:dev                  # auto-detects the latest Reel (Instagram configured)
npm run pipeline:dev -- <reel-id>     # a specific Instagram media id, or a CSV-imported reel id
```

This fetches/parses the comments (via Instagram or the CSV you already imported), dedupes/ranks recommendations by mention count, resolves 1-2 tracks per album on Spotify and (if configured) Apple Music, and syncs the target playlist(s) in ranked order. Safe to re-run — each stage is skipped once it's already completed for that reel, so a failure partway through (e.g. a flaky API call) never re-does finished work or double-syncs.

Add `--refresh` to re-check a reel for new comments even after it's already fully synced (e.g. more comments came in after your first run):

```bash
npm run pipeline:dev -- <reel-id> --refresh
```

For unattended/scheduled runs, build first and run the compiled output (avoids any transpile step in a non-interactive session):

```bash
npm run build
npm run pipeline
```

## Roadmap (not yet built)

- **Milestone 4 — Monday email summary + full automation**: wire up a weekly Windows Task Scheduler job (with "wake to run" enabled) and send a summary email (top recommendations, playlist links, new/ambiguous entries) via Resend or Gmail app-password + Nodemailer.
- Further out (explicitly deferred, schema already supports it without a rewrite): community leaderboard, monthly community mix, IG story content scheduling.

**Known gap**: the Apple Music Music User Token has no server-side refresh (Apple provides no headless way to renew it) — if it eventually expires, re-run `npm run setup:apple-music` to reauthorize. There's no fixed schedule for when this happens; treat an Apple Music sync failure with an auth-looking error as the signal to redo it.

## Project structure

```
src/
  config/          env loading + validation, .env file updates (for token rotation)
  instagram/        comment ingestion (live via Instagram API, or CSV fallback)
  comment-parser/    OpenAI structured extraction
  ranking/           normalization, fuzzy dedupe, mention-count ranking
  spotify/           OAuth + playlist/track API client
  apple-music/       developer JWT signing + catalog search/library-playlist client
  storage/           SQLite persistence + the per-reel pipeline status state machine
  email/             (not yet built)
  pipeline/          orchestrates all of the above end-to-end
scripts/             one-off/interactive scripts (CSV import, Spotify auth, Apple Music auth)
test/                vitest coverage for the pure parsing/dedupe/rank logic
```

## Testing

```bash
npm test        # vitest — pure-function coverage, no live API calls
npm run typecheck
```

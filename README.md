# Vinyl Picks — Community Playlist Automation

Turns Instagram comments on the weekly "Vinyl Picks" Reel into a ranked, auto-updating Spotify (and eventually Apple Music) playlist, with a Monday email summary.

Full architecture and rationale: see [`.claude/plans` in the originating session] or the summary below.

## How it works (Milestone 1 — current)

```
CSV of comments  --> OpenAI parses artist/album/song  --> dedupe + rank by mentions --> Spotify playlist synced
```

Instagram Graph API, Apple Music, and the email summary are **not built yet** — they're separate follow-up milestones (see "Roadmap" below). Right now comments are imported manually via CSV, which is also useful as a permanent fallback/backfill path.

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

### 6. Import a week's comments

Copy comments from the Instagram Reel into a CSV with header `username,comment` (see `examples/sample-comments.csv`), then:

```bash
npm run import:comments -- path/to/comments.csv <reel-id> [YYYY-MM-DD]
```

`<reel-id>` can be anything unique per week (e.g. `2026-07-26`). The posted-at date defaults to today and is used in the generated playlist name.

### 7. Run the pipeline

```bash
npm run pipeline:dev -- <reel-id>
```

This parses the comments with OpenAI, dedupes/ranks recommendations by mention count, resolves 1-2 tracks per album on Spotify, and replaces the target playlist's tracklist in ranked order. Safe to re-run — each stage is skipped once it's already completed for that reel, so a failure partway through (e.g. a flaky API call) never re-does finished work or double-syncs.

For unattended/scheduled runs, build first and run the compiled output (avoids any transpile step in a non-interactive session):

```bash
npm run build
npm run pipeline -- <reel-id>
```

## Roadmap (not yet built)

- **Milestone 2 — live Instagram comments**: replace the CSV step with the Instagram Graph API. Requires a Meta Developer App (Business type) with a Facebook Page linked to your Instagram Business/Creator account. Since this app only needs to read *your own* account's comments, it likely never needs Meta's App Review — adding your own IG account as an Admin/Developer/Tester on the app in Development Mode should be enough. Validate this with one real API call before building against it.
- **Milestone 3 — Apple Music mirroring**: requires enrolling in the Apple Developer Program ($99/yr) and a MusicKit private key. Apple Music playlist writes are user-scoped — the one-time Music User Token has **no server-side refresh**, so expect to periodically redo that one-time browser authorization (budget "every few months," not a bug).
- **Milestone 4 — Monday email summary + full automation**: wire up a weekly Windows Task Scheduler job (with "wake to run" enabled) and send a summary email (top recommendations, playlist links, new/ambiguous entries) via Resend or Gmail app-password + Nodemailer.
- Further out (explicitly deferred, schema already supports it without a rewrite): community leaderboard, monthly community mix, IG story content scheduling.

## Project structure

```
src/
  config/          env loading + validation, .env file updates (for token rotation)
  instagram/        comment ingestion (CSV now, Graph API later)
  comment-parser/    OpenAI structured extraction
  ranking/           normalization, fuzzy dedupe, mention-count ranking
  spotify/           OAuth + playlist/track API client
  apple-music/       (not yet built)
  storage/           SQLite persistence + the per-reel pipeline status state machine
  email/             (not yet built)
  pipeline/          orchestrates all of the above end-to-end
scripts/             one-off/interactive scripts (CSV import, Spotify auth)
test/                vitest coverage for the pure parsing/dedupe/rank logic
```

## Testing

```bash
npm test        # vitest — pure-function coverage, no live API calls
npm run typecheck
```

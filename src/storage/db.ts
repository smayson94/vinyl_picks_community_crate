import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "../config/env.js";

let instance: Database.Database | undefined;

export function getDb(): Database.Database {
  if (instance) return instance;

  const { DATABASE_PATH } = loadEnv();
  fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });

  instance = new Database(DATABASE_PATH);
  instance.pragma("journal_mode = WAL");
  instance.pragma("foreign_keys = ON");
  runMigrations(instance);
  return instance;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reels (
      id TEXT PRIMARY KEY,
      posted_at TEXT NOT NULL,
      fetched_at TEXT,
      status TEXT NOT NULL DEFAULT 'NEW',
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reel_id TEXT NOT NULL REFERENCES reels(id),
      ig_comment_id TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      comment_text TEXT NOT NULL,
      artist TEXT,
      album TEXT,
      song TEXT,
      confidence REAL,
      is_ambiguous INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_recommendations_reel_id ON recommendations(reel_id);

    CREATE TABLE IF NOT EXISTS playlist_syncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reel_id TEXT NOT NULL REFERENCES reels(id),
      platform TEXT NOT NULL,
      playlist_id TEXT NOT NULL,
      track_count INTEGER NOT NULL,
      synced_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(reel_id, platform)
    );
  `);
}

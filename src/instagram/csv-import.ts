import fs from "node:fs";
import { insertComments, upsertReel, type RawComment } from "../storage/repository.js";

/**
 * Parses a simple CSV with header `username,comment,comment_id` (comment_id optional --
 * derived from row index when absent, which is fine for a one-off manual import).
 */
export function parseCommentsCsv(csvText: string, reelId: string): RawComment[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return [];

  const [header, ...rows] = lines;
  const columns = header.split(",").map((c) => c.trim().toLowerCase());
  const usernameIdx = columns.indexOf("username");
  const commentIdx = columns.indexOf("comment");
  const commentIdIdx = columns.indexOf("comment_id");

  if (usernameIdx === -1 || commentIdx === -1) {
    throw new Error(`CSV header must include "username" and "comment" columns, got: ${header}`);
  }

  return rows.map((row, i) => {
    const cells = splitCsvRow(row);
    const username = cells[usernameIdx]?.trim() ?? "";
    const comment_text = cells[commentIdx]?.trim() ?? "";
    const ig_comment_id = commentIdIdx !== -1 && cells[commentIdIdx]?.trim() ? cells[commentIdIdx].trim() : `${reelId}:manual:${i}`;
    return { ig_comment_id, username, comment_text };
  });
}

/** Minimal CSV row splitter supporting double-quoted fields containing commas. */
function splitCsvRow(row: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (inQuotes) {
      if (ch === '"' && row[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

export function importCommentsCsvFile(filePath: string, reelId: string, postedAt: string): number {
  upsertReel(reelId, postedAt);
  const csvText = fs.readFileSync(filePath, "utf-8");
  const comments = parseCommentsCsv(csvText, reelId);
  return insertComments(reelId, comments);
}

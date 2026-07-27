import "../src/config/env.js";
import path from "node:path";
import { importCommentsCsvFile } from "../src/instagram/csv-import.js";
import { logger } from "../src/shared/logger.js";

/**
 * Usage: npm run import:comments -- <csv-file> <reel-id> [posted-at-ISO-date]
 * CSV must have header: username,comment[,comment_id]
 */
async function main() {
  const [csvFileArg, reelIdArg, postedAtArg] = process.argv.slice(2);

  if (!csvFileArg || !reelIdArg) {
    logger.error("Usage: npm run import:comments -- <csv-file> <reel-id> [posted-at-ISO-date]");
    process.exit(1);
  }

  const csvFile = path.resolve(csvFileArg);
  const postedAt = postedAtArg ?? new Date().toISOString().slice(0, 10);

  const count = importCommentsCsvFile(csvFile, reelIdArg, postedAt);
  logger.info(`Imported ${count} new comment(s) for reel "${reelIdArg}" (posted ${postedAt}).`);
}

main().catch((err) => {
  logger.error("Import failed:", err);
  process.exit(1);
});

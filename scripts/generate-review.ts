import "../src/config/env.js";
import { writeReviewReport } from "../src/pipeline/review-report.js";
import { logger } from "../src/shared/logger.js";

async function main() {
  const reelId = process.argv[2];
  if (!reelId) {
    logger.error("Usage: tsx scripts/generate-review.ts <reel-id>");
    process.exit(1);
  }
  const outPath = writeReviewReport(reelId);
  logger.info(`Wrote review report to ${outPath}`);
}

main().catch((err) => {
  logger.error("Review report generation failed:", err);
  process.exit(1);
});

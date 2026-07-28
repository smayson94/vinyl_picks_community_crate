import fs from "node:fs";
import path from "node:path";
import { groupByFuzzyMatch } from "../ranking/dedupe.js";
import { getReel, getRecommendationsForReel, type Reel, type RecommendationRow } from "../storage/repository.js";

const REPORTS_DIR = path.resolve(process.cwd(), "reports");

interface RankedForReport {
  artist: string;
  album: string;
  mentionCount: number;
  score: number;
  usernames: string[];
}

function computeRanked(rows: RecommendationRow[]): RankedForReport[] {
  const resolved = rows.filter(
    (r): r is RecommendationRow & { artist: string; album: string } =>
      !r.is_ambiguous && !!r.artist && !!r.album
  );

  return groupByFuzzyMatch(resolved)
    .map((group) => ({
      artist: group[0].artist,
      album: group[0].album,
      mentionCount: group.length,
      score: group.reduce((sum, r) => sum + 1 + (r.like_count ?? 0), 0),
      usernames: [...new Set(group.map((r) => r.username))],
    }))
    .sort((a, b) => b.score - a.score);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Builds a self-contained HTML review page: ranked albums (with score/contributors) plus every comment and what was extracted from it. */
export function buildReviewReportHtml(reel: Reel, rows: RecommendationRow[]): string {
  const ranked = computeRanked(rows);
  const ambiguousCount = rows.length - rows.filter((r) => !r.is_ambiguous && r.artist && r.album).length;
  const title = reel.theme ? `Community Crate — ${reel.theme}` : `Community Crate — Week of ${reel.posted_at}`;
  const dataJson = JSON.stringify(rows);

  const rankRows = ranked
    .map(
      (r, i) => `<tr>
      <td class="idx">${i + 1}</td>
      <td class="field"><strong>${escapeHtml(r.album)}</strong></td>
      <td class="field">${escapeHtml(r.artist)}</td>
      <td class="num">${r.score}</td>
      <td class="num">${r.mentionCount}</td>
      <td class="contributors">${r.usernames.map((u) => `<span class="tag${u === "caption" ? " caption" : ""}">${escapeHtml(u)}</span>`).join("")}</td>
    </tr>`
    )
    .join("\n");

  return `<title>${escapeHtml(title)} — Review</title>
<style>
  :root {
    --ink: #211c16; --paper: #dcd6c6; --paper-raised: #e6e1d3; --paper-line: #c7c0ac;
    --muted: #6b6353; --accent: #a8752b; --accent-strong: #8a5f22;
    --resolved: #55714f; --resolved-bg: #dde3d5; --ambiguous: #a1503f; --ambiguous-bg: #ecdbd4; --focus: #8a5f22;
  }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #e9e1d2; --paper: #17130f; --paper-raised: #201a14; --paper-line: #3a3226;
      --muted: #a89d87; --accent: #d3a256; --accent-strong: #e6ba71;
      --resolved: #93b389; --resolved-bg: #26301f; --ambiguous: #d68f7d; --ambiguous-bg: #3a2620; --focus: #e6ba71; }
  }
  :root[data-theme="dark"] { --ink: #e9e1d2; --paper: #17130f; --paper-raised: #201a14; --paper-line: #3a3226;
    --muted: #a89d87; --accent: #d3a256; --accent-strong: #e6ba71;
    --resolved: #93b389; --resolved-bg: #26301f; --ambiguous: #d68f7d; --ambiguous-bg: #3a2620; --focus: #e6ba71; }
  :root[data-theme="light"] { --ink: #211c16; --paper: #dcd6c6; --paper-raised: #e6e1d3; --paper-line: #c7c0ac;
    --muted: #6b6353; --accent: #a8752b; --accent-strong: #8a5f22;
    --resolved: #55714f; --resolved-bg: #dde3d5; --ambiguous: #a1503f; --ambiguous-bg: #ecdbd4; --focus: #8a5f22; }

  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font-family: -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  .page { max-width: 1180px; margin: 0 auto; padding: 2.5rem 1.75rem 4rem; }
  .eyebrow { font-size: 0.72rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); font-weight: 600; margin: 0 0 0.4rem; }
  h1 { font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; font-size: clamp(1.7rem, 3.2vw, 2.5rem); font-weight: 600; margin: 0 0 0.3rem; text-wrap: balance; letter-spacing: -0.01em; }
  h2 { font-size: 1.05rem; font-weight: 600; margin: 2.5rem 0 0.75rem; }
  .subhead { color: var(--muted); font-size: 0.95rem; margin: 0 0 1.75rem; }
  .stats { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 1rem; }
  .stat { background: var(--paper-raised); border: 1px solid var(--paper-line); border-radius: 10px; padding: 0.7rem 1.1rem; min-width: 8.5rem; }
  .stat .n { font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace; font-variant-numeric: tabular-nums; font-size: 1.5rem; font-weight: 600; line-height: 1.1; }
  .stat .label { font-size: 0.72rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); margin-top: 0.15rem; }
  .stat.resolved .n { color: var(--resolved); }
  .stat.ambiguous .n { color: var(--ambiguous); }
  .toolbar { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; margin-bottom: 1rem; position: sticky; top: 0; background: var(--paper); padding: 0.75rem 0; z-index: 5; }
  #search { flex: 1 1 240px; background: var(--paper-raised); border: 1px solid var(--paper-line); border-radius: 8px; padding: 0.55rem 0.8rem; color: var(--ink); font-size: 0.9rem; }
  #search:focus-visible, .seg button:focus-visible, select:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
  .seg { display: flex; background: var(--paper-raised); border: 1px solid var(--paper-line); border-radius: 8px; overflow: hidden; }
  .seg button { appearance: none; border: none; background: transparent; color: var(--muted); font-size: 0.82rem; font-weight: 600; padding: 0.5rem 0.9rem; cursor: pointer; border-right: 1px solid var(--paper-line); }
  .seg button:last-child { border-right: none; }
  .seg button[aria-pressed="true"] { background: var(--accent); color: var(--paper); }
  select { background: var(--paper-raised); border: 1px solid var(--paper-line); border-radius: 8px; padding: 0.5rem 0.7rem; color: var(--ink); font-size: 0.82rem; }
  .table-wrap { overflow-x: auto; border: 1px solid var(--paper-line); border-radius: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.86rem; }
  thead th { position: sticky; top: 0; background: var(--paper-raised); text-align: left; font-size: 0.72rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 600; padding: 0.65rem 0.8rem; border-bottom: 1px solid var(--paper-line); white-space: nowrap; }
  tbody td { padding: 0.6rem 0.8rem; border-bottom: 1px solid var(--paper-line); vertical-align: top; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: var(--paper-raised); }
  .idx, .num { color: var(--muted); font-variant-numeric: tabular-nums; }
  .user { font-weight: 600; white-space: nowrap; }
  .user.caption { color: var(--accent-strong); }
  .comment { max-width: 340px; color: var(--ink); }
  .field { white-space: nowrap; }
  .field.empty { color: var(--muted); }
  .contributors { display: flex; flex-wrap: wrap; gap: 0.3rem; max-width: 320px; }
  .tag { font-size: 0.72rem; background: var(--paper-raised); border: 1px solid var(--paper-line); border-radius: 999px; padding: 0.1rem 0.5rem; white-space: nowrap; }
  .tag.caption { color: var(--accent-strong); border-color: var(--accent-strong); }
  .conf { display: flex; align-items: center; gap: 0.45rem; font-variant-numeric: tabular-nums; font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace; font-size: 0.8rem; white-space: nowrap; }
  .conf-bar { width: 42px; height: 5px; border-radius: 3px; background: var(--paper-line); overflow: hidden; }
  .conf-bar > span { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
  .pill { display: inline-block; font-size: 0.72rem; font-weight: 600; letter-spacing: 0.02em; padding: 0.2rem 0.55rem; border-radius: 999px; white-space: nowrap; }
  .pill.resolved { background: var(--resolved-bg); color: var(--resolved); }
  .pill.ambiguous { background: var(--ambiguous-bg); color: var(--ambiguous); }
  .empty-state { text-align: center; padding: 3rem 1rem; color: var(--muted); font-size: 0.9rem; }
  footer { margin-top: 1.25rem; color: var(--muted); font-size: 0.78rem; }
</style>

<div class="page">
  <p class="eyebrow">Community Crate — Vinyl Picks</p>
  <h1>${escapeHtml(reel.theme ?? "")}, week of ${escapeHtml(reel.posted_at)}</h1>
  <p class="subhead">Ranked picks and every comment the automation read for this Reel.</p>

  <div class="stats">
    <div class="stat"><div class="n">${rows.length}</div><div class="label">Comments read</div></div>
    <div class="stat resolved"><div class="n">${ranked.length}</div><div class="label">Ranked picks</div></div>
    <div class="stat ambiguous"><div class="n">${ambiguousCount}</div><div class="label">Ambiguous</div></div>
  </div>

  <h2>Rankings</h2>
  <div class="table-wrap">
    <table>
      <thead><tr><th>#</th><th>Album</th><th>Artist</th><th>Score</th><th>Mentions</th><th>Recommended by</th></tr></thead>
      <tbody>${rankRows}</tbody>
    </table>
  </div>

  <h2>All comments</h2>
  <div class="toolbar">
    <input id="search" type="text" placeholder="Search username, comment, artist, album…" autocomplete="off">
    <div class="seg" role="group" aria-label="Filter by status">
      <button data-filter="all" aria-pressed="true">All</button>
      <button data-filter="resolved" aria-pressed="false">Resolved</button>
      <button data-filter="ambiguous" aria-pressed="false">Ambiguous</button>
    </div>
    <select id="sort">
      <option value="order">Original order</option>
      <option value="confidence">Confidence, high → low</option>
      <option value="album">Album, A → Z</option>
    </select>
  </div>

  <div class="table-wrap">
    <table>
      <thead><tr><th>#</th><th>Username</th><th>Comment</th><th>Artist</th><th>Album</th><th>Song</th><th>Likes</th><th>Confidence</th><th>Status</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="empty-state" id="empty-state" hidden>No comments match this filter.</div>
  </div>

  <footer id="footer-count"></footer>
</div>

<script>
  const DATA = ${dataJson};

  const rowsEl = document.getElementById("rows");
  const emptyEl = document.getElementById("empty-state");
  const footerEl = document.getElementById("footer-count");
  const searchEl = document.getElementById("search");
  const sortEl = document.getElementById("sort");
  const segButtons = Array.from(document.querySelectorAll(".seg button"));
  let filter = "all";

  function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function renderField(value) { return value ? escapeHtml(value) : '<span class="field empty">—</span>'; }

  function render() {
    const q = searchEl.value.trim().toLowerCase();
    let items = DATA.map((d, i) => ({ ...d, _idx: i + 1 }));

    if (filter === "resolved") items = items.filter((d) => !d.is_ambiguous);
    if (filter === "ambiguous") items = items.filter((d) => d.is_ambiguous);
    if (q) items = items.filter((d) => [d.username, d.comment_text, d.artist, d.album, d.song].some((f) => f && f.toLowerCase().includes(q)));

    if (sortEl.value === "confidence") items = items.slice().sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    else if (sortEl.value === "album") items = items.slice().sort((a, b) => (a.album || "￿").localeCompare(b.album || "￿"));

    rowsEl.innerHTML = items.map((d) => {
      const pct = Math.round((d.confidence ?? 0) * 100);
      return \`<tr>
        <td class="idx">\${d._idx}</td>
        <td class="user\${d.username === "caption" ? " caption" : ""}">\${escapeHtml(d.username)}</td>
        <td class="comment">\${escapeHtml(d.comment_text)}</td>
        <td class="field">\${renderField(d.artist)}</td>
        <td class="field">\${renderField(d.album)}</td>
        <td class="field">\${renderField(d.song)}</td>
        <td class="num">\${d.like_count ?? 0}</td>
        <td><div class="conf"><div class="conf-bar"><span style="width:\${pct}%"></span></div>\${d.confidence == null ? "—" : d.confidence.toFixed(1)}</div></td>
        <td>\${d.is_ambiguous ? '<span class="pill ambiguous">Ambiguous</span>' : '<span class="pill resolved">Resolved</span>'}</td>
      </tr>\`;
    }).join("");

    emptyEl.hidden = items.length > 0;
    footerEl.textContent = \`Showing \${items.length} of \${DATA.length} comments.\`;
  }

  searchEl.addEventListener("input", render);
  sortEl.addEventListener("change", render);
  segButtons.forEach((btn) => btn.addEventListener("click", () => {
    filter = btn.dataset.filter;
    segButtons.forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    render();
  }));

  render();
</script>`;
}

/** Writes a self-contained HTML review report (rankings + full comment breakdown) for a reel to reports/<reel-id>.html. */
export function writeReviewReport(reelId: string): string {
  const reel = getReel(reelId);
  if (!reel) throw new Error(`No reel "${reelId}" found.`);

  const rows = getRecommendationsForReel(reelId);
  const html = buildReviewReportHtml(reel, rows);

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const outPath = path.join(REPORTS_DIR, `${reelId}.html`);
  fs.writeFileSync(outPath, html);
  return outPath;
}

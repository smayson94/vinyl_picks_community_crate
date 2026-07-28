import "../src/config/env.js";
import http from "node:http";
import open from "open";
import { getDeveloperToken } from "../src/apple-music/apple-music-auth.js";
import { updateEnvFile } from "../src/config/update-env-file.js";
import { logger } from "../src/shared/logger.js";

const PORT = 8889;
const ENV_PATH = new URL("../.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/**
 * Apple has no server-side/headless way to mint a Music User Token (unlike Spotify's Authorization
 * Code flow) -- MusicKit JS's browser-based `authorize()` is the only path, so this serves a small
 * local page that does exactly that, then posts the resulting token back to this same script.
 */
function buildAuthPage(developerToken: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Apple Music Setup</title></head>
<body>
<h1>Connecting Apple Music…</h1>
<p id="status">Loading MusicKit…</p>
<script src="https://js-cdn.music.apple.com/musickit/v1/musickit.js"></script>
<script>
  document.addEventListener("musickitloaded", function () {
    document.getElementById("status").textContent = "Requesting authorization…";
    MusicKit.configure({
      developerToken: ${JSON.stringify(developerToken)},
      app: { name: "Vinyl Picks", build: "1.0.0" }
    });
    var music = MusicKit.getInstance();
    music.authorize().then(function (token) {
      var musicUserToken = token || music.musicUserToken;
      if (!musicUserToken) throw new Error("No Music User Token returned.");
      return fetch("/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: musicUserToken })
      });
    }).then(function () {
      document.body.innerHTML = "<h1>Apple Music connected ✓</h1><p>You can close this tab.</p>";
    }).catch(function (err) {
      document.body.innerHTML = "<h1>Apple Music authorization failed</h1><pre>" + (err && err.message ? err.message : err) + "</pre>";
    });
  });
</script>
</body>
</html>`;
}

async function main() {
  const developerToken = getDeveloperToken();

  await new Promise<void>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(buildAuthPage(developerToken));
        return;
      }

      if (req.method === "POST" && req.url === "/token") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const { token } = JSON.parse(body) as { token?: string };
            if (!token) throw new Error("No token in request body.");
            updateEnvFile(ENV_PATH, "APPLE_MUSIC_USER_TOKEN", token);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            server.close();
            resolve();
          } catch (err) {
            res.writeHead(400).end();
            server.close();
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
        return;
      }

      res.writeHead(404).end();
    });

    server.listen(PORT, () => {
      const url = `http://127.0.0.1:${PORT}`;
      logger.info(`Waiting for Apple Music authorization on ${url} ...`);
      logger.info("A browser tab should open automatically — sign in with your Apple ID when prompted.");
      void open(url);
    });
  });

  logger.info("Apple Music connected. APPLE_MUSIC_USER_TOKEN saved to .env — you're ready to run the pipeline.");
}

main().catch((err) => {
  logger.error("Apple Music setup failed:", err);
  process.exit(1);
});

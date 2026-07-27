import "../src/config/env.js";
import crypto from "node:crypto";
import http from "node:http";
import open from "open";
import { updateEnvFile } from "../src/config/update-env-file.js";
import { logger } from "../src/shared/logger.js";

const SCOPES = "playlist-modify-public playlist-modify-private playlist-read-private";
const ENV_PATH = new URL("../.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function main() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI ?? "http://127.0.0.1:8888/callback";

  if (!clientId || !clientSecret) {
    logger.error("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env before running this script.");
    process.exit(1);
  }

  const url = new URL(redirectUri);
  const port = Number(url.port || 8888);

  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = base64url(crypto.randomBytes(16));

  const authorizeUrl = new URL("https://accounts.spotify.com/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("scope", SCOPES);
  authorizeUrl.searchParams.set("state", state);

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", redirectUri);
      if (reqUrl.pathname !== url.pathname) {
        res.writeHead(404).end();
        return;
      }

      const returnedState = reqUrl.searchParams.get("state");
      const authCode = reqUrl.searchParams.get("code");
      const error = reqUrl.searchParams.get("error");

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(error ? `<h1>Spotify auth failed</h1><p>${error}</p>` : `<h1>Spotify connected ✓</h1><p>You can close this tab.</p>`);
      server.close();

      if (error) return reject(new Error(`Spotify authorization error: ${error}`));
      if (returnedState !== state) return reject(new Error("State mismatch — possible CSRF, aborting."));
      if (!authCode) return reject(new Error("No authorization code returned."));
      resolve(authCode);
    });

    server.listen(port, () => {
      logger.info(`Waiting for Spotify authorization on ${redirectUri} ...`);
      logger.info(`If a browser tab doesn't open automatically, visit:\n${authorizeUrl.toString()}`);
      void open(authorizeUrl.toString());
    });
  });

  const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(`Token exchange failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
  }

  const tokens = (await tokenResponse.json()) as { refresh_token: string; access_token: string };
  updateEnvFile(ENV_PATH, "SPOTIFY_REFRESH_TOKEN", tokens.refresh_token);
  logger.info("Spotify connected. SPOTIFY_REFRESH_TOKEN saved to .env — you're ready to run the pipeline.");
}

main().catch((err) => {
  logger.error("Spotify setup failed:", err);
  process.exit(1);
});

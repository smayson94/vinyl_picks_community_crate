import fs from "node:fs";

/**
 * Updates (or appends) a KEY=value line in a .env file on disk, without disturbing other lines.
 * Used to persist Spotify's rotated refresh_token so unattended runs keep working.
 */
export function updateEnvFile(envPath: string, key: string, value: string): void {
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  const escapedValue = value.includes(" ") || value.includes("#") ? `"${value}"` : value;
  const pattern = new RegExp(`^${key}=`);

  let found = false;
  const updated = lines.map((line) => {
    if (pattern.test(line)) {
      found = true;
      return `${key}=${escapedValue}`;
    }
    return line;
  });

  if (!found) {
    if (updated.length > 0 && updated[updated.length - 1].trim() !== "") updated.push("");
    updated.push(`${key}=${escapedValue}`);
  }

  fs.writeFileSync(envPath, updated.join("\n"));
  process.env[key] = value;
}

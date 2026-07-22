import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnv } from "vite";

const root = resolve(import.meta.dirname, "..");
const env = { ...loadEnv("production", root, ""), ...process.env };

function trustedHttpsOrigin(name) {
  const raw = String(env[name] || "").trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} doit être une URL absolue.`);
  }
  if (url.protocol !== "https:") throw new Error(`${name} doit utiliser HTTPS pour un build de production.`);
  if (url.username || url.password || url.search || url.hash) throw new Error(`${name} contient des composants interdits.`);
  return url.origin;
}

const serverOrigin = trustedHttpsOrigin("VITE_SERVER_URL");
const connectOrigins = ["'self'", serverOrigin]
  .filter(Boolean);
if (serverOrigin) connectOrigins.push(serverOrigin.replace(/^https:/, "wss:"));

const csp = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "script-src-attr 'none'",
  "style-src 'self'",
  "style-src-attr 'none'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src ${[...new Set([...connectOrigins, "https://challenges.cloudflare.com"])].join(" ")}`,
  "frame-src https://challenges.cloudflare.com",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "manifest-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const headers = `/*
  Content-Security-Policy: ${csp}
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: accelerometer=(), ambient-light-sensor=(), autoplay=(), battery=(), camera=(self), display-capture=(), document-domain=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), local-fonts=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-create=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), speaker-selection=(), usb=(), web-share=(self), window-management=(), xr-spatial-tracking=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
  Cache-Control: no-store

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/action-cards/*
  Cache-Control: public, max-age=31536000, immutable

/skyjo-logo.svg
  Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; script-src-attr 'none'; connect-src 'none'; object-src 'none'; frame-ancestors 'none'; sandbox
  Cache-Control: public, max-age=86400
`;

await mkdir(resolve(root, "dist"), { recursive: true });
await writeFile(resolve(root, "dist/_headers"), headers, "utf8");

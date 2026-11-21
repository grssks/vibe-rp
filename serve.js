// Bun static file server with SPA-style routing for Vibe RP
// Maps /chat -> chat.html and / -> index.html; settings routes open the library modal.
import { statSync } from "node:fs";
import { resolve, sep } from "path";

const PUBLIC = resolve(import.meta.dir, "public");

// Security headers applied to every response (HTML, static assets, 404, and
// redirects). Kept as one constant so serve.js and vercel.json cannot drift.
//
// CSP decisions:
//   - script-src is 'self' only: there are NO inline scripts in the app.
//   - style-src is 'self' only: page and component stylesheets hold all static
//     rules and dynamic meter/viewport properties are applied via CSSOM.
//   - connect-src * is required by design: this client talks directly to the
//     arbitrary OpenAI-compatible endpoint the user configures.
//   - img-src allows data: (locally compressed avatars) and https: (remote
//     card art). Plain http: images are deliberately excluded.
//   - HSTS is NOT set here: this is a plain-HTTP dev server and an HSTS header
//     on localhost would poison the browser. It is set at deploy time in
//     vercel.json, which is HTTPS-only.
export const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data: https:",
    "connect-src *",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
};

function safePublicPath(pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decodedPath.includes("\0")) return null;

  const filePath = resolve(PUBLIC, `.${decodedPath}`);
  if (filePath !== PUBLIC && !filePath.startsWith(`${PUBLIC}${sep}`)) return null;
  return filePath;
}

function isRegularFile(filePath) {
  try {
    return Boolean(filePath && statSync(filePath).isFile());
  } catch {
    return false;
  }
}

function notFound() {
  return new Response(Bun.file(safePublicPath("/404.html")), {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";

const ROUTES = {
  "/": "index.html",
  "/chat": "chat.html",
};

const REDIRECT_ROUTES = {
  "/settings": "/?openSettings=1",
  "/directives": "/?openSettings=1&tab=settings-system-prompts-tab",
  "/personas": "/?openSettings=1&tab=settings-personas-tab",
};

async function routeRequest(req) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: {
        Allow: "GET, HEAD",
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  const url = new URL(req.url);
  const pathname = url.pathname;
  const normPath = pathname.length > 1 ? pathname.replace(/\/+$/, "") || "/" : pathname;

  // Redirect standalone settings/directives/personas paths (with or without trailing slash) to library modal
  const redirectTarget = REDIRECT_ROUTES[normPath];
  if (redirectTarget) {
    return new Response(null, {
      status: 302,
      headers: { Location: redirectTarget },
    });
  }

  // Route → HTML mapping
  const htmlFile = ROUTES[normPath] ?? null;
  if (htmlFile) {
    const file = Bun.file(safePublicPath(`/${htmlFile}`));
    return new Response(file, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  }

  // Static assets (js, css, fonts, etc.) — regular files only
  const filePath = safePublicPath(pathname);
  if (!isRegularFile(filePath)) return notFound();

  const headers = {};
  if (normPath === "/sw.js" || /\.html?$/i.test(normPath)) {
    headers["Cache-Control"] = "no-cache";
  }
  return new Response(Bun.file(filePath), Object.keys(headers).length ? { headers } : undefined);
}

export async function handleRequest(req) {
  const response = await routeRequest(req);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  if (req.method === "HEAD") {
    return new Response(null, {
      status: response.status,
      headers: response.headers,
    });
  }
  return response;
}

if (import.meta.main) {
  Bun.serve({
    hostname: HOST,
    port: PORT,
    fetch: handleRequest,
  });
  console.log(`Vibe RP dev server running at http://${HOST}:${PORT}`);
}

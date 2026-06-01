import type { NextRequest } from "next/server";

// Build a public-facing URL for the current request, respecting
// X-Forwarded-* headers set by reverse proxies / tunnels (ngrok,
// Cloudflare, Vercel). Without this, `new URL(path, request.url)`
// resolves to the rewritten Host (e.g. localhost:3000) instead of
// the external hostname the browser actually used — which breaks
// OAuth redirect_uri matching.

export function publicUrl(request: NextRequest, path: string): string {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}${path}`;
  }
  // Fallback: trust the request URL itself (no proxy).
  return new URL(path, request.url).toString();
}

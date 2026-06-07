// Per-platform URL → id parsers. Pure regex, no I/O. Used by both the
// review pipeline (to look up an already-posted video) and the chat
// agent's video_ideas_mark_posted tool (to validate a URL the user
// pasted).
//
// Each parser also accepts a bare id (for the "I already know the id"
// fast path) — and returns null when nothing parseable is found, so
// callers can do `extractX(urlOrId) ?? return error`.

// TikTok URLs look like https://www.tiktok.com/@user/video/<numeric_id>
// or sometimes https://vm.tiktok.com/<short>. We extract the numeric id
// when present. Short URLs we can't resolve without a HEAD redirect —
// caller can choose to follow.
export function extractTikTokVideoId(url: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  const m = trimmed.match(/\/video\/(\d{6,})/);
  if (m && m[1]) return m[1];
  // Some users paste just the numeric id.
  if (/^\d{6,}$/.test(trimmed)) return trimmed;
  return null;
}

// YouTube IDs are 11-char URL-safe base64. Handle:
//   • https://youtube.com/watch?v=XXXX
//   • https://youtu.be/XXXX
//   • https://youtube.com/shorts/XXXX
//   • plain id
export function extractYouTubeVideoId(url: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  // shorts/<id>
  let m = trimmed.match(/\/shorts\/([A-Za-z0-9_-]{6,})/);
  if (m && m[1]) return m[1].slice(0, 11);
  // watch?v=<id>
  m = trimmed.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
  if (m && m[1]) return m[1].slice(0, 11);
  // youtu.be/<id>
  m = trimmed.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  if (m && m[1]) return m[1].slice(0, 11);
  // bare 11-char id
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  return null;
}

// Instagram media IDs aren't in the URL directly — the URL uses a
// short "shortcode" (e.g. https://instagram.com/reel/Cxxxx/). We store
// the shortcode and resolve to the API media id at review time.
export function extractInstagramShortcode(url: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  // /reel/CODE/ or /p/CODE/ or /tv/CODE/
  const m = trimmed.match(
    /instagram\.com\/(?:reel|p|tv)\/([A-Za-z0-9_-]{5,})/i,
  );
  if (m && m[1]) return m[1];
  // Bare-ish shortcode
  if (/^[A-Za-z0-9_-]{5,20}$/.test(trimmed)) return trimmed;
  return null;
}

// Generic dispatch — pass the platform + a URL/id and get a normalized
// provider-side id back. Returns null when nothing parseable.
export function extractPostedVideoId(
  platform: string,
  urlOrId: string,
): string | null {
  switch (platform) {
    case "tiktok":
      return extractTikTokVideoId(urlOrId);
    case "youtube":
      return extractYouTubeVideoId(urlOrId);
    case "instagram":
      return extractInstagramShortcode(urlOrId);
    default:
      return null;
  }
}

import { tool } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "../crypto";

// Video transcription via Apify (download URL) → OpenAI Whisper.
// Requires both an Apify service key (for the download URL) and an
// OpenAI API key (for Whisper). The agent gets this tool only when
// both are present in the user's stored credentials.

const APIFY_ACTOR_ID = "clockworks~tiktok-scraper";
const WHISPER_MODEL = "whisper-1";
// Whisper API max file size is 25MB. Most TikTok videos under 60s are
// 5-15MB, so we're safe — but bail early if we get something huge.
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;

async function fetchTikTokDownloadUrl(
  apifyToken: string,
  videoUrl: string,
): Promise<string> {
  const res = await fetch(
    `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/run-sync-get-dataset-items?token=${encodeURIComponent(
      apifyToken,
    )}&timeout=60`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        postURLs: [videoUrl],
        resultsPerPage: 1,
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      `Apify ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  const items = (await res.json()) as Array<Record<string, unknown>>;
  const item = items[0];
  if (!item) throw new Error("Apify returned no results for that URL");

  // The clockworks scraper exposes the playable URL under different
  // keys depending on TikTok's response shape. Try them in order.
  const videoMeta = item.videoMeta as Record<string, unknown> | undefined;
  const download =
    (videoMeta?.downloadAddr as string | undefined) ??
    (item.mediaUrls as string[] | undefined)?.[0] ??
    (item.videoUrl as string | undefined) ??
    (videoMeta?.playAddr as string | undefined);
  if (!download) {
    throw new Error(
      "Apify response didn't include a downloadable video URL — TikTok may be blocking the scrape for this video.",
    );
  }
  return download;
}

async function transcribeAudio(
  openaiKey: string,
  videoBytes: ArrayBuffer,
): Promise<string> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([videoBytes], { type: "video/mp4" }),
    "video.mp4",
  );
  form.append("model", WHISPER_MODEL);
  form.append("response_format", "text");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(
      `Whisper ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  // With response_format=text, the body is the transcript itself.
  return (await res.text()).trim();
}

export function buildTranscriptionTools(
  apifyToken: string,
  openaiKey: string,
) {
  return {
    tiktok_transcribe_video: tool({
      description:
        "Transcribe the spoken audio of a TikTok video. Use this to analyze the exact hooks, pacing, and scripts of top-performing videos (your own or competitors). Returns plain-text transcript. Costs ~$0.003 per 30-second video (Whisper) plus an Apify call.",
      inputSchema: z.object({
        url: z
          .string()
          .url()
          .describe(
            "Full TikTok video URL (share_url from tiktok_list_my_videos, or any public tiktok.com/@user/video/... URL)",
          ),
      }),
      execute: async ({ url }) => {
        const downloadUrl = await fetchTikTokDownloadUrl(apifyToken, url);

        const videoRes = await fetch(downloadUrl);
        if (!videoRes.ok) {
          throw new Error(
            `Video download failed: ${videoRes.status} ${videoRes.statusText}`,
          );
        }
        const contentLength = Number(videoRes.headers.get("content-length") ?? 0);
        if (contentLength && contentLength > MAX_VIDEO_BYTES) {
          throw new Error(
            `Video too large to transcribe (${Math.round(contentLength / 1024 / 1024)}MB, max 25MB)`,
          );
        }
        const bytes = await videoRes.arrayBuffer();
        if (bytes.byteLength > MAX_VIDEO_BYTES) {
          throw new Error(
            `Video too large to transcribe (${Math.round(bytes.byteLength / 1024 / 1024)}MB, max 25MB)`,
          );
        }

        const transcript = await transcribeAudio(openaiKey, bytes);
        return {
          url,
          transcript,
          char_count: transcript.length,
        };
      },
    }),
  };
}

// Load the user's OpenAI key specifically (not just the "first" key).
// Returns null if no OpenAI key is configured.
export async function loadOpenAIKey(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("user_api_keys")
    .select("encrypted_key")
    .eq("user_id", userId)
    .eq("provider", "openai")
    .maybeSingle();
  if (!data?.encrypted_key) return null;
  try {
    return decrypt(data.encrypted_key);
  } catch {
    return null;
  }
}

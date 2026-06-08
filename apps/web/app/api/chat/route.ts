import { NextResponse, type NextRequest } from "next/server";
import { streamText, stepCountIs, type ModelMessage } from "ai";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  decrypt,
  getModel,
  isProvider,
  buildToolsForUser,
} from "@agentflow/core";

type IncomingMessage = { role: "user" | "assistant"; content: string };

const MAX_STEPS = 12;

// Keep the function alive long enough for multi-step tool loops. Vercel
// kills the function at this boundary even if streamText is still going,
// so the job row's `running` status doubles as a watchdog (the client
// shows it indefinitely; a sweeper can mark it `failed` past the limit).
export const maxDuration = 60;

function systemPromptFor(connected: string[]): string {
  const lines = [
    "You are agentflow, a personal assistant with access to the user's connected tools.",
    "Be concise. When using tools, explain what you're about to do in one short sentence, call the tool, then describe what came back.",
    "Never invent data — if you don't know something, call a tool or ask.",
  ];
  const hasYouTube = connected.includes("youtube");
  const hasTikTok = connected.includes("tiktok");
  const hasInstagram = connected.includes("instagram");
  if (hasYouTube || hasTikTok || hasInstagram) {
    lines.push(
      "",
      "Multi-account routing:",
      "- The user may have multiple accounts connected for the same platform (e.g. two YouTube channels). Every youtube_/tiktok_/instagram_ tool now accepts an `account` parameter naming which account to use.",
      "- BEFORE calling any platform-data tool, if you don't already know which accounts exist for that provider, call the corresponding `*_list_my_accounts` tool first. It returns [{ id, label, handle }] — use the `label` value as the `account` argument on subsequent calls.",
      "- If the user names a specific account ('my Hammy channel'), match it to a label and pass that as `account`. If they're ambiguous and multiple accounts are connected, ask which one before proceeding.",
      "- When the user asks about 'my videos' or 'my channel' without specifying, call the list tool first and ASK them which account they mean. Don't just default to one — they almost always want a specific one.",
    );
  }
  lines.push(
    "",
    "Video ideas library:",
    "- The user has a curated /video-ideas page where each card is a shoot-ready concept (title, hook, full beat-by-beat script with SAY/ACTION/ON-SCREEN TEXT cues, post_title, description, hashtags, cta, visual_notes). Supports TikTok, YouTube (both Shorts and long-form), and Instagram accounts — each with its own platform-tuned prompt + research tools.",
    "- Tools: video_ideas_list_accounts (find which account to act on), video_ideas_list (browse pending/scheduled/done/dismissed ideas), video_ideas_get (full content of one), video_ideas_create (add a new idea — provide all the upload-ready content fields), video_ideas_update (rewrite hook, swap hashtags, polish script), video_ideas_set_status (scheduled / done / dismissed), video_ideas_delete (rarely — prefer dismissed), video_ideas_evaluate (judge a raw idea spark the user pitches you — returns add/needs_work/pass with reasoning; auto-inserts on 'add').",
    "- When the user pitches you a raw idea ('what if I do X?'), use video_ideas_evaluate rather than creating it directly — the evaluator is harsher and grounds its judgment in the creator's actual top performers + post-mortems.",
    "- Each idea also carries virality fields beyond the script: optimal_post_window (when to post), suggested_duration, thumbnail_concept (the cover frame), engagement_hook (what drives comments), trending_sound (if applicable). YouTube ideas additionally carry video_format ('short' | 'long'). Fill these whenever you create or update an idea — they're as important as the script for performance.",
    "- Five idea kinds drive expiry and intent: 'pattern' (the creator's winning format, 30d), 'trend' (currently visible in the niche, 7d), 'rising' (accelerating in the last 3-7 days but not yet peaked — be early to the curve, 5d), 'competitor' (a peer's hit that the creator hasn't done, 14d), 'seasonal' (calendar-anchored, with hard_date). Only label something 'rising' when you have explicit velocity evidence from the platform research tools — never invent acceleration.",
    "- Each idea can carry a saturation_warning string when the format/topic is showing oversaturation in the niche (e.g. '30+ similar videos with engagement down 40%'). Set this whenever you detect it — it tells the user to lean into a twist or skip.",
    "- Closed performance loop: when the user has posted a video for an idea, use video_ideas_mark_posted to link the video URL (TikTok / YouTube / Instagram all supported — same tool, the platform is detected from the URL) — this auto-schedules a +48h review. Use video_ideas_run_review to pull stats + post-mortem on demand. The post-mortem includes a verdict (hit / on_track / underperformed / too_early), the engagement-rate ratio vs the creator's median, and actionable takeaways. Read past reviews via video_ideas_get before suggesting new ideas — they're ground truth about what works for this audience.",
    "- When creating ideas, ground them in evidence: call the platform-specific research tools (tiktok_top_my_videos / youtube_list_my_videos / instagram_list_my_media etc., plus the Apify niche search tools when available) first to anchor on what actually works for THIS creator on THIS platform. Never invent hashtags or stats.",
    "- Match the creator's voice from their existing videos. The script should be specific enough to record without thinking — labeled time-stamped blocks with explicit spoken lines, on-screen text overlays, camera actions, transitions, and audio cues.",
    "- Confirm with the user before bulk operations (create N ideas at once, delete several, mass-update).",
  );
  return lines.join("\n");
}

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    conversation_id?: string;
    messages?: IncomingMessage[];
  } | null;

  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return new NextResponse("messages required", { status: 400 });
  }
  const lastUser = body.messages[body.messages.length - 1];
  if (lastUser?.role !== "user") {
    return new NextResponse("last message must be from user", { status: 400 });
  }

  // Resolve provider key (BYOK, first configured).
  const { data: keys } = await supabase
    .from("user_api_keys")
    .select("provider, encrypted_key, model")
    .order("created_at", { ascending: true })
    .limit(1);

  if (!keys || keys.length === 0) {
    return new NextResponse(
      "Configure an AI provider key in Settings first.",
      { status: 400 },
    );
  }
  const { provider, encrypted_key, model: userModel } = keys[0]!;
  if (!isProvider(provider)) {
    return new NextResponse(`Unknown provider: ${provider}`, { status: 500 });
  }

  let apiKey: string;
  try {
    apiKey = decrypt(encrypted_key);
  } catch (err) {
    return new NextResponse(
      `Could not decrypt stored key: ${err instanceof Error ? err.message : "unknown"}`,
      { status: 500 },
    );
  }

  // Resolve tools from the user's connected integrations.
  const { tools, connected } = await buildToolsForUser(supabase, user.id);

  // Get-or-create the conversation row.
  let convoId = body.conversation_id;
  if (!convoId) {
    const { data: created, error } = await supabase
      .from("conversations")
      .insert({ user_id: user.id })
      .select("id")
      .single();
    if (error || !created) {
      return new NextResponse(
        error?.message ?? "Failed to create conversation",
        { status: 500 },
      );
    }
    convoId = created.id;
  }
  const conversationId: string = convoId!;

  // Persist the user's new message immediately.
  const { error: userInsertErr } = await supabase.from("messages").insert({
    conversation_id: conversationId,
    role: "user",
    content_json: lastUser.content,
  });
  if (userInsertErr) {
    return new NextResponse(userInsertErr.message, { status: 500 });
  }

  const model = getModel(provider, apiKey, userModel);
  const modelMessages: ModelMessage[] = body.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const isFirstTurn = body.messages.length <= 1;
  const conversationTitle = isFirstTurn ? lastUser.content.slice(0, 80) : null;

  // Insert a job row BEFORE streaming starts so the client (or any
  // future tab) can detect "an agent turn is in flight" via realtime
  // even if it never sees the SSE stream.
  const { data: jobRow } = await supabase
    .from("chat_turn_jobs")
    .insert({ user_id: user.id, conversation_id: conversationId })
    .select("id")
    .single();
  const jobId = jobRow?.id as string | undefined;

  const result = streamText({
    model,
    system: systemPromptFor(connected),
    messages: modelMessages,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: tools as any,
    stopWhen: stepCountIs(MAX_STEPS),
    onFinish: async ({ response }) => {
      // response.messages contains every turn generated this request:
      // assistant text + tool_call parts, plus tool result messages.
      // Persist all of them so the conversation can resume with full
      // fidelity on the next user turn.
      const rows = response.messages.map((m) => ({
        conversation_id: conversationId,
        role: m.role,
        content_json: m.content as unknown,
      }));
      if (rows.length > 0) {
        const { error: insertErr } = await supabase
          .from("messages")
          .insert(rows);
        if (insertErr) {
          console.error("Persist agent messages failed:", insertErr);
        }
      }

      const updates: { updated_at: string; title?: string } = {
        updated_at: new Date().toISOString(),
      };
      if (conversationTitle) updates.title = conversationTitle;
      await supabase
        .from("conversations")
        .update(updates)
        .eq("id", conversationId);

      // Mark the turn job complete LAST — clients listening on this
      // row treat the transition as "messages are now in the DB; safe
      // to re-pull / drop the in-flight indicator".
      if (jobId) {
        await supabase
          .from("chat_turn_jobs")
          .update({
            status: "done",
            finished_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", jobId);
      }
    },
    onError: async ({ error }) => {
      console.error("Stream error:", error);
      if (jobId) {
        await supabase
          .from("chat_turn_jobs")
          .update({
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            finished_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", jobId);
      }
    },
  });

  // Force the streamText to consume to completion regardless of whether
  // the response is actually read by the client. Without this, navigating
  // away from /chat mid-generation cancels the model call and we never
  // hit onFinish — the assistant turn is lost. With consumeStream(), the
  // stream drains in the background, onFinish persists messages + closes
  // the job, and the client picks it all up via realtime on its next
  // page load.
  result.consumeStream({
    onError: (e) => console.error("background consumeStream failed:", e),
  });

  return result.toUIMessageStreamResponse({
    headers: {
      "X-Conversation-Id": conversationId,
      ...(jobId ? { "X-Job-Id": jobId } : {}),
    },
  });
}

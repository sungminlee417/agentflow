import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getFreshAccessToken } from "@agentflow/core";

// POST /api/inbox/[id]/send
//
// Posts the (possibly user-edited) draft as a reply on the source
// platform. On success: marks comment_replies.status='sent' and
// captures sent_reply_id. On failure: marks 'failed' with
// send_error so the user sees what went wrong.
//
// Per-platform reply endpoints:
//   instagram  → POST /<comment_id>/replies { message } (Instagram
//                  Graph API, requires instagram_business_manage_comments)
//   youtube    → POST /comments?part=snippet { snippet: { parentId, textOriginal } }
//                  (Data API v3, requires youtube.force-ssl scope)
//   tiktok     → not yet — comment.create scope needs app review

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { data: row } = await supabase
    .from("comment_replies")
    .select(
      "id, platform, integration_id, source_comment_id, draft_text, status",
    )
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!row) return new NextResponse("Not found", { status: 404 });

  if (row.status !== "draft" && row.status !== "failed") {
    return NextResponse.json(
      { error: `Can't send a reply in status "${row.status}".` },
      { status: 400 },
    );
  }
  const draft = (row.draft_text as string | null)?.trim();
  if (!draft) {
    return NextResponse.json(
      { error: "Draft is empty — write a reply first." },
      { status: 400 },
    );
  }

  // Load the integration row to get fresh credentials.
  const { data: integration } = await supabase
    .from("integrations")
    .select(
      "id, provider, encrypted_access_token, encrypted_refresh_token, expires_at",
    )
    .eq("id", row.integration_id as string)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!integration) {
    return NextResponse.json(
      { error: "Source integration is no longer connected." },
      { status: 400 },
    );
  }

  let token: string;
  try {
    token = await getFreshAccessToken(
      supabase,
      user.id,
      integration.provider as "instagram" | "youtube",
      {
        id: integration.id as string,
        encrypted_access_token: integration.encrypted_access_token as string,
        encrypted_refresh_token: integration.encrypted_refresh_token as
          | string
          | null,
        expires_at: integration.expires_at as string | null,
      },
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: `OAuth refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    );
  }

  let sentReplyId: string | null = null;
  let sendError: string | null = null;
  try {
    if (row.platform === "instagram") {
      sentReplyId = await postInstagramReply(
        token,
        row.source_comment_id as string,
        draft,
      );
    } else if (row.platform === "youtube") {
      sentReplyId = await postYouTubeReply(
        token,
        row.source_comment_id as string,
        draft,
      );
    } else {
      sendError = `Platform "${row.platform}" doesn't support automated replies yet.`;
    }
  } catch (err) {
    sendError = err instanceof Error ? err.message : String(err);
  }

  if (sendError) {
    await supabase
      .from("comment_replies")
      .update({
        status: "failed",
        send_error: sendError.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", user.id);
    return NextResponse.json({ error: sendError }, { status: 502 });
  }

  await supabase
    .from("comment_replies")
    .update({
      status: "sent",
      sent_reply_id: sentReplyId,
      sent_at: new Date().toISOString(),
      send_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", user.id);
  return NextResponse.json({ ok: true, sent_reply_id: sentReplyId });
}

async function postInstagramReply(
  token: string,
  parentCommentId: string,
  message: string,
): Promise<string | null> {
  const url = new URL(`https://graph.instagram.com/${parentCommentId}/replies`);
  url.searchParams.set("access_token", token);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ message }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Instagram ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    const json = JSON.parse(text) as { id?: string };
    return json.id ?? null;
  } catch {
    return null;
  }
}

async function postYouTubeReply(
  token: string,
  parentCommentId: string,
  text: string,
): Promise<string | null> {
  const res = await fetch(
    "https://www.googleapis.com/youtube/v3/comments?part=snippet",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        snippet: { parentId: parentCommentId, textOriginal: text },
      }),
    },
  );
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`YouTube ${res.status}: ${body.slice(0, 300)}`);
  }
  try {
    const json = JSON.parse(body) as { id?: string };
    return json.id ?? null;
  } catch {
    return null;
  }
}

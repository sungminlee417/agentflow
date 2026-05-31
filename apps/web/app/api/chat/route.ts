import { NextResponse, type NextRequest } from "next/server";
import { streamText, stepCountIs, type ModelMessage } from "ai";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/crypto";
import { getModel, isProvider } from "@/lib/ai-providers";
import { buildToolsForUser } from "@/lib/tools";

type IncomingMessage = { role: "user" | "assistant"; content: string };

const MAX_STEPS = 12;

function systemPromptFor(connected: string[]): string {
  const lines = [
    "You are agentflow, a personal assistant with access to the user's connected tools.",
    "Be concise. When using tools, explain what you're about to do in one short sentence, call the tool, then describe what came back.",
    "Never invent data — if you don't know something, call a tool or ask.",
  ];
  if (connected.includes("github")) {
    lines.push(
      "",
      "GitHub workflow:",
      "- When proposing code changes, always read the existing file(s) first with github_get_file, then use github_create_pr to open a PR. Use a clear branch name like `agent/<short-description>`. Summarize the diff in the PR body.",
      "- For issues: use github_list_issues to find work, github_get_issue (with the issue number) to read full context including comments, and only then act. When you open a PR that addresses an issue, reference it in the PR body (`Closes #N`) and consider posting a github_post_issue_comment linking the PR.",
      "- Don't open a PR or post a comment without first explaining your plan to the user in chat and getting at least implicit consent (e.g. the user asked for it).",
    );
  }
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
    .select("provider, encrypted_key")
    .order("created_at", { ascending: true })
    .limit(1);

  if (!keys || keys.length === 0) {
    return new NextResponse(
      "Configure an AI provider key in Settings first.",
      { status: 400 },
    );
  }
  const { provider, encrypted_key } = keys[0]!;
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

  const model = getModel(provider, apiKey);
  const modelMessages: ModelMessage[] = body.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const isFirstTurn = body.messages.length <= 1;
  const conversationTitle = isFirstTurn ? lastUser.content.slice(0, 80) : null;

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
    },
    onError: ({ error }) => {
      console.error("Stream error:", error);
    },
  });

  return result.toUIMessageStreamResponse({
    headers: { "X-Conversation-Id": conversationId },
  });
}

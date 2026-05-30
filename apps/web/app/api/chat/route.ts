import { NextResponse, type NextRequest } from "next/server";
import { generateText, type ModelMessage } from "ai";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/crypto";
import { getModel, isProvider } from "@/lib/ai-providers";

type IncomingMessage = { role: "user" | "assistant"; content: string };

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

  // Pick the first configured provider key. Per-conversation provider
  // selection comes later.
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

  // Persist the user's new message.
  const { error: userInsertErr } = await supabase.from("messages").insert({
    conversation_id: convoId,
    role: "user",
    content_json: lastUser.content,
  });
  if (userInsertErr) {
    return new NextResponse(userInsertErr.message, { status: 500 });
  }

  // Call the model.
  const model = getModel(provider, apiKey);
  const modelMessages: ModelMessage[] = body.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let assistantText: string;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  try {
    const result = await generateText({
      model,
      messages: modelMessages,
    });
    assistantText = result.text;
    inputTokens = result.usage?.inputTokens ?? null;
    outputTokens = result.usage?.outputTokens ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new NextResponse(`Provider error: ${message}`, { status: 502 });
  }

  // Persist the assistant message.
  const { data: asstRow, error: asstErr } = await supabase
    .from("messages")
    .insert({
      conversation_id: convoId,
      role: "assistant",
      content_json: assistantText,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    })
    .select("id")
    .single();
  if (asstErr || !asstRow) {
    return new NextResponse(asstErr?.message ?? "Failed to store reply", {
      status: 500,
    });
  }

  // Title the conversation from the first user message (cheap heuristic).
  const isFirstTurn = body.messages.length <= 1;
  const updates: { updated_at: string; title?: string } = {
    updated_at: new Date().toISOString(),
  };
  if (isFirstTurn) updates.title = lastUser.content.slice(0, 80);
  await supabase.from("conversations").update(updates).eq("id", convoId);

  return NextResponse.json({
    conversation_id: convoId,
    assistant: { id: asstRow.id, text: assistantText },
  });
}

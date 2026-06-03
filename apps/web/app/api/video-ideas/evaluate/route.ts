import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runEvaluateIdea, persistEvaluatedIdea } from "@agentflow/core";

// Evaluate a raw user-submitted idea spark.
//
// Request: { integration_id, text, add_if_good?: boolean }
//
// add_if_good=true: when the verdict is "add", immediately insert
// the fleshed idea into the library and return its id. Lets the UI
// offer one-click "add this" without a second round-trip.

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    integration_id?: string;
    text?: string;
    add_if_good?: boolean;
  } | null;

  if (!body?.integration_id || !body.text?.trim()) {
    return NextResponse.json(
      { error: "integration_id and text are required." },
      { status: 400 },
    );
  }

  const result = await runEvaluateIdea({
    supabase,
    userId: user.id,
    integrationId: body.integration_id,
    rawIdea: body.text,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error ?? "Evaluation failed." },
      { status: 500 },
    );
  }

  let addedId: string | undefined;
  if (body.add_if_good && result.verdict === "add" && result.idea) {
    const persisted = await persistEvaluatedIdea(
      supabase,
      user.id,
      body.integration_id,
      result.idea,
    );
    if (!persisted.ok) {
      return NextResponse.json(
        { error: `Insert failed: ${persisted.error}` },
        { status: 500 },
      );
    }
    addedId = persisted.id;
  }

  return NextResponse.json({
    verdict: result.verdict,
    reasoning: result.reasoning,
    idea: result.idea,
    added_id: addedId,
    tokens: result.tokens,
  });
}

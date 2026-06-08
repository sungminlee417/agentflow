import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// PATCH supports:
//   • status (4-way enum) and/or priority (integer) — orchestration
//   • content-shaped fields the user can edit inline — title, hook,
//     script, post_title, description, hashtags, cta, visual_notes,
//     optimal_post_window, suggested_duration, thumbnail_concept,
//     engagement_hook, trending_sound, and the per-platform `platforms`
//     pack. kind / format / source_refs / expires_at / video_format are
//     deliberately NOT editable — they drive expiry math + agent lookup
//     patterns and shouldn't be decoupled from the agent's evidence.
//
// Status promotion logic:
//   • When an idea is promoted to 'scheduled' AND no explicit
//     priority is provided, we auto-assign it to the end of the
//     queue: max(priority) + 10000 across the user/integration's
//     scheduled rows. The big gap leaves room for drag-and-drop
//     inserts without needing to rewrite neighbors.
//
// Edit logging: when the user changes a content field's value, we
// insert a video_idea_edits row capturing { field, original, edited }
// — the unified generator reads these per-account on the next refresh
// to nudge its voice toward what the creator actually ships.

const VALID_STATUSES = new Set(["pending", "scheduled", "done", "dismissed"]);
const PRIORITY_STEP = 10000;

// Content fields editable from the detail modal. The shape must mirror
// the columns on video_ideas — values are applied directly.
const EDITABLE_TEXT_FIELDS = new Set([
  "title",
  "hook",
  "rationale",
  "script",
  "post_title",
  "description",
  "cta",
  "visual_notes",
  "optimal_post_window",
  "suggested_duration",
  "thumbnail_concept",
  "engagement_hook",
  "trending_sound",
  "saturation_warning",
]);

type PlatformPack = {
  tiktok?: { caption: string; hashtags: string[] } | null;
  youtube?:
    | { title: string; description: string; hashtags: string[] }
    | null;
  instagram?: { caption: string; hashtags: string[] } | null;
} | null;

type PatchBody = {
  status?: string;
  priority?: number;
  // Text fields — declared by name so TS narrows.
  title?: string | null;
  hook?: string | null;
  rationale?: string | null;
  script?: string | null;
  post_title?: string | null;
  description?: string | null;
  cta?: string | null;
  visual_notes?: string | null;
  optimal_post_window?: string | null;
  suggested_duration?: string | null;
  thumbnail_concept?: string | null;
  engagement_hook?: string | null;
  trending_sound?: string | null;
  saturation_warning?: string | null;
  // Arrays + object packs.
  hashtags?: string[] | null;
  platforms?: PlatformPack;
};

function stripHash(h: string): string {
  return h.replace(/^#/, "");
}

// Logs an edit ONLY when the value substantively changed. Whitespace
// tweaks and one-character typos don't move the needle for the learning
// loop — and would drown out the actual voice signal.
function isSubstantiveChange(
  before: unknown,
  after: unknown,
): boolean {
  const a = String(before ?? "").trim();
  const b = String(after ?? "").trim();
  if (a === b) return false;
  // Treat <8 char or <10% diff as cosmetic (typo / capitalisation).
  const minLen = Math.min(a.length, b.length);
  const lenDiff = Math.abs(a.length - b.length);
  if (lenDiff < 8 && minLen > 0 && lenDiff / minLen < 0.1) return false;
  return true;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const body = (await req.json().catch(() => null)) as PatchBody | null;
  if (!body) return new NextResponse("Invalid body", { status: 400 });

  if (body.status !== undefined && !VALID_STATUSES.has(body.status)) {
    return new NextResponse("Invalid status", { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (body.status !== undefined) patch.status = body.status;
  if (body.priority !== undefined) patch.priority = body.priority;

  // Apply text fields (allow null to clear).
  for (const field of EDITABLE_TEXT_FIELDS) {
    const value = body[field as keyof PatchBody];
    if (value === undefined) continue;
    patch[field] = value;
  }

  // Hashtags — strip leading # and trim.
  if (body.hashtags !== undefined) {
    patch.hashtags = body.hashtags
      ? body.hashtags.map((h) => stripHash(String(h)).trim()).filter(Boolean)
      : [];
  }

  // Per-platform packs. Replace wholesale — caller must send the full
  // pack they want preserved. Hashtags inside each pack are stripped
  // of leading # too.
  if (body.platforms !== undefined) {
    if (body.platforms === null) {
      patch.platforms = null;
    } else {
      const normalised: NonNullable<PlatformPack> = {};
      if (body.platforms.tiktok) {
        normalised.tiktok = {
          caption: body.platforms.tiktok.caption,
          hashtags: (body.platforms.tiktok.hashtags ?? []).map(stripHash),
        };
      }
      if (body.platforms.youtube) {
        normalised.youtube = {
          title: body.platforms.youtube.title,
          description: body.platforms.youtube.description,
          hashtags: (body.platforms.youtube.hashtags ?? []).map(stripHash),
        };
      }
      if (body.platforms.instagram) {
        normalised.instagram = {
          caption: body.platforms.instagram.caption,
          hashtags: (body.platforms.instagram.hashtags ?? []).map(stripHash),
        };
      }
      patch.platforms = normalised;
    }
  }

  if (Object.keys(patch).length === 0) {
    return new NextResponse("Nothing to update", { status: 400 });
  }

  // Read current row so we can: (a) check ownership, (b) seed tail-
  // priority on scheduled promotion, (c) diff content fields for the
  // edit log.
  const { data: existing } = await supabase
    .from("video_ideas")
    .select(
      "integration_id, title, hook, rationale, script, post_title, description, hashtags, cta, visual_notes, optimal_post_window, suggested_duration, thumbnail_concept, engagement_hook, trending_sound, saturation_warning, platforms",
    )
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!existing) {
    return new NextResponse("Not found", { status: 404 });
  }

  if (body.status === "scheduled" && body.priority === undefined) {
    const { data: maxRow } = await supabase
      .from("video_ideas")
      .select("priority")
      .eq("user_id", user.id)
      .eq("integration_id", existing.integration_id)
      .eq("status", "scheduled")
      .order("priority", { ascending: false })
      .limit(1)
      .maybeSingle();
    const next = (maxRow?.priority ?? 0) + PRIORITY_STEP;
    patch.priority = next;
  }

  const { error } = await supabase
    .from("video_ideas")
    .update(patch)
    .eq("id", id)
    .eq("user_id", user.id);
  if (error) return new NextResponse(error.message, { status: 500 });

  // Edit log — only for text fields with substantive changes. Fire-and-
  // forget; failures here shouldn't break the user-facing save.
  const editRows: Array<{
    user_id: string;
    idea_id: string;
    integration_id: string | null;
    field: string;
    original_value: string | null;
    edited_value: string | null;
  }> = [];
  for (const field of EDITABLE_TEXT_FIELDS) {
    if (body[field as keyof PatchBody] === undefined) continue;
    const before = (existing as Record<string, unknown>)[field];
    const after = body[field as keyof PatchBody];
    if (!isSubstantiveChange(before, after)) continue;
    editRows.push({
      user_id: user.id,
      idea_id: id,
      integration_id: (existing.integration_id as string | null) ?? null,
      field,
      original_value: before == null ? null : String(before).slice(0, 8000),
      edited_value: after == null ? null : String(after).slice(0, 8000),
    });
  }
  if (editRows.length > 0) {
    void supabase
      .from("video_idea_edits")
      .insert(editRows)
      .then(({ error: editErr }) => {
        if (editErr) {
          console.error("[video-ideas/PATCH] edit-log insert failed:", editErr.message);
        }
      });
  }

  return new NextResponse(null, { status: 204 });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { error } = await supabase
    .from("video_ideas")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) return new NextResponse(error.message, { status: 500 });
  return new NextResponse(null, { status: 204 });
}

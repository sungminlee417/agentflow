import { z } from "zod";
import type { GeneratedIdea } from "./types";

// JSON parser for the agent's final response. The model SHOULD just
// return `{ideas: [...]}` but in practice we have to be defensive:
//   - It sometimes prepends prose ("Perfect. Here are the ideas:")
//   - It sometimes wraps the output in a ```json ... ``` fence
//   - It sometimes emits the array form without the envelope
// collectJsonCandidates tries each variant in order and parseIdeas
// returns the first one that validates against IDEAS_ENVELOPE_SCHEMA.

// Compact schema hint used by the parse-failure retry. Kept tiny — the
// retry doesn't need the per-platform packaging rules, just enough
// shape that the model produces valid JSON.
export const SCHEMA_HINT = `{ "ideas":[{
  "title":string, "hook":string, "format":string, "rationale":string,
  "kind":"pattern"|"trend"|"rising"|"competitor"|"seasonal",
  "source_refs":{...}, "hard_date":string, "saturation_warning":string|null,
  "script":string, "post_title":string, "description":string,
  "hashtags":[string], "cta":string, "visual_notes":string,
  "optimal_post_window":string, "suggested_duration":string,
  "thumbnail_concept":string, "engagement_hook":string,
  "trending_sound":string|null,
  "platforms":{ /* one of: tiktok={caption,hashtags}, youtube={title,description,hashtags}, instagram={caption,hashtags} */ }
}] }`;

export function parseIdeas(
  text: string,
  envelopeSchema: z.ZodTypeAny,
): GeneratedIdea[] | null {
  const candidates = collectJsonCandidates(text);
  for (const candidate of candidates) {
    try {
      const json = JSON.parse(candidate);
      const result = envelopeSchema.safeParse(json);
      if (!result.success) continue;
      const data = result.data as
        | { ideas: GeneratedIdea[] }
        | GeneratedIdea[];
      const ideas = Array.isArray(data) ? data : data.ideas;
      return ideas;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function collectJsonCandidates(text: string): string[] {
  const out: string[] = [];
  const trimmed = text.trim();
  out.push(trimmed);

  // Fenced ```json ... ``` blocks
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(trimmed)) !== null) {
    if (m[1]) out.push(m[1].trim());
  }

  // First balanced object
  const obj = extractBalanced(trimmed, "{", "}");
  if (obj) out.push(obj);
  // First balanced array
  const arr = extractBalanced(trimmed, "[", "]");
  if (arr) out.push(arr);

  return out;
}

function extractBalanced(
  s: string,
  open: string,
  close: string,
): string | null {
  const start = s.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

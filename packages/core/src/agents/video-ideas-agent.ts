// Back-compat shim. The unified multi-account generator now lives at
// ./video-ideas/unified-agent. This file re-exports under the old name
// so `@agentflow/core` consumers that import `runVideoIdeasAgent` or
// `computeExpiresAt` keep working without churn.
//
// The legacy single-account signature (integrationId + count + optional
// targetPlatforms) maps onto the unified API as a single-element
// integrationIds array + totalCount. The unified prompt's
// "aggressive-within-niche" multi-targeting rule becomes a no-op when
// only one account is in scope, so behaviour for legacy callers is the
// same shape of output — just with the additional target_integration_ids
// and primary_integration_id fields populated to that one account.

import type { SupabaseClient } from "@supabase/supabase-js";
import { runUnifiedVideoIdeasAgent } from "./video-ideas/unified-agent";
import type { VideoIdeasResult } from "./video-ideas/types";

export {
  computeExpiresAt,
  KIND_TTL_DAYS,
  runUnifiedVideoIdeasAgent,
} from "./video-ideas/unified-agent";

export type {
  GeneratedIdea,
  PlatformPack,
  VideoIdeaKind,
  VideoIdeasResult,
} from "./video-ideas/types";

export async function runVideoIdeasAgent({
  supabase,
  userId,
  integrationId,
  count,
  onStep,
  // targetPlatforms is accepted for back-compat but ignored — the
  // unified prompt decides per-platform packaging from target_integration_ids.
  targetPlatforms: _targetPlatforms,
}: {
  supabase: SupabaseClient;
  userId: string;
  integrationId: string;
  count: number;
  onStep?: (s: { count: number; description: string }) => Promise<void> | void;
  targetPlatforms?: string[];
}): Promise<VideoIdeasResult> {
  return runUnifiedVideoIdeasAgent({
    supabase,
    userId,
    integrationIds: [integrationId],
    totalCount: count,
    onStep,
  });
}

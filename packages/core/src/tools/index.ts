import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "../crypto.js";
import { buildGitHubTools } from "./github.js";

// Compose the agent's tool set based on which integrations the user
// has connected. A tool only appears to the model if its credentials
// are present — that way the model never tries to call something it
// can't actually use.

export async function buildToolsForUser(
  supabase: SupabaseClient,
  userId: string,
) {
  const { data: integrations } = await supabase
    .from("integrations")
    .select("provider, encrypted_access_token")
    .eq("user_id", userId);

  const tools: Record<string, unknown> = {};
  const connected: string[] = [];

  for (const i of integrations ?? []) {
    if (!i.encrypted_access_token) continue;
    try {
      const token = decrypt(i.encrypted_access_token);
      if (i.provider === "github") {
        Object.assign(tools, buildGitHubTools(token));
        connected.push("github");
      }
    } catch (err) {
      console.error(
        `Failed to decrypt ${i.provider} token for user ${userId}:`,
        err,
      );
    }
  }

  return { tools, connected };
}

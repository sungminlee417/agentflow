import type { ModelOption, ProviderName } from "./ai-providers";

// Fetch the live list of models a given API key can use. Each provider
// exposes a /models endpoint we can hit with the user's own key (no
// scraping or hardcoded lists rotting over time). We filter to text
// chat-capable models — embeddings / audio / image-only models are
// dropped.
//
// Returns ModelOption[] sorted with the newest/most-capable first.

export async function listModels(
  provider: ProviderName,
  apiKey: string,
): Promise<ModelOption[]> {
  switch (provider) {
    case "anthropic":
      return listAnthropicModels(apiKey);
    case "openai":
      return listOpenAIModels(apiKey);
    case "google":
      return listGoogleModels(apiKey);
  }
}

async function listAnthropicModels(apiKey: string): Promise<ModelOption[]> {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  if (!res.ok) {
    throw new Error(
      `Anthropic /models ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as {
    data?: Array<{
      type?: string;
      id?: string;
      display_name?: string;
      created_at?: string;
    }>;
  };
  const items = (json.data ?? [])
    .filter(
      (m) =>
        m.type === "model" && typeof m.id === "string" && m.id.startsWith("claude-"),
    )
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return items.map((m) => ({
    id: m.id!,
    label: m.display_name ? `${m.display_name} (${m.id})` : m.id!,
  }));
}

async function listOpenAIModels(apiKey: string): Promise<ModelOption[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(
      `OpenAI /models ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as {
    data?: Array<{ id?: string; created?: number }>;
  };

  // Keep chat-capable text models. OpenAI returns everything (embeddings,
  // whisper, dall-e, tts, image) — we want the gpt-* and o<digit>* lines.
  const CHAT_PREFIX = /^(gpt-|o\d|chatgpt-)/;
  const EXCLUDE = /-(audio|tts|whisper|realtime|transcribe|search|embedding|image|moderation|preview-vision|gizmo)/;
  const items = (json.data ?? [])
    .filter(
      (m) =>
        typeof m.id === "string" &&
        CHAT_PREFIX.test(m.id) &&
        !EXCLUDE.test(m.id),
    )
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  return items.map((m) => ({ id: m.id!, label: m.id! }));
}

async function listGoogleModels(apiKey: string): Promise<ModelOption[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200`,
  );
  if (!res.ok) {
    throw new Error(
      `Google /models ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as {
    models?: Array<{
      name?: string;
      displayName?: string;
      supportedGenerationMethods?: string[];
    }>;
  };
  const items = (json.models ?? []).filter(
    (m) =>
      typeof m.name === "string" &&
      m.name.startsWith("models/gemini-") &&
      (m.supportedGenerationMethods ?? []).includes("generateContent"),
  );
  return items
    .map((m) => ({
      id: m.name!.replace(/^models\//, ""),
      label: m.displayName ? `${m.displayName} (${m.name!.replace(/^models\//, "")})` : m.name!,
    }))
    .sort((a, b) => b.id.localeCompare(a.id));
}

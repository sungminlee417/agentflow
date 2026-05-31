import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

// BYOK provider routing. Each user picks a provider + supplies their own
// API key (stored encrypted in user_api_keys). The /api/chat route
// resolves the user's chosen provider + key into an AI-SDK model and
// passes it to `streamText` / `generateText`.

export type ProviderName = "anthropic" | "openai" | "google";

export const PROVIDERS: { name: ProviderName; label: string; keyHint: string }[] = [
  { name: "anthropic", label: "Anthropic (Claude)", keyHint: "sk-ant-..." },
  { name: "openai", label: "OpenAI (GPT)", keyHint: "sk-..." },
  { name: "google", label: "Google (Gemini)", keyHint: "AIza..." },
];

export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  google: "gemini-2.5-pro",
};

export function isProvider(s: string): s is ProviderName {
  return s === "anthropic" || s === "openai" || s === "google";
}

export function getModel(
  provider: ProviderName,
  apiKey: string,
  modelId?: string,
): LanguageModel {
  const id = modelId ?? DEFAULT_MODELS[provider];
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(id);
    case "openai":
      return createOpenAI({ apiKey })(id);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(id);
  }
}

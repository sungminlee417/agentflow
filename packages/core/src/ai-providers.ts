import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

// BYOK provider routing. Each user picks a provider + supplies their
// own API key + optional model id (stored in user_api_keys). When the
// model is null we fall back to DEFAULT_MODELS.

export type ProviderName = "anthropic" | "openai" | "google";

export const PROVIDERS: {
  name: ProviderName;
  label: string;
  keyHint: string;
}[] = [
  { name: "anthropic", label: "Anthropic (Claude)", keyHint: "sk-ant-..." },
  { name: "openai", label: "OpenAI (GPT)", keyHint: "sk-..." },
  { name: "google", label: "Google (Gemini)", keyHint: "AIza..." },
];

export type ModelOption = { id: string; label: string };

// User-selectable models per provider. The default (used when none is
// stored) is whichever is marked default below. Haiku / mini / flash
// are the fast/cheap/high-TPM tiers — usually the right pick for
// agent loops since rate limits there are far more generous.
export const MODELS: Record<ProviderName, ModelOption[]> = {
  anthropic: [
    { id: "claude-haiku-4-5", label: "claude-haiku-4-5 (fast, cheap)" },
    { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6 (balanced)" },
    { id: "claude-opus-4-7", label: "claude-opus-4-7 (most capable)" },
  ],
  openai: [
    { id: "gpt-4o-mini", label: "gpt-4o-mini (fast, cheap)" },
    { id: "gpt-4o", label: "gpt-4o (balanced)" },
  ],
  google: [
    { id: "gemini-2.5-flash", label: "gemini-2.5-flash (fast, cheap)" },
    { id: "gemini-2.5-pro", label: "gemini-2.5-pro (most capable)" },
  ],
};

export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  google: "gemini-2.5-pro",
};

export function isProvider(s: string): s is ProviderName {
  return s === "anthropic" || s === "openai" || s === "google";
}

export function isValidModelFor(
  provider: ProviderName,
  modelId: string,
): boolean {
  return MODELS[provider].some((m) => m.id === modelId);
}

export function getModel(
  provider: ProviderName,
  apiKey: string,
  modelId?: string | null,
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

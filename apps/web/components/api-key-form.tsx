"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  MODELS,
  DEFAULT_MODELS,
  type ProviderName,
  type ModelOption,
} from "@agentflow/core";
import { useConfirm } from "@/components/confirm-dialog";

export function ApiKeyForm({
  provider,
  label,
  keyHint,
  existingLast4,
  existingModel,
}: {
  provider: ProviderName;
  label: string;
  keyHint: string;
  existingLast4: string | null;
  existingModel: string | null;
}) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [value, setValue] = useState("");
  const [model, setModel] = useState<string>(
    existingModel ?? DEFAULT_MODELS[provider],
  );
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  // Static catalog (curated defaults) — used until the live list arrives
  // or as a fallback if the provider's /models endpoint errors.
  const staticModels = MODELS[provider];
  const [liveModels, setLiveModels] = useState<ModelOption[] | null>(null);
  const [liveStatus, setLiveStatus] = useState<"idle" | "loading" | "error">(
    "idle",
  );
  const [liveError, setLiveError] = useState<string | null>(null);

  const displayModels = liveModels ?? staticModels;

  async function loadLiveModels() {
    if (!existingLast4) return; // need a saved key to call the provider
    setLiveStatus("loading");
    setLiveError(null);
    try {
      const res = await fetch(`/api/models?provider=${provider}`);
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { models: ModelOption[] };
      if (data.models.length === 0) {
        // empty list — keep static fallback
        setLiveStatus("error");
        setLiveError("Provider returned no models — using defaults.");
        return;
      }
      setLiveModels(data.models);
      setLiveStatus("idle");
    } catch (err) {
      setLiveStatus("error");
      setLiveError(err instanceof Error ? err.message : "fetch failed");
    }
  }

  // Auto-load once on mount when a key is configured.
  useEffect(() => {
    void loadLiveModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingLast4]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setError(null);
    const res = await fetch("/api/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, key: value, model }),
    });
    if (!res.ok) {
      setStatus("error");
      setError((await res.text()) || "Failed to save");
      return;
    }
    setValue("");
    setStatus("saved");
    router.refresh();
    setTimeout(() => setStatus("idle"), 1500);
  }

  async function changeModel(newModel: string) {
    setModel(newModel);
    if (!existingLast4) return;
    const res = await fetch("/api/api-keys", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, model: newModel }),
    });
    if (res.ok) router.refresh();
  }

  async function remove() {
    if (!existingLast4) return;
    const ok = await confirm({
      title: `Remove your ${label} key?`,
      description: "You can paste a new one any time.",
      confirmLabel: "Remove",
    });
    if (!ok) return;
    const res = await fetch(`/api/api-keys?provider=${provider}`, {
      method: "DELETE",
    });
    if (res.ok) router.refresh();
  }

  // If the saved model isn't in the displayed list, include it as a
  // standalone option so we never show a blank dropdown.
  const optionsWithSelected =
    displayModels.some((m) => m.id === model)
      ? displayModels
      : [{ id: model, label: model }, ...displayModels];

  return (
    <form
      onSubmit={save}
      className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {label}
          </h3>
          <p className="mt-0.5 text-xs text-neutral-500">
            {existingLast4
              ? `Configured · ends in ${existingLast4}`
              : "Not configured"}
          </p>
        </div>
        {existingLast4 && (
          <button
            type="button"
            onClick={remove}
            className="text-xs text-neutral-500 transition hover:text-red-500 dark:text-neutral-400 dark:hover:text-red-400"
          >
            Remove
          </button>
        )}
      </div>

      <div className="mt-3 flex gap-2">
        <input
          type="password"
          autoComplete="off"
          placeholder={keyHint}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500"
        />
        <button
          type="submit"
          disabled={status === "saving" || value.length === 0}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
        >
          {status === "saving"
            ? "Saving…"
            : status === "saved"
              ? "Saved"
              : existingLast4
                ? "Replace"
                : "Save"}
        </button>
      </div>

      <div className="mt-3 flex items-center gap-2 text-xs">
        <label className="text-neutral-500" htmlFor={`${provider}-model`}>
          Model
        </label>
        <select
          id={`${provider}-model`}
          value={model}
          onChange={(e) => changeModel(e.target.value)}
          className="flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        >
          {optionsWithSelected.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        {existingLast4 && (
          <button
            type="button"
            onClick={loadLiveModels}
            disabled={liveStatus === "loading"}
            className="text-[11px] text-neutral-500 transition hover:text-neutral-900 disabled:opacity-50 dark:hover:text-neutral-100"
            title="Refetch the list of models from the provider"
          >
            {liveStatus === "loading"
              ? "…"
              : liveModels
                ? "Refresh"
                : "Load latest"}
          </button>
        )}
      </div>

      {liveError && (
        <p className="mt-1.5 text-[11px] text-neutral-500">
          Live list unavailable ({liveError.slice(0, 80)}) — showing defaults.
        </p>
      )}

      {error && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
      {dialog}
    </form>
  );
}

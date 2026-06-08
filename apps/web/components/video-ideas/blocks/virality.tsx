"use client";

import { Clock, Music, Timer, type LucideIcon } from "lucide-react";
import type { VideoIdeaRow } from "../types";

// ViralityStrip — compact row of pills in the detail modal showing
// optimal post window, suggested duration, trending sound. Skipped
// entirely when no virality fields are populated.
export function ViralityStrip({ i }: { i: VideoIdeaRow }) {
  const chips: { Icon: LucideIcon; label: string }[] = [];
  if (i.optimal_post_window) {
    chips.push({ Icon: Clock, label: i.optimal_post_window });
  }
  if (i.suggested_duration) {
    chips.push({ Icon: Timer, label: i.suggested_duration });
  }
  if (i.trending_sound) {
    chips.push({
      Icon: Music,
      label:
        i.trending_sound.length > 50
          ? i.trending_sound.slice(0, 50) + "…"
          : i.trending_sound,
    });
  }
  if (chips.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {chips.map((c, idx) => (
        <span
          key={idx}
          className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
        >
          <c.Icon className="h-3 w-3" aria-hidden="true" />
          <span>{c.label}</span>
        </span>
      ))}
    </div>
  );
}

// ViralityRow — labeled icon + label + value row used inside the
// detail modal's "Virality plan" Section for each individual field
// (optimal_post_window, suggested_duration, thumbnail_concept, etc.).
export function ViralityRow({
  Icon,
  label,
  value,
}: {
  Icon: LucideIcon;
  label: string;
  /** Null = render empty-state placeholder rather than skip — keeps
   *  every virality field visible in the editor even before the agent
   *  has populated it. */
  value: string | null | undefined;
}) {
  const display = value && value.trim().length > 0 ? value : null;
  return (
    <div className="flex items-start gap-2">
      <Icon
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-500"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">
          {label}
        </div>
        <div
          className={`text-xs ${display ? "text-neutral-800 dark:text-neutral-200" : "text-neutral-400 italic"}`}
        >
          {display ?? "(empty)"}
        </div>
      </div>
    </div>
  );
}

// SourceRefs — render the agent's freeform source_refs object as a
// chip strip so the user can see *why* the idea was generated (which
// hashtag, which competitor video, what velocity ratio, etc.) and
// click through to the cited tool result.
export function SourceRefs({
  refs,
}: {
  refs: Record<string, unknown> | null;
}) {
  if (!refs || Object.keys(refs).length === 0) return null;
  const items: { label: string; href?: string; text: string }[] = [];
  for (const [key, val] of Object.entries(refs)) {
    if (val == null) continue;
    if (typeof val === "string") {
      const isUrl = val.startsWith("http://") || val.startsWith("https://");
      items.push({
        label: key.replace(/_/g, " "),
        href: isUrl ? val : undefined,
        text: val,
      });
    } else if (Array.isArray(val)) {
      items.push({ label: key.replace(/_/g, " "), text: val.join(", ") });
    }
  }
  if (items.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-neutral-500">
      {items.map((it, idx) => (
        <span key={idx}>
          <span className="opacity-70">{it.label}:</span>{" "}
          {it.href ? (
            <a
              href={it.href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              {it.text.length > 50 ? it.text.slice(0, 50) + "…" : it.text}
            </a>
          ) : (
            <span>{it.text}</span>
          )}
        </span>
      ))}
    </div>
  );
}

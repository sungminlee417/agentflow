"use client";

import { useState } from "react";
import type { VideoIdeaRow } from "../types";

// Caption packaging block — tabbed per-platform copy + clipboard
// button. Used inside the IdeaDetailModal. Adjacent to it live two
// generic helpers (Section + CopyButton) that the modal also reuses
// for non-caption sections.

export type CaptionTab = {
  platform: string; // "tiktok" | "youtube" | "instagram" | "generic"
  label: string;
  title: string | null; // YT-only normally
  body: string | null;
  hashtags: string[];
  // What lands on the clipboard when "Copy caption + tags" is hit —
  // pre-assembled per platform so the user can paste straight in.
  combined: string;
};

export function buildCaptionTabs(idea: VideoIdeaRow): CaptionTab[] {
  const out: CaptionTab[] = [];
  const p = idea.platforms ?? null;
  if (p?.tiktok?.caption) {
    const tags = (p.tiktok.hashtags ?? []).map((h) => `#${h}`).join(" ");
    out.push({
      platform: "tiktok",
      label: "TikTok",
      title: null,
      body: p.tiktok.caption,
      hashtags: p.tiktok.hashtags ?? [],
      combined: [p.tiktok.caption, tags].filter(Boolean).join("\n\n").trim(),
    });
  }
  if (p?.youtube?.title) {
    const tags = (p.youtube.hashtags ?? []).map((h) => `#${h}`).join(" ");
    out.push({
      platform: "youtube",
      label: "YouTube Shorts",
      title: p.youtube.title,
      body: p.youtube.description ?? null,
      hashtags: p.youtube.hashtags ?? [],
      combined: [p.youtube.title, p.youtube.description, tags]
        .filter(Boolean)
        .join("\n\n")
        .trim(),
    });
  }
  if (p?.instagram?.caption) {
    const tags = (p.instagram.hashtags ?? []).map((h) => `#${h}`).join(" ");
    out.push({
      platform: "instagram",
      label: "Instagram Reels",
      title: null,
      body: p.instagram.caption,
      hashtags: p.instagram.hashtags ?? [],
      combined: [p.instagram.caption, tags].filter(Boolean).join("\n\n").trim(),
    });
  }
  // Legacy fallback: ideas generated before the platforms column
  // existed get one generic tab assembled from post_title / description
  // / hashtags so the modal isn't suddenly empty for them.
  if (out.length === 0 && (idea.post_title || idea.description)) {
    const tags = (idea.hashtags ?? []).map((h) => `#${h}`).join(" ");
    const body = [idea.post_title, idea.description]
      .filter((x) => !!x)
      .join("\n\n");
    out.push({
      platform: "generic",
      label: "Caption",
      title: idea.post_title,
      body: idea.description,
      hashtags: idea.hashtags ?? [],
      combined: [body, tags].filter(Boolean).join("\n\n").trim(),
    });
  }
  return out;
}

export function CaptionTabs({ tabs }: { tabs: CaptionTab[] }) {
  const [active, setActive] = useState(0);
  // If the tab set shrinks (e.g. user dismisses + new idea opens), keep
  // active in bounds without forcing a clamp on every render.
  const safeActive = Math.min(active, tabs.length - 1);
  const tab = tabs[safeActive]!;
  const showTabs = tabs.length > 1;
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Caption
          </h3>
          {showTabs && (
            <div className="flex flex-wrap gap-1">
              {tabs.map((t, i) => (
                <button
                  key={t.platform}
                  type="button"
                  onClick={() => setActive(i)}
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition ${
                    i === safeActive
                      ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                      : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <CopyButton text={tab.combined} label="Copy caption + tags" />
      </div>
      <div className="rounded-md bg-neutral-50 px-3 py-3 text-sm text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
        {tab.title && <p className="font-medium">{tab.title}</p>}
        {tab.body && (
          <p
            className={`whitespace-pre-wrap ${tab.title ? "mt-2" : ""}`}
          >
            {tab.body}
          </p>
        )}
        {tab.hashtags.length > 0 && (
          <p className="mt-3 text-blue-700 dark:text-blue-300">
            {tab.hashtags.map((h) => `#${h}`).join(" ")}
          </p>
        )}
      </div>
    </div>
  );
}

// Generic labeled section with an optional Copy button. Reused
// throughout the detail modal for Script / CTA / Visual notes /
// Source evidence etc.
export function Section({
  title,
  children,
  textToCopy,
  copyLabel = "Copy",
  defaultOpen = true,
  collapsible = false,
}: {
  title: string;
  children: React.ReactNode;
  textToCopy?: string;
  copyLabel?: string;
  defaultOpen?: boolean;
  collapsible?: boolean;
}) {
  if (collapsible) {
    return (
      <details open={defaultOpen} className="group">
        <summary className="mb-1.5 flex cursor-pointer list-none items-center justify-between gap-2">
          <h3 className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-neutral-500">
            <span className="transition group-open:rotate-90" aria-hidden="true">
              ▸
            </span>
            {title}
          </h3>
          {textToCopy && <CopyButton text={textToCopy} label={copyLabel} />}
        </summary>
        {children}
      </details>
    );
  }
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          {title}
        </h3>
        {textToCopy && <CopyButton text={textToCopy} label={copyLabel} />}
      </div>
      {children}
    </div>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="rounded-md border border-neutral-300 bg-white px-2 py-0.5 text-[11px] text-neutral-600 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800"
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}

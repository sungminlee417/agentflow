"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

const OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Auto" },
] as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Render a stable shell pre-mount so hydration matches.
  const current = mounted ? (theme ?? "system") : "system";

  return (
    <div className="rounded-md px-3 py-2 text-sm">
      <div className="mb-1 text-xs text-neutral-500">Theme</div>
      <div className="flex gap-1 rounded-md border border-neutral-200 bg-white p-0.5 dark:border-neutral-700 dark:bg-neutral-900">
        {OPTIONS.map((o) => {
          const active = current === o.value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => setTheme(o.value)}
              className={`flex-1 rounded px-2 py-1 text-xs font-medium transition ${
                active
                  ? "bg-neutral-900 text-white dark:bg-white dark:text-black"
                  : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

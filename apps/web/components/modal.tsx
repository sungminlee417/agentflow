"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

// Lightweight modal — fixed-position backdrop + centered card.
// Closes on Esc and on backdrop click.
//
// On phones the modal can grow taller than the viewport (long forms,
// account configuration); the inner card uses `max-h-[calc(100dvh-2rem)]`
// + scrollable body so the close button + header stay reachable.

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  maxWidth = "max-w-2xl",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8">
      <div
        className="fixed inset-0 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-2xl sm:max-h-[calc(100dvh-4rem)] sm:my-4 dark:border-neutral-800 dark:bg-neutral-950 ${maxWidth}`}
      >
        <header className="flex items-start justify-between gap-3 border-b border-neutral-200 px-5 py-4 dark:border-neutral-800">
          <div className="min-w-0">
            <h2 className="text-base font-medium text-neutral-900 dark:text-neutral-100">
              {title}
            </h2>
            {subtitle && (
              <p className="mt-0.5 text-sm text-neutral-500">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

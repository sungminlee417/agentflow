"use client";

import { useCallback, useState } from "react";
import { Modal } from "@/components/modal";

// Replaces browser confirm() with a styled modal that matches the rest
// of the app. Use the useConfirm() hook in any client component:
//
//   const { confirm, dialog } = useConfirm();
//   // ...
//   const ok = await confirm({
//     title: "Disconnect TikTok?",
//     description: "The agent will lose access to this account.",
//     confirmLabel: "Disconnect",
//     tone: "danger",
//   });
//   if (!ok) return;
//   // ... do the destructive thing
//
// Then drop {dialog} somewhere in the component's JSX.

export type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" styles the confirm button red. Default "danger" since
   *  most callers are destructive operations. */
  tone?: "danger" | "default";
};

export function useConfirm() {
  const [state, setState] = useState<
    | (ConfirmOptions & {
        resolve: (ok: boolean) => void;
      })
    | null
  >(null);

  const confirm = useCallback(
    (opts: ConfirmOptions): Promise<boolean> =>
      new Promise((resolve) => setState({ ...opts, resolve })),
    [],
  );

  const close = useCallback(
    (ok: boolean) => {
      if (state) state.resolve(ok);
      setState(null);
    },
    [state],
  );

  const tone = state?.tone ?? "danger";

  const dialog = (
    <Modal
      open={!!state}
      onClose={() => close(false)}
      title={state?.title ?? ""}
      maxWidth="max-w-sm"
    >
      {state?.description && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {state.description}
        </p>
      )}
      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => close(false)}
          className="rounded-md px-3 py-1.5 text-sm text-neutral-700 transition hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          {state?.cancelLabel ?? "Cancel"}
        </button>
        <button
          type="button"
          onClick={() => close(true)}
          autoFocus
          className={`rounded-md px-3 py-1.5 text-sm font-medium text-white transition focus-visible:outline-2 focus-visible:outline-offset-2 ${
            tone === "danger"
              ? "bg-red-600 hover:bg-red-700 focus-visible:outline-red-500"
              : "bg-neutral-900 hover:bg-neutral-700 focus-visible:outline-neutral-500 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
          }`}
        >
          {state?.confirmLabel ?? "Confirm"}
        </button>
      </div>
    </Modal>
  );

  return { confirm, dialog };
}

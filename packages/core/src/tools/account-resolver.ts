// Multi-account routing for provider tools (YouTube / TikTok / Instagram).
//
// Each provider tool is built once per chat request with the FULL list
// of connected accounts (not just the oldest one). Every tool's input
// schema has an optional `account` parameter; at execute time we use
// `resolveAccount` below to pick the right credentials. If only one
// account is connected, `account` is optional and defaults to it; if
// multiple are connected, the caller must specify one or we throw a
// helpful error pointing at the `<provider>_list_my_accounts` tool.
//
// The `getToken` thunk is lazy + memoized so multiple tool calls in
// the same request don't all pay for a fresh OAuth refresh.

export type ProviderAccount = {
  /** integrations.id — stable id for this connection. */
  id: string;
  /** User-facing label (account_label ?? display_name ?? handle ?? id). */
  label: string;
  /** Provider handle if available (e.g. "@sungminlee"). */
  handle: string | null;
  /** Lazily-refreshed OAuth access token. Memoized for the request. */
  getToken: () => Promise<string>;
};

export function resolveAccount(
  accounts: ProviderAccount[],
  input: string | undefined,
  provider: string,
): ProviderAccount {
  if (accounts.length === 0) {
    throw new Error(
      `No ${provider} accounts connected. Connect one in Settings → Integrations first.`,
    );
  }
  if (!input) {
    if (accounts.length === 1) return accounts[0]!;
    throw new Error(
      `Multiple ${provider} accounts connected (${accounts
        .map((a) => a.label)
        .join(", ")}). Specify which one via the "account" parameter. ` +
        `Call ${provider}_list_my_accounts first if you're unsure of the options.`,
    );
  }
  const lc = input.trim().toLowerCase();
  // Exact label match first.
  const byLabel = accounts.find((a) => a.label.toLowerCase() === lc);
  if (byLabel) return byLabel;
  // Then handle (with or without leading @).
  const stripped = lc.replace(/^@/, "");
  const byHandle = accounts.find(
    (a) => a.handle && a.handle.toLowerCase().replace(/^@/, "") === stripped,
  );
  if (byHandle) return byHandle;
  // Then id (full match).
  const byId = accounts.find((a) => a.id === input);
  if (byId) return byId;
  // Then unique partial label match.
  const partial = accounts.filter((a) => a.label.toLowerCase().includes(lc));
  if (partial.length === 1) return partial[0]!;
  throw new Error(
    `No ${provider} account matched "${input}". Available: ${accounts
      .map((a) => a.label)
      .join(", ")}.`,
  );
}

/** Public listing payload returned by `<provider>_list_my_accounts`. */
export function describeAccounts(
  accounts: ProviderAccount[],
): Array<{ id: string; label: string; handle: string | null }> {
  return accounts.map((a) => ({ id: a.id, label: a.label, handle: a.handle }));
}

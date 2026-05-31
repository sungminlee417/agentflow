import { tool } from "ai";
import { z } from "zod";

// Minimal GitHub REST client. Uses fetch directly so we don't pull in
// Octokit just for a handful of endpoints.

async function gh(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agentflow",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub ${res.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function ghGraphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "agentflow",
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub GraphQL ${res.status}: ${text.slice(0, 500)}`);
  }
  const body = JSON.parse(text) as { data?: T; errors?: unknown[] };
  if (body.errors && body.errors.length > 0) {
    throw new Error(
      `GitHub GraphQL: ${JSON.stringify(body.errors).slice(0, 500)}`,
    );
  }
  if (!body.data) {
    throw new Error("GitHub GraphQL: empty response");
  }
  return body.data;
}

type GhContent = {
  type: "file" | "dir" | string;
  encoding?: string;
  content?: string;
  sha: string;
  path: string;
};

type GhRef = { object: { sha: string } };
type GhPr = { html_url: string; number: number };

export function buildGitHubTools(token: string) {
  return {
    github_list_repos: tool({
      description:
        "List the authenticated user's GitHub repositories. Useful for discovering what's available before reading or modifying code.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(20),
        sort: z
          .enum(["updated", "created", "pushed", "full_name"])
          .default("updated"),
      }),
      execute: async ({ limit, sort }) => {
        const repos = (await gh(
          token,
          `/user/repos?per_page=${limit}&sort=${sort}`,
        )) as Array<{
          name: string;
          full_name: string;
          description: string | null;
          language: string | null;
          updated_at: string;
          private: boolean;
          default_branch: string;
        }>;
        return repos.map((r) => ({
          name: r.name,
          full_name: r.full_name,
          description: r.description,
          language: r.language,
          updated_at: r.updated_at,
          private: r.private,
          default_branch: r.default_branch,
        }));
      },
    }),

    github_get_file: tool({
      description:
        "Read a single file from a GitHub repo. Returns the decoded text content. Use this to inspect existing code before proposing changes.",
      inputSchema: z.object({
        repo: z
          .string()
          .describe('Repo in "owner/name" form, e.g. "sungminlee417/agentflow"'),
        path: z.string().describe("Path from repo root, e.g. \"README.md\""),
        ref: z
          .string()
          .optional()
          .describe("Branch, tag, or commit SHA. Defaults to default branch."),
      }),
      execute: async ({ repo, path, ref }) => {
        const refParam = ref ? `?ref=${encodeURIComponent(ref)}` : "";
        const data = (await gh(
          token,
          `/repos/${repo}/contents/${path}${refParam}`,
        )) as GhContent | GhContent[];
        if (Array.isArray(data)) {
          throw new Error(`Path "${path}" is a directory, not a file.`);
        }
        if (data.encoding !== "base64" || !data.content) {
          throw new Error(`Unexpected file encoding: ${data.encoding}`);
        }
        return {
          path: data.path,
          sha: data.sha,
          content: Buffer.from(data.content, "base64").toString("utf8"),
        };
      },
    }),

    github_list_directory: tool({
      description:
        "List the contents of a directory in a GitHub repo. Use this to explore a repo before reading specific files.",
      inputSchema: z.object({
        repo: z.string().describe('Repo in "owner/name" form'),
        path: z
          .string()
          .default("")
          .describe("Directory path from repo root. Empty for repo root."),
        ref: z.string().optional(),
      }),
      execute: async ({ repo, path, ref }) => {
        const refParam = ref ? `?ref=${encodeURIComponent(ref)}` : "";
        const data = (await gh(
          token,
          `/repos/${repo}/contents/${path}${refParam}`,
        )) as GhContent | GhContent[];
        if (!Array.isArray(data)) {
          throw new Error(`Path "${path}" is a file, not a directory.`);
        }
        return data.map((d) => ({ name: d.path.split("/").pop(), path: d.path, type: d.type }));
      },
    }),

    github_create_pr: tool({
      description:
        "Create a pull request with file changes. Creates a new branch off `base`, writes the given files (create or update), and opens a PR. Returns the PR URL.",
      inputSchema: z.object({
        repo: z.string().describe('Repo in "owner/name" form'),
        base: z
          .string()
          .default("main")
          .describe("Branch to merge into (target branch)"),
        branch: z
          .string()
          .describe(
            "New branch name to create for these changes, e.g. \"agent/add-dark-mode\"",
          ),
        title: z.string().describe("PR title"),
        body: z.string().describe("PR description (markdown)"),
        files: z
          .array(
            z.object({
              path: z.string().describe("File path from repo root"),
              content: z
                .string()
                .describe("Full new content of the file (utf-8 text)"),
            }),
          )
          .min(1)
          .describe("Files to create or replace in the new branch"),
      }),
      execute: async ({ repo, base, branch, title, body, files }) => {
        // 1. Resolve base branch SHA.
        const baseRef = (await gh(
          token,
          `/repos/${repo}/git/refs/heads/${base}`,
        )) as GhRef;
        const baseSha = baseRef.object.sha;

        // 2. Create the new branch.
        await gh(token, `/repos/${repo}/git/refs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
        });

        // 3. Write each file via the contents API (creates a commit per file).
        for (const file of files) {
          let existingSha: string | undefined;
          try {
            const existing = (await gh(
              token,
              `/repos/${repo}/contents/${file.path}?ref=${branch}`,
            )) as GhContent | GhContent[];
            if (!Array.isArray(existing)) existingSha = existing.sha;
          } catch {
            // File doesn't exist yet — that's fine, it'll be created.
          }

          await gh(token, `/repos/${repo}/contents/${file.path}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: `Update ${file.path}`,
              content: Buffer.from(file.content, "utf8").toString("base64"),
              branch,
              ...(existingSha ? { sha: existingSha } : {}),
            }),
          });
        }

        // 4. Open the PR.
        const pr = (await gh(token, `/repos/${repo}/pulls`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, body, head: branch, base }),
        })) as GhPr;

        return { url: pr.html_url, number: pr.number };
      },
    }),

    github_list_issues: tool({
      description:
        "List issues on a repo. By default returns OPEN issues, excluding pull requests. Use to discover work to do.",
      inputSchema: z.object({
        repo: z.string().describe('Repo in "owner/name" form'),
        state: z.enum(["open", "closed", "all"]).default("open"),
        labels: z
          .string()
          .optional()
          .describe("Comma-separated list of label names to filter by"),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ repo, state, labels, limit }) => {
        const params = new URLSearchParams({
          state,
          per_page: String(limit),
          sort: "updated",
        });
        if (labels) params.set("labels", labels);
        const items = (await gh(
          token,
          `/repos/${repo}/issues?${params.toString()}`,
        )) as Array<{
          number: number;
          title: string;
          state: string;
          body: string | null;
          html_url: string;
          user: { login: string } | null;
          labels: Array<{ name: string }>;
          created_at: string;
          updated_at: string;
          comments: number;
          pull_request?: unknown;
        }>;
        return items
          .filter((i) => !i.pull_request) // /issues includes PRs; drop them
          .map((i) => ({
            number: i.number,
            title: i.title,
            state: i.state,
            url: i.html_url,
            author: i.user?.login ?? null,
            labels: i.labels.map((l) => l.name),
            comments: i.comments,
            updated_at: i.updated_at,
            body_preview: i.body ? i.body.slice(0, 280) : null,
          }));
      },
    }),

    github_get_issue: tool({
      description:
        "Read a single issue including its full body and all comments. Use before acting on an issue to understand the full context.",
      inputSchema: z.object({
        repo: z.string().describe('Repo in "owner/name" form'),
        number: z.number().int().describe("Issue number"),
      }),
      execute: async ({ repo, number }) => {
        const [issue, comments] = (await Promise.all([
          gh(token, `/repos/${repo}/issues/${number}`),
          gh(token, `/repos/${repo}/issues/${number}/comments?per_page=100`),
        ])) as [
          {
            number: number;
            title: string;
            body: string | null;
            state: string;
            html_url: string;
            user: { login: string } | null;
            labels: Array<{ name: string }>;
            created_at: string;
            updated_at: string;
            pull_request?: unknown;
          },
          Array<{
            user: { login: string } | null;
            body: string | null;
            created_at: string;
          }>,
        ];
        if (issue.pull_request) {
          throw new Error(`#${number} is a pull request, not an issue.`);
        }
        return {
          number: issue.number,
          title: issue.title,
          body: issue.body ?? "",
          state: issue.state,
          url: issue.html_url,
          author: issue.user?.login ?? null,
          labels: issue.labels.map((l) => l.name),
          created_at: issue.created_at,
          updated_at: issue.updated_at,
          comments: comments.map((c) => ({
            author: c.user?.login ?? null,
            body: c.body ?? "",
            created_at: c.created_at,
          })),
        };
      },
    }),

    github_post_issue_comment: tool({
      description:
        "Post a comment on a GitHub issue. Use to acknowledge an issue you're working on, or to link a PR you just opened.",
      inputSchema: z.object({
        repo: z.string().describe('Repo in "owner/name" form'),
        number: z.number().int().describe("Issue number"),
        body: z.string().describe("Markdown body of the comment"),
      }),
      execute: async ({ repo, number, body }) => {
        const data = (await gh(
          token,
          `/repos/${repo}/issues/${number}/comments`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body }),
          },
        )) as { id: number; html_url: string };
        return { id: data.id, url: data.html_url };
      },
    }),

    github_project_set_issue_status: tool({
      description:
        "Move an issue across its GitHub Projects (V2) board by changing its Status column. Looks up every project board the issue belongs to, finds the Status field, and sets the option whose name matches `status` (case-insensitive). Use names like 'In Progress' / 'In Review' / 'Done'. If the option doesn't exist on a board, the tool returns the available option names so you can retry with a valid one.",
      inputSchema: z.object({
        repo: z.string().describe('Repo in "owner/name" form'),
        issue_number: z.number().int(),
        status: z
          .string()
          .describe(
            "Status column name (e.g. 'In Progress'). Matched case-insensitively against the board's Status options.",
          ),
      }),
      execute: async ({ repo, issue_number, status }) => {
        const [owner, name] = repo.split("/");
        if (!owner || !name) {
          throw new Error('repo must be "owner/name"');
        }

        type StatusField = {
          id: string;
          name: string;
          options: Array<{ id: string; name: string }>;
        };
        type ProjectItem = {
          id: string;
          project: {
            id: string;
            title: string;
            fields: { nodes: Array<StatusField | null> };
          };
        };
        const data = await ghGraphql<{
          repository: {
            issue: { projectItems: { nodes: ProjectItem[] } } | null;
          } | null;
        }>(
          token,
          `query($owner: String!, $name: String!, $number: Int!) {
            repository(owner: $owner, name: $name) {
              issue(number: $number) {
                projectItems(first: 10) {
                  nodes {
                    id
                    project {
                      id
                      title
                      fields(first: 30) {
                        nodes {
                          ... on ProjectV2SingleSelectField {
                            id
                            name
                            options {
                              id
                              name
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }`,
          { owner, name, number: issue_number },
        );

        const items = data.repository?.issue?.projectItems?.nodes ?? [];
        if (items.length === 0) {
          return {
            updated: [],
            message: `Issue #${issue_number} is not on any project board.`,
          };
        }

        const results: Array<{
          project: string;
          status?: string;
          skipped?: string;
        }> = [];

        for (const item of items) {
          const statusField = item.project.fields.nodes.find(
            (f): f is StatusField =>
              !!f && f.name === "Status" && Array.isArray(f.options),
          );
          if (!statusField) {
            results.push({
              project: item.project.title,
              skipped: "no Status field on this board",
            });
            continue;
          }
          const want = status.toLowerCase();
          const option = statusField.options.find(
            (o) => o.name.toLowerCase() === want,
          );
          if (!option) {
            results.push({
              project: item.project.title,
              skipped: `no Status option matching "${status}". Available: ${statusField.options.map((o) => o.name).join(", ")}`,
            });
            continue;
          }

          await ghGraphql(
            token,
            `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
              updateProjectV2ItemFieldValue(input: {
                projectId: $projectId,
                itemId: $itemId,
                fieldId: $fieldId,
                value: { singleSelectOptionId: $optionId }
              }) { projectV2Item { id } }
            }`,
            {
              projectId: item.project.id,
              itemId: item.id,
              fieldId: statusField.id,
              optionId: option.id,
            },
          );
          results.push({ project: item.project.title, status: option.name });
        }

        return { updated: results };
      },
    }),
  };
}

export type GitHubTools = ReturnType<typeof buildGitHubTools>;

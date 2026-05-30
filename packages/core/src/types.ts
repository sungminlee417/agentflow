export type DomainSlug = "youtube" | "coachflow";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  user_id: string;
  domain: DomainSlug;
  kind: string;
  status: JobStatus;
  input_json: Record<string, unknown>;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  total_tokens: number | null;
  cost_usd: number | null;
  created_at: string;
}

export interface JobEvent {
  id: string;
  job_id: string;
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

export interface Artifact {
  id: string;
  job_id: string;
  kind: string;
  content_json: Record<string, unknown> | null;
  content_md: string | null;
  created_at: string;
}

export interface Integration {
  id: string;
  user_id: string;
  domain: DomainSlug;
  provider: string;
  access_token: string;
  refresh_token: string | null;
  scopes: string[];
  expires_at: string | null;
}

export interface Schedule {
  id: string;
  user_id: string;
  domain: DomainSlug;
  job_kind: string;
  input_json: Record<string, unknown>;
  cron_expression: string;
  next_run_at: string;
  active: boolean;
}

export interface JobKindSpec {
  kind: string;
  label: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface AgentContext {
  job: Job;
  integration: Integration | null;
  log: (level: JobEvent["level"], message: string) => Promise<void>;
}

export interface AgentTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface AgentResult {
  artifacts: Array<Omit<Artifact, "id" | "job_id" | "created_at">>;
  total_tokens?: number;
  cost_usd?: number;
}

export interface DomainPlugin {
  slug: DomainSlug;
  displayName: string;
  jobKinds: JobKindSpec[];
  buildTools(ctx: AgentContext): AgentTool[];
  buildSystemPrompt(kind: string, input: Record<string, unknown>): string;
  buildUserPrompt(kind: string, input: Record<string, unknown>): string;
}

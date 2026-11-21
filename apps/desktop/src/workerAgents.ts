export const WORKER_AGENTS = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
  { id: "ucode", label: "Ucode" },
] as const;

export type WorkerAgent = (typeof WORKER_AGENTS)[number]["id"];
export const DEFAULT_WORKER_AGENT: WorkerAgent = "ucode";

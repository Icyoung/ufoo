export type WindowMode = "main" | "side" | "multi";

export type RightInspectorTab = "changes" | "docs" | "context";

export interface WorkerSummary {
  id: string;
  label: string;
  type: string;
  internal: boolean;
  external: boolean;
  activity_state: string;
  activity_detail: string;
  group_id?: string;
  group_member_id?: string;
  group_template_alias?: string;
  host_name?: string;
  launch_mode?: string;
}

export interface RecoverableItem {
  id: string;
  label?: string;
  desc: string;
}

export interface ProjectTreeNode {
  id: string;
  label: string;
  root: string;
  branch: string;
  status: string;
  active: boolean;
  selectedAsMain: boolean;
  selectedWorkerId: string;
  mainBusy: boolean;
  waitingUser: boolean;
  conversationId: string;
  workers: WorkerSummary[];
  recoverable: RecoverableItem[];
}

export interface StageTarget {
  kind: "project_main" | "worker_single";
  agentId: string;
}

export interface TranscriptEntry {
  id: string;
  kind: string;
  text: string;
  speaker?: string;
  detail?: string;
  expanded?: boolean;
  streaming?: boolean;
  ts?: string;
}

export interface PendingInteraction {
  id: string;
  prompt: string;
  options?: Array<{ key: string; label: string; description?: string }>;
  sessionId?: string;
  taskRunId?: string;
}

export interface MultiPaneFrame {
  session_id: string | null;
  agent_id: string;
  label: string;
  mode: string;
  entries: TranscriptEntry[];
  status: string;
  busy: boolean;
  usage?: string;
  plan?: string[];
  revision?: number;
  activity_detail?: string;
  input: string;
  input_revision: number;
}

export interface WorkerReportItem {
  entry_id: string;
  ts: string;
  phase: "start" | "progress" | "done" | "error";
  task_id: string;
  agent_id: string;
  message?: string;
  summary?: string;
  error?: string;
  ok?: boolean;
}

export interface WorkerViewFrame {
  project_root: string;
  agent_id: string;
  label: string;
  type: string;
  internal: boolean;
  external: boolean;
  entries: TranscriptEntry[];
  reports?: WorkerReportItem[];
  status: string;
  busy: boolean;
  usage: string;
  plan: string[];
  activity_detail: string;
  group_id?: string;
  group_template_alias?: string;
  host_name?: string;
  launch_mode?: string;
  worktree_root?: string;
  input: string;
  input_revision: number;
}

export interface ChangedFileItem {
  path: string;
  origPath?: string;
  kind: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
  code: string;
  staged: boolean;
  unstaged: boolean;
  additions: number;
  deletions: number;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
}

export interface WorkspaceChangesSnapshot {
  projectRoot: string;
  worktreeRoot: string;
  isGitRepo: boolean;
  branch: string;
  worktrees: WorktreeInfo[];
  files: ChangedFileItem[];
  totals: { additions: number; deletions: number };
  selectedFile: string;
  diff: string;
  reports: WorkerReportItem[];
}

export interface DocFileItem {
  path: string;
  name: string;
  isMarkdown: boolean;
  pinned: boolean;
}

export interface WorkspaceDocsSnapshot {
  projectRoot: string;
  files: DocFileItem[];
  selectedPath: string;
  document: {
    path: string;
    absolutePath?: string;
    language?: string;
    content?: string;
    totalLines?: number;
    startLine?: number;
    endLine?: number;
    anchorLine?: number;
    truncated?: boolean;
    error?: string;
  } | null;
}

export interface DecisionItem {
  file: string;
  status: string;
  title: string;
  author: string;
  date: string;
  body: string;
}

export interface MemoryItem {
  id: string;
  title: string;
  body: string;
  tags: string[];
  status: string;
  updated_at: string;
}

export interface WorkspaceContextSnapshot {
  projectRoot: string;
  decisions: DecisionItem[];
  openDecisionCount: number;
  memories: MemoryItem[];
}

export interface CompletionItem {
  value?: string;
  cmd?: string;
  label?: string;
  desc?: string;
}

export interface SettingsSnapshot {
  agent_provider?: string;
  agent_model?: string;
  agent_thinking?: string;
  agent_base_url?: string;
  custom_base_url?: string;
  provider_options?: Array<{ value: string; label: string }>;
}

export interface UiEnvelope {
  protocol: string;
  kind: "hello" | "welcome" | "command" | "event" | "snapshot" | "result" | "error";
  name: string;
  request_id?: string;
  seq?: number;
  scope?: {
    surface: string;
    project_id: string;
    view_id: string;
  };
  payload: Record<string, any>;
}

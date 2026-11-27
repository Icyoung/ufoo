export type WindowMode = "main" | "side" | "multi";

export type RightInspectorTab = "changes" | "docs" | "context";

export type WorktreePolicy = "auto" | "always" | "never";

export type PermissionMode = "supervised" | "auto_edit" | "full_access";

export type DiffViewMode = "unified" | "split";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "offline";

export type BridgeTransportMode = "tauri" | "remote-p2p" | "remote-relay" | "preview" | "unpaired";

export type MobileTab = "inbox" | "chat" | "changes";

export type SettingsTabId = "general" | "models" | "engines" | "safety" | "remote" | "cli";

export type RemotePairingState = "idle" | "pairing" | "connecting" | "connected" | "error";

export interface RemoteActiveClientInfo {
  client_id: string;
  label: string;
  transport: "p2p" | "relay" | string;
  connected_at: string;
}

export interface RemoteStatusSnapshot {
  ok: boolean;
  enabled: boolean;
  connected: boolean;
  state: "disabled" | "connecting" | "connected" | "reconnecting" | "error" | string;
  relay_url: string;
  web_base_url: string;
  remote_url?: string;
  has_auth_token: boolean;
  allow_insecure_ws: boolean;
  device_id: string;
  device_name: string;
  fingerprint: string;
  paired_count: number;
  active_clients: RemoteActiveClientInfo[];
  last_error: string;
  error?: string;
}

export interface RemotePairTicket {
  ok: boolean;
  pair_id: string;
  pair_code: string;
  device_id: string;
  device_name: string;
  relay_url: string;
  remote_url?: string;
  deep_url: string;
  qr_svg: string;
  qr_data_url: string;
  expires_at: string;
  fingerprint: string;
  error?: string;
}

export interface RemotePairedDevice {
  client_id: string;
  label: string;
  fingerprint: string;
  paired_at: string;
  last_seen: string;
  revoked_at: string | null;
  connected: boolean;
  transport: "p2p" | "relay" | null | string;
}

export interface RemoteSessionInfo {
  relayUrl: string;
  deviceId: string;
  deviceName: string;
  hostFingerprint: string;
  clientId: string;
  clientLabel: string;
  clientFingerprint: string;
  pairedAt: string;
}

export interface DaemonServiceStatus {
  ok: boolean;
  supported: boolean;
  daemon_running: boolean;
  daemon_pid: number | null;
  daemon_state: string;
  daemon_connected: boolean;
  error?: string;
  launchd: {
    supported: boolean;
    label: string;
    plistPath: string;
    logPath?: string;
    installed: boolean;
    loaded: boolean;
    running: boolean;
    pid: number | null;
    state: string;
  };
}

export interface EngineCatalogItem {
  id: string;
  agentType: string;
  label: string;
  kind: "sdk" | "native" | "acp";
  available: boolean;
  command?: string;
  description?: string;
}

export interface OnboardingEngineStatus {
  id: string;
  workerId?: string;
  acpId?: string;
  label: string;
  kind: "sdk" | "native" | "acp";
  command?: string;
  installed: boolean;
  authenticated: boolean;
  status: "ready" | "needs_auth" | "not_installed";
  detail: string;
  loginCommand?: string;
  installHint?: string;
}

export interface OnboardingProbeState {
  completed: boolean;
  skipped: boolean;
  should_show: boolean;
  recommended_provider: string;
  current_provider: string;
  primary_engines: OnboardingEngineStatus[];
  acp_engines: OnboardingEngineStatus[];
  cli: {
    installed: boolean;
    bin_dir: string;
    binaries: string[];
  };
  mcp: {
    codex_configured: boolean;
    codex_needs_update: boolean;
    codex_target: string;
  };
  browser: {
    state: string;
    enabled: boolean;
    runtimeInstalled: boolean;
    setupChoice?: string;
  };
}

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
  worktree_root?: string;
  worktree_branch?: string;
  model?: string;
  thinking_level?: string;
  permission_mode?: PermissionMode | string;
  pinned?: boolean;
  pinned_at?: string;
}

export interface RecoverableItem {
  id: string;
  label?: string;
  type?: string;
  desc: string;
}

export interface ArchivedSessionItem {
  id: string;
  label: string;
  type: string;
  archived_at?: string;
  worktree_branch?: string;
  recoverable?: boolean;
  active?: boolean;
  internal?: boolean;
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
  archived?: ArchivedSessionItem[];
}

export interface StageTarget {
  kind: "project_main" | "worker_single";
  agentId: string;
}

export interface SessionChangedFile {
  path: string;
  open_path?: string;
  kind: "added" | "modified" | "deleted" | string;
  additions?: number;
  deletions?: number;
}

export interface TranscriptEntry {
  id: string;
  kind: string;
  text: string;
  speaker?: string;
  sender_id?: string;
  sender_label?: string;
  sender_type?: string;
  sender_kind?: "user" | "peer" | "coordinator" | string;
  detail?: string;
  expanded?: boolean;
  streaming?: boolean;
  ts?: string;
  turn_id?: string;
  tool_name?: string;
  tool_status?: "running" | "done" | "error";
  duration_ms?: number;
  changed_files?: SessionChangedFile[];
}

export interface PendingInteraction {
  id: string;
  kind?: "approval" | "choice" | "chat" | "settings" | string;
  prompt: string;
  options?: Array<{ key: string; label: string; description?: string }>;
  allowFreeChat?: boolean;
  sessionId?: string;
  taskRunId?: string;
  createdAt?: string;
  queue_count?: number;
  projectRoot?: string;
  agentId?: string;
  toolName?: string;
  riskLevel?: "high" | "medium" | "low" | string;
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
  changed_files?: SessionChangedFile[];
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
  changed_files?: SessionChangedFile[];
  activity_detail: string;
  group_id?: string;
  group_template_alias?: string;
  host_name?: string;
  launch_mode?: string;
  worktree_root?: string;
  model?: string;
  thinking_level?: string;
  permission_mode?: PermissionMode | string;
  input: string;
  input_revision: number;
}

export interface WorkerModelCatalogResponse {
  ok: boolean;
  agent_id: string;
  provider: string;
  models: string[];
  default_model: string;
  current_model: string;
  current_thinking: string;
  thinking_levels: string[];
  allow_custom?: boolean;
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

export interface WorkflowGroupSummary {
  group_id: string;
  name: string;
  template_alias: string;
  origin: "template" | "adhoc";
  status: string;
  readonly: boolean;
  member_ids: string[];
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  kind: string;
  group_id: string;
  origin: "template" | "adhoc";
  readonly: boolean;
  auto_forward: boolean;
}

export interface WorkflowNodeGeometry {
  x: number;
  y: number;
  w?: number;
  h?: number;
}

export interface WorkflowSnapshot {
  project_root: string;
  groups: WorkflowGroupSummary[];
  edges: WorkflowEdge[];
  positions: Record<string, WorkflowNodeGeometry>;
}

export interface WorkflowPulse {
  id: string;
  from: string;
  to: string;
  edge_id?: string;
  group_id?: string;
  preview?: string;
  ts: number;
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
  resolution_note?: string;
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
  archivedDecisionCount?: number;
  resolvedDecisionCount?: number;
  memories: MemoryItem[];
}

export interface CompletionItem {
  kind?: "command" | "subcommand" | "argument" | "agent" | string;
  value?: string;
  cmd?: string;
  label?: string;
  replace?: string;
  desc?: string;
  description?: string;
  hasChildren?: boolean;
  optionalArguments?: boolean;
}

export interface ComposerAttachment {
  id: string;
  name: string;
  path: string;
  kind: "image" | "file";
  media_type: string;
  bytes: number;
  preview_data_url?: string;
}

export interface SettingsSnapshot {
  agent_provider?: string;
  agent_model?: string;
  agent_thinking?: string;
  agent_base_url?: string;
  custom_base_url?: string;
  worktree_policy?: WorktreePolicy;
  permission_mode?: PermissionMode;
  acp_agents?: Array<{ id: string; label?: string; command: string; args?: string[] }>;
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

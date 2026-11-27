import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowsClockwise,
  CaretDown,
  Check,
  Copy,
  DeviceMobile,
  Link,
  Plus,
  QrCode,
  ShieldCheck,
  SignOut,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useWorkspace } from "../store/workspaceStore";
import { ufooBridge } from "../bridge/ufooClient";
import { WORKER_AGENTS, type WorkerAgent } from "../workerAgents";
import type {
  DaemonServiceStatus,
  OnboardingProbeState,
  PermissionMode,
  RemotePairedDevice,
  RemotePairTicket,
  RemoteStatusSnapshot,
  SettingsTabId,
  WindowMode,
} from "../types";
import { BrandIcon } from "./BrandIcon";

const MANUAL_MODEL = "<manual>";
const PROVIDERS = [
  { value: "codex-cli", label: "Codex (OpenAI)" },
  { value: "claude-cli", label: "Claude (Anthropic)" },
  { value: "agy-cli", label: "Antigravity (agy)" },
  { value: "kimi-cli", label: "Kimi Code" },
  { value: "grok-cli", label: "Grok" },
  { value: "custom", label: "Custom OpenAI-Compatible Gateway" },
];
const WINDOW_LAYOUTS: ReadonlyArray<{ id: WindowMode; label: string }> = [
  { id: "main", label: "Main" },
  { id: "side", label: "Side" },
  { id: "multi", label: "Multi" },
];
const REASONING_EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];
const PERMISSION_MODES: ReadonlyArray<{ id: PermissionMode; label: string }> = [
  { id: "supervised", label: "Supervised" },
  { id: "auto_edit", label: "Auto-Edit" },
  { id: "full_access", label: "Full Access" },
];

const NAV_TABS: ReadonlyArray<{
  id: SettingsTabId;
  label: string;
  title: string;
  subtitle: string;
}> = [
  {
    id: "general",
    label: "General",
    title: "General & Layout",
    subtitle: "Default window layout, worker agent, and keyboard shortcuts.",
  },
  {
    id: "models",
    label: "Models",
    title: "Models & Provider",
    subtitle: "Shared across GUI and CLI daemon.",
  },
  {
    id: "engines",
    label: "Engines & ACP",
    title: "Worker Engines & ACP",
    subtitle: "Authentication status, built-in SDKs, and ACP agent extensions.",
  },
  {
    id: "safety",
    label: "Git & Safety",
    title: "Worktree & Permissions",
    subtitle: "Branch isolation policy and command confirmation tier.",
  },
  {
    id: "remote",
    label: "Remote Access",
    title: "Remote Access & Mobile",
    subtitle: "Zero-Knowledge E2EE pairing for mobile PWA and remote web clients.",
  },
  {
    id: "cli",
    label: "CLI & Daemon",
    title: "CLI, Daemon & ACP Server",
    subtitle: "Background daemon supervisor, local PATH shims, and external ACP server.",
  },
];

function formatShortTimestamp(iso?: string | null): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return String(iso);
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return "Expired";
  const totalSec = Math.ceil(msRemaining / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

type ModelCatalog = { ok: boolean; models: string[]; default_model?: string };
type CustomAcpEntry = { id: string; label?: string; command: string; args?: string[] };

function SegmentedSetting<Value extends string>({
  label,
  description,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  value: Value;
  options: ReadonlyArray<{ id: Value; label: string }>;
  onChange: (value: Value) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="space-y-1.5">
      <legend className="text-[12px] font-medium text-zinc-200">{label}</legend>
      <div className="grid grid-cols-3 gap-1 rounded-xl border border-white/[0.08] bg-zinc-900 p-1">
        {options.map(({ id, label: optLabel }) => (
          <button
            key={id}
            type="button"
            aria-pressed={value === id}
            onClick={() => onChange(id)}
            className="rounded-lg py-1.5 text-[12px] text-zinc-400 hover:text-zinc-200 aria-pressed:bg-white/[0.13] aria-pressed:text-white disabled:opacity-50 disabled:cursor-default transition-colors cursor-pointer"
          >
            {optLabel}
          </button>
        ))}
      </div>
      {description && <p className="text-[11.5px] leading-relaxed text-zinc-500">{description}</p>}
    </fieldset>
  );
}

function SettingsModelSelect({
  value,
  manualModel,
  provider,
  defaultModel,
  modelOptions,
  onSelect,
}: {
  value: string;
  manualModel: boolean;
  provider: string;
  defaultModel?: string;
  modelOptions: string[];
  onSelect: (selected: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedOptionRef = useRef<HTMLButtonElement | null>(null);

  const defaultLabel =
    provider === "custom"
      ? "Select a model"
      : defaultModel
      ? `Provider default (${defaultModel})`
      : "Provider default";

  const displayLabel = manualModel
    ? "Enter model ID…"
    : value
    ? value
    : defaultLabel;

  useLayoutEffect(() => {
    if (!open) return;
    const positionMenu = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom - 16;
      const spaceAbove = rect.top - 16;
      const openUpward = spaceBelow < 240 && spaceAbove > spaceBelow;
      setMenuStyle({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)),
        width: rect.width,
        ...(openUpward
          ? { bottom: Math.max(8, window.innerHeight - rect.top + 6) }
          : { top: rect.bottom + 6 }),
      });
    };
    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const listEl = listRef.current;
    const itemEl = selectedOptionRef.current;
    if (!listEl || !itemEl) return;
    const listRect = listEl.getBoundingClientRect();
    const itemRect = itemEl.getBoundingClientRect();
    const offsetInList = itemRect.top - listRect.top + listEl.scrollTop;
    listEl.scrollTop = Math.max(0, offsetInList - (listEl.clientHeight - itemEl.clientHeight) / 2);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setFilter("");
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const query = filter.trim().toLowerCase();
  const filteredModels = query
    ? modelOptions.filter((id) => id.toLowerCase().includes(query))
    : modelOptions;

  const choose = (nextVal: string) => {
    onSelect(nextVal);
    setOpen(false);
  };

  return (
    <>
      <button
        id="agent-model"
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex min-h-[40px] w-full items-center justify-between gap-2 rounded-xl border bg-zinc-900 px-3 py-2 text-left text-[13px] transition-colors cursor-pointer ${
          open
            ? "border-blue-500/50 text-white"
            : "border-white/[0.09] text-zinc-100 hover:border-white/[0.18]"
        }`}
      >
        <span className={`truncate ${value && !manualModel ? "font-mono text-[12.5px]" : ""}`}>
          {displayLabel}
        </span>
        <CaretDown
          size={13}
          className={`shrink-0 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-labelledby="agent-model"
            style={menuStyle}
            className="fixed z-[70] overflow-hidden rounded-xl border border-white/[0.12] bg-[#16161a] p-1.5 shadow-[0_18px_42px_rgba(0,0,0,0.62)]"
          >
            {modelOptions.length > 8 && (
              <div className="mb-1.5 px-0.5">
                <input
                  type="text"
                  autoFocus
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter models…"
                  className="w-full rounded-lg border border-white/[0.09] bg-zinc-950 px-2.5 py-1.5 font-mono text-[12px] text-zinc-100 placeholder:text-zinc-500 focus:border-blue-500/50 focus:outline-none"
                />
              </div>
            )}

            <div ref={listRef} className="max-h-72 overflow-y-auto space-y-0.5">
              {provider !== "custom" && !query && (
                <button
                  ref={!manualModel && value === "" ? selectedOptionRef : undefined}
                  type="button"
                  role="option"
                  aria-selected={!manualModel && value === ""}
                  onClick={() => choose("")}
                  className={`flex min-h-[38px] w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-[12.5px] leading-snug transition-colors cursor-pointer ${
                    !manualModel && value === ""
                      ? "bg-white/[0.1] text-white"
                      : "text-zinc-300 hover:bg-white/[0.06] hover:text-white"
                  }`}
                >
                  <span className="truncate">{defaultLabel}</span>
                  {!manualModel && value === "" && (
                    <Check size={13} weight="bold" className="shrink-0 text-blue-400" />
                  )}
                </button>
              )}

              {filteredModels.map((id) => {
                const selected = !manualModel && value === id;
                return (
                  <button
                    key={id}
                    ref={selected ? selectedOptionRef : undefined}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => choose(id)}
                    className={`flex min-h-[38px] w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left font-mono text-[12.5px] leading-snug transition-colors cursor-pointer ${
                      selected
                        ? "bg-white/[0.1] text-white"
                        : "text-zinc-200 hover:bg-white/[0.06] hover:text-white"
                    }`}
                  >
                    <span className="truncate">{id}</span>
                    {selected && (
                      <Check size={13} weight="bold" className="shrink-0 text-blue-400" />
                    )}
                  </button>
                );
              })}

              {filteredModels.length === 0 && query && (
                <div className="px-3 py-2.5 text-[12px] text-zinc-500">
                  No models matching “{filter}”
                </div>
              )}

              <div className="my-1 h-px bg-white/[0.07]" />
              <button
                type="button"
                role="option"
                aria-selected={manualModel}
                onClick={() => choose(MANUAL_MODEL)}
                className={`flex min-h-[38px] w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-[12.5px] leading-snug transition-colors cursor-pointer ${
                  manualModel
                    ? "bg-white/[0.1] text-white"
                    : "text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100"
                }`}
              >
                <span>Enter model ID…</span>
                {manualModel && (
                  <Check size={13} weight="bold" className="shrink-0 text-blue-400" />
                )}
              </button>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

export function SettingsModal() {
  const { state, dispatch, notifyToast, setDefaultWorkerAgent, setWindowMode } = useWorkspace();
  const [activeTab, setActiveTab] = useState<SettingsTabId>("general");

  const savedProvider = state.settings.agent_provider || "codex-cli";
  const savedModel = state.settings.agent_model || "";
  const savedBaseUrl = state.settings.custom_base_url ?? state.settings.agent_base_url ?? "";
  const savedAcpAgents: CustomAcpEntry[] = Array.isArray(state.settings.acp_agents)
    ? state.settings.acp_agents
    : [];

  const [provider, setProvider] = useState(savedProvider);
  const [model, setModel] = useState(savedModel);
  const [manualModel, setManualModel] = useState(false);
  const [catalog, setCatalog] = useState<(ModelCatalog & { key: string }) | null>(null);
  const [thinking, setThinking] = useState(state.settings.agent_thinking || "medium");
  const [baseUrl, setBaseUrl] = useState(savedBaseUrl);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [defaultWorker, setDefaultWorker] = useState(state.defaultWorkerAgent);
  const [windowMode, setLayout] = useState<WindowMode>(state.windowMode);
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(state.settings.permission_mode || "auto_edit");
  const [customAcp, setCustomAcp] = useState<CustomAcpEntry[]>(savedAcpAgents);
  const [newAcpId, setNewAcpId] = useState("");
  const [newAcpCmd, setNewAcpCmd] = useState("");
  const [newAcpArgs, setNewAcpArgs] = useState("--acp");
  const [copiedCmd, setCopiedCmd] = useState("");
  const [probingAuth, setProbingAuth] = useState(false);
  const [daemonStatus, setDaemonStatus] = useState<DaemonServiceStatus | null>(null);
  const [daemonBusy, setDaemonBusy] = useState(false);

  // Remote Access state (host-side management)
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatusSnapshot | null>(null);
  const [remoteDevices, setRemoteDevices] = useState<RemotePairedDevice[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteRelayUrl, setRemoteRelayUrl] = useState("wss://online.ufoo.dev/ufoo/online");
  const [remoteWebBaseUrl, setRemoteWebBaseUrl] = useState("");
  const [remoteAuthToken, setRemoteAuthToken] = useState("");
  const [remoteAllowInsecureWs, setRemoteAllowInsecureWs] = useState(false);
  const [remoteConfigDirty, setRemoteConfigDirty] = useState(false);
  const [pairTicket, setPairTicket] = useState<RemotePairTicket | null>(null);
  const [pairCreating, setPairCreating] = useState(false);
  const [revokingId, setRevokingId] = useState("");
  const [nowTick, setNowTick] = useState(() => Date.now());

  const isRemoteClient =
    state.transportMode === "remote-p2p" || state.transportMode === "remote-relay";

  const refreshRemoteData = async (syncFields = false) => {
    if (isRemoteClient) return;
    setRemoteLoading(true);
    try {
      const [statusRes, devicesRes] = await Promise.all([
        ufooBridge.sendCommand<RemoteStatusSnapshot>("remote.status", {}).catch(() => null),
        ufooBridge
          .sendCommand<{ ok: boolean; devices?: RemotePairedDevice[] }>("remote.devices.list", {})
          .catch(() => null),
      ]);
      if (statusRes && statusRes.ok) {
        setRemoteStatus(statusRes);
        if (syncFields || !remoteConfigDirty) {
          setRemoteRelayUrl(statusRes.relay_url || "wss://online.ufoo.dev/ufoo/online");
          setRemoteWebBaseUrl(statusRes.web_base_url || "");
          setRemoteAllowInsecureWs(Boolean(statusRes.allow_insecure_ws));
          setRemoteConfigDirty(false);
        }
      }
      if (devicesRes && devicesRes.ok && Array.isArray(devicesRes.devices)) {
        setRemoteDevices(devicesRes.devices);
      }
    } finally {
      setRemoteLoading(false);
    }
  };

  const handleToggleRemoteAccess = async () => {
    if (remoteBusy) return;
    setRemoteBusy(true);
    try {
      if (remoteStatus?.enabled) {
        const res = await ufooBridge.sendCommand<RemoteStatusSnapshot>("remote.disable", {});
        setRemoteStatus(res);
        setPairTicket(null);
        notifyToast(res?.ok ? "Remote access disabled" : res?.error || "Failed to disable remote access");
      } else {
        const res = await ufooBridge.sendCommand<RemoteStatusSnapshot>("remote.enable", {
          relay_url: remoteRelayUrl.trim() || "wss://online.ufoo.dev/ufoo/online",
          web_base_url: remoteWebBaseUrl.trim(),
          ...(remoteAuthToken.trim() ? { auth_token: remoteAuthToken.trim() } : {}),
          allow_insecure_ws: remoteAllowInsecureWs,
        });
        setRemoteStatus(res);
        setRemoteAuthToken("");
        setRemoteConfigDirty(false);
        if (res?.ok) {
          notifyToast("Remote access enabled");
        } else {
          notifyToast(res?.error || res?.last_error || "Could not connect to relay");
        }
      }
      await refreshRemoteData(false);
    } catch (err) {
      notifyToast(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoteBusy(false);
    }
  };

  const handleApplyRemoteConfig = async () => {
    if (remoteBusy) return;
    setRemoteBusy(true);
    try {
      const res = await ufooBridge.sendCommand<RemoteStatusSnapshot>("remote.enable", {
        relay_url: remoteRelayUrl.trim() || "wss://online.ufoo.dev/ufoo/online",
        web_base_url: remoteWebBaseUrl.trim(),
        ...(remoteAuthToken.trim() ? { auth_token: remoteAuthToken.trim() } : {}),
        allow_insecure_ws: remoteAllowInsecureWs,
      });
      setRemoteStatus(res);
      setRemoteAuthToken("");
      setRemoteConfigDirty(false);
      if (res?.ok) {
        notifyToast("Relay configuration saved & connected");
      } else {
        notifyToast(res?.error || res?.last_error || "Saved config, but relay connection failed");
      }
    } catch (err) {
      notifyToast(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoteBusy(false);
    }
  };

  const handleCreatePairTicket = async () => {
    if (pairCreating) return;
    setPairCreating(true);
    try {
      if (remoteConfigDirty) {
        await ufooBridge.sendCommand<RemoteStatusSnapshot>("remote.enable", {
          relay_url: remoteRelayUrl.trim() || "wss://online.ufoo.dev/ufoo/online",
          web_base_url: remoteWebBaseUrl.trim(),
          ...(remoteAuthToken.trim() ? { auth_token: remoteAuthToken.trim() } : {}),
          allow_insecure_ws: remoteAllowInsecureWs,
        });
        setRemoteAuthToken("");
        setRemoteConfigDirty(false);
      }
      const res = await ufooBridge.sendCommand<RemotePairTicket>("remote.pair.create", {
        ...(remoteWebBaseUrl.trim() ? { web_base_url: remoteWebBaseUrl.trim() } : {}),
      });
      if (!res?.ok) {
        notifyToast(res?.error || "Failed to generate pairing code");
        return;
      }
      setPairTicket(res);
      setNowTick(Date.now());
      notifyToast("One-time pairing code generated");
      await refreshRemoteData(false);
    } catch (err) {
      notifyToast(err instanceof Error ? err.message : String(err));
    } finally {
      setPairCreating(false);
    }
  };

  const handleRevokeDevice = async (clientId: string, label: string) => {
    setRevokingId(clientId);
    try {
      const res = await ufooBridge.sendCommand<{
        ok: boolean;
        devices?: RemotePairedDevice[];
        error?: string;
      }>("remote.devices.revoke", { client_id: clientId });
      if (!res?.ok) {
        notifyToast(res?.error || "Failed to revoke device");
        return;
      }
      if (Array.isArray(res.devices)) {
        setRemoteDevices(res.devices);
      } else {
        setRemoteDevices((prev) => prev.filter((d) => d.client_id !== clientId));
      }
      notifyToast(`Revoked access for ${label || clientId}`);
      await refreshRemoteData(false);
    } catch (err) {
      notifyToast(err instanceof Error ? err.message : String(err));
    } finally {
      setRevokingId("");
    }
  };

  const handleUnpairRemoteClient = () => {
    ufooBridge.unpairRemote();
    dispatch({ type: "SET_SETTINGS_MODAL", open: false });
    notifyToast("Disconnected and unpaired from host");
  };

  const refreshDaemonStatus = async () => {
    try {
      const res = await ufooBridge.sendCommand<DaemonServiceStatus>("daemon.service.status", {});
      if (res?.ok) setDaemonStatus(res);
    } catch {
      // ignore transient errors while host reconnects
    }
  };

  const handleToggleLaunchd = async () => {
    if (!daemonStatus?.supported) return;
    setDaemonBusy(true);
    try {
      const cmd = daemonStatus.launchd.loaded ? "daemon.service.uninstall" : "daemon.service.install";
      const res = await ufooBridge.sendCommand<DaemonServiceStatus>(cmd, {});
      if (res?.ok) {
        setDaemonStatus(res);
        notifyToast(
          res.launchd.loaded
            ? "Enabled macOS LaunchAgent daemon supervisor"
            : "Disabled macOS LaunchAgent supervisor"
        );
      } else {
        notifyToast(res?.error || "Failed to update LaunchAgent supervisor");
      }
    } catch (err) {
      notifyToast(err instanceof Error ? err.message : String(err));
    } finally {
      setDaemonBusy(false);
    }
  };

  const handleRestartDaemon = async () => {
    setDaemonBusy(true);
    try {
      const res = await ufooBridge.sendCommand<DaemonServiceStatus>("daemon.restart", {});
      if (res?.ok) {
        setDaemonStatus(res);
        notifyToast("GlobalDaemon restarted");
      } else {
        notifyToast(res?.error || "Failed to restart GlobalDaemon");
      }
    } catch (err) {
      notifyToast(err instanceof Error ? err.message : String(err));
    } finally {
      setDaemonBusy(false);
    }
  };

  const refreshAuthProbe = async () => {
    setProbingAuth(true);
    try {
      const res = await ufooBridge.sendCommand<{ ok: boolean; data?: OnboardingProbeState }>("onboarding.probe", {});
      if (res?.ok && res.data) {
        dispatch({ type: "SET_ONBOARDING_PROBE", probe: res.data });
      }
    } finally {
      setProbingAuth(false);
    }
  };

  useEffect(() => {
    if (state.settingsModalOpen) {
      setActiveTab(state.settingsInitialTab || "general");
    }
  }, [state.settingsModalOpen, state.settingsInitialTab]);

  useEffect(() => {
    if (state.settingsModalOpen && activeTab === "engines" && !state.onboardingProbe) {
      void refreshAuthProbe();
    }
    if (state.settingsModalOpen && activeTab === "cli") {
      void refreshDaemonStatus();
    }
    if (state.settingsModalOpen && activeTab === "remote" && !isRemoteClient) {
      void refreshRemoteData(true);
    }
  }, [state.settingsModalOpen, activeTab, isRemoteClient]);

  useEffect(() => {
    if (!state.settingsModalOpen || activeTab !== "remote" || isRemoteClient || !state.remoteStatus) return;
    setRemoteStatus(state.remoteStatus);
    void ufooBridge
      .sendCommand<{ ok: boolean; devices?: RemotePairedDevice[] }>("remote.devices.list", {})
      .then((res) => {
        if (res?.ok && Array.isArray(res.devices)) setRemoteDevices(res.devices);
      })
      .catch(() => {});
  }, [state.remoteStatus, state.settingsModalOpen, activeTab, isRemoteClient]);

  useEffect(() => {
    if (!pairTicket || !state.settingsModalOpen || activeTab !== "remote") return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [pairTicket, state.settingsModalOpen, activeTab]);

  useEffect(() => {
    if (!state.settingsModalOpen) return;
    setProvider(savedProvider);
    setModel(savedModel);
    setManualModel(false);
    setThinking(state.settings.agent_thinking || "medium");
    setBaseUrl(savedBaseUrl);
    setPermissionModeState(state.settings.permission_mode || "auto_edit");
    setCustomAcp(savedAcpAgents);
    setDefaultWorker(state.defaultWorkerAgent);
    setLayout(state.windowMode);
    setApiKey("");
  }, [
    state.settingsModalOpen,
    state.activeRoot,
    savedProvider,
    savedModel,
    savedBaseUrl,
    state.settings.agent_thinking,
    state.settings.permission_mode,
    state.defaultWorkerAgent,
    state.windowMode,
  ]);

  useEffect(() => {
    if (!state.settingsModalOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        dispatch({ type: "SET_SETTINGS_MODAL", open: false });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.settingsModalOpen, dispatch]);

  const canListModels = provider !== "custom" || (
    savedProvider === "custom" && Boolean(savedBaseUrl) && baseUrl.trim() === savedBaseUrl && !apiKey.trim()
  );
  const catalogKey = `${state.activeRoot}\n${provider}\n${provider === "custom" ? savedBaseUrl : ""}`;

  useEffect(() => {
    setCatalog(null);
    if (!state.settingsModalOpen || !state.activeRoot || !canListModels) return;
    let stale = false;
    void ufooBridge.sendCommand<ModelCatalog>("settings.models", { agent_provider: provider })
      .then((result) => {
        if (!stale) setCatalog({ key: catalogKey, ...result, models: result.models || [] });
      })
      .catch(() => {
        if (!stale) setCatalog({ key: catalogKey, ok: false, models: [] });
      });
    return () => { stale = true; };
  }, [catalogKey, canListModels, provider, state.activeRoot, state.settingsModalOpen]);

  if (!state.settingsModalOpen) return null;

  const currentTab = NAV_TABS.find((t) => t.id === activeTab) || NAV_TABS[0];
  const currentCatalog = canListModels && catalog?.key === catalogKey ? catalog : null;
  const modelOptions = Array.from(new Set([model, ...(currentCatalog?.models || [])].filter(Boolean)));
  let catalogStatus = "";
  if (!canListModels) catalogStatus = "Save the gateway settings to load its model list.";
  else if (!state.activeRoot) catalogStatus = "Connect to Ufoo to load models.";
  else if (!currentCatalog) catalogStatus = "Loading models…";
  else if (!currentCatalog.models.length) catalogStatus = "No models available. You can enter a model ID manually.";

  const acpChanged = JSON.stringify(customAcp) !== JSON.stringify(savedAcpAgents);
  const hasUnsavedChanges =
    provider !== savedProvider ||
    model.trim() !== savedModel ||
    thinking !== (state.settings.agent_thinking || "medium") ||
    permissionMode !== (state.settings.permission_mode || "auto_edit") ||
    defaultWorker !== state.defaultWorkerAgent ||
    (state.scope === "project" && windowMode !== state.windowMode) ||
    (provider === "custom" && (baseUrl.trim() !== savedBaseUrl || Boolean(apiKey.trim()))) ||
    acpChanged;

  const handleAddCustomAcp = () => {
    const id = newAcpId.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
    const command = newAcpCmd.trim();
    if (!id || !command) {
      notifyToast("Enter both an ACP agent ID and executable command");
      return;
    }
    const args = newAcpArgs.trim().split(/\s+/).filter(Boolean);
    setCustomAcp((prev) => [
      ...prev.filter((item) => item.id !== id),
      { id, label: `${id} (ACP)`, command, args },
    ]);
    setNewAcpId("");
    setNewAcpCmd("");
    setNewAcpArgs("--acp");
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const patch: Record<string, any> = {};
      const providerChanged = provider !== savedProvider;
      const modelId = model.trim();
      if (manualModel && !modelId) throw new Error("Enter a model ID");
      if (providerChanged) patch.agent_provider = provider;
      if (modelId !== (providerChanged ? "" : savedModel)) patch.agent_model = modelId;
      if (thinking !== (state.settings.agent_thinking || "medium")) patch.agent_thinking = thinking;
      if (permissionMode !== (state.settings.permission_mode || "auto_edit")) patch.permission_mode = permissionMode;
      if (acpChanged) patch.acp_agents = customAcp;
      if (provider === "custom") {
        if (baseUrl.trim() !== savedBaseUrl) patch.agent_base_url = baseUrl.trim();
        if (apiKey.trim()) patch.agent_api_key = apiKey.trim();
      }
      if (Object.keys(patch).length) {
        const result = await ufooBridge.sendCommand<{ ok: boolean; error?: string }>("settings.set", patch);
        if (!result.ok) throw new Error(result.error || "Could not save settings");
      }
      if (defaultWorker !== state.defaultWorkerAgent) setDefaultWorkerAgent(defaultWorker);
      if (state.scope === "project" && windowMode !== state.windowMode) {
        const project = state.projects.find(({ root }) => root === state.activeRoot);
        const workers = project?.workers.filter(({ internal }) => internal) || [];
        const sideWorker = workers.find(({ id }) => id === state.sideAgentId) || workers[0];
        await setWindowMode(windowMode, windowMode === "side" ? sideWorker?.id : undefined);
      }
      notifyToast("Settings saved");
      dispatch({ type: "SET_SETTINGS_MODAL", open: false });
    } catch (error) {
      notifyToast(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const handleInstallCli = async () => {
    const res = await ufooBridge.sendCommand<{ ok: boolean; targetDir?: string }>(
      "cli.install_shims",
      { updateZshrc: true }
    );
    if (res?.ok) {
      notifyToast(`Installed ufoo & ucode CLI shims in ${res.targetDir || "~/.ufoo/bin"}`);
    }
  };

  const handleCopySnippet = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCmd(text);
      setTimeout(() => setCopiedCmd(""), 1600);
    } catch {
      notifyToast("Copy failed");
    }
  };

  return (
    <div
      onClick={() => dispatch({ type: "SET_SETTINGS_MODAL", open: false })}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm p-3 md:p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[88dvh] md:h-[540px] max-h-[90dvh] md:max-h-[85vh] w-full max-w-[740px] overflow-hidden rounded-2xl border border-white/[0.11] bg-[#111114] shadow-2xl"
      >
        {/* Clean Typography-First Left Nav */}
        <aside className="hidden md:flex w-[188px] shrink-0 flex-col border-r border-white/[0.07] bg-zinc-950/75 p-3">
          <div className="px-2.5 pb-3 pt-1">
            <div className="text-[13px] font-semibold text-zinc-100">Settings</div>
            <div className="text-[11px] text-zinc-500 font-mono">
              ufoo {state.packageVersion ? `v${state.packageVersion}` : "v5"}
            </div>
          </div>

          <nav className="flex-1 space-y-0.5">
            {NAV_TABS.map(({ id, label }) => {
              const selected = activeTab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id)}
                  className={`flex w-full items-center rounded-lg px-2.5 py-2 text-left text-[12.5px] font-medium transition-colors cursor-pointer ${
                    selected
                      ? "bg-white/[0.1] text-white"
                      : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
                  }`}
                >
                  <span className="truncate">{label}</span>
                </button>
              );
            })}
          </nav>

          <div className="border-t border-white/[0.06] pt-2.5 space-y-1.5">
            <button
              type="button"
              onClick={() => {
                dispatch({ type: "SET_SETTINGS_MODAL", open: false });
                dispatch({ type: "SET_ONBOARDING_OPEN", open: true });
              }}
              className="flex w-full items-center justify-between rounded-lg border border-white/[0.07] bg-white/[0.03] px-2.5 py-1.5 text-[11.5px] font-medium text-zinc-300 hover:bg-white/[0.08] hover:text-white transition-colors cursor-pointer"
            >
              <span>Setup Wizard</span>
              <span className="text-zinc-500">→</span>
            </button>
            <div className="px-2 text-[10.5px] text-zinc-500">Shared with CLI daemon</div>
          </div>
        </aside>

        {/* Right Detail Pane */}
        <section className="flex flex-1 min-w-0 flex-col bg-[#0e0e11]">
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-white/[0.06] px-4 md:px-6 py-3.5 md:py-4">
            <div className="min-w-0">
              <h2 className="text-[14.5px] font-semibold text-zinc-100">{currentTab.title}</h2>
              <p className="mt-0.5 text-[11.5px] text-zinc-500">{currentTab.subtitle}</p>
            </div>
            <button
              type="button"
              onClick={() => dispatch({ type: "SET_SETTINGS_MODAL", open: false })}
              aria-label="Close settings"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.08] hover:text-white transition-colors cursor-pointer"
            >
              <X size={15} />
            </button>
          </header>

          {/* Mobile Horizontal Tab Strip */}
          <div className="flex md:hidden shrink-0 items-center gap-1 overflow-x-auto border-b border-white/[0.06] bg-zinc-950/60 px-3 py-2">
            {NAV_TABS.map(({ id, label }) => {
              const selected = activeTab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id)}
                  className={`shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors cursor-pointer ${
                    selected
                      ? "bg-white/[0.12] text-white"
                      : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4 md:py-5 space-y-5">
            {activeTab === "general" && (
              <>
                <SegmentedSetting
                  label="Window Layout"
                  description="Choose how ufoo and worker agents share the center stage when a project root is selected."
                  value={windowMode}
                  options={WINDOW_LAYOUTS}
                  onChange={setLayout}
                  disabled={state.scope !== "project"}
                />

                <fieldset className="space-y-1.5">
                  <legend className="text-[12px] font-medium text-zinc-200">
                    Default Quick-Launch Worker
                  </legend>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                    {WORKER_AGENTS.map(({ id, label }) => {
                      const active = defaultWorker === id;
                      return (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setDefaultWorker(id as WorkerAgent)}
                          className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-[12px] font-medium transition-colors cursor-pointer ${
                            active
                              ? "border-blue-400/40 bg-blue-500/12 text-white"
                              : "border-white/[0.08] bg-white/[0.02] text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
                          }`}
                        >
                          <BrandIcon brand={id} size={14} />
                          <span className="truncate">{label}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[11.5px] text-zinc-500">
                    Used when clicking the + button next to a project in the sidebar.
                  </p>
                </fieldset>

                <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3.5 space-y-2">
                  <div className="text-[12px] font-medium text-zinc-200">Keyboard Shortcuts</div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[11.5px]">
                    {[
                      ["Command Palette", "⌘K"],
                      ["Cycle Layout", "⌘W"],
                      ["Toggle Sidebar", "⌘B"],
                      ["Toggle Inspector", "⌘⌥B"],
                      ["Open Settings", "⌘,"],
                    ].map(([desc, keys]) => (
                      <div key={desc} className="flex items-center justify-between text-zinc-400">
                        <span>{desc}</span>
                        <kbd className="rounded border border-white/[0.1] bg-zinc-900 px-1.5 py-0.5 font-mono text-[10.5px] text-zinc-300">
                          {keys}
                        </kbd>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {activeTab === "models" && (
              <>
                <fieldset className="space-y-1.5">
                  <legend className="text-[12px] font-medium text-zinc-200">
                    Ufoo Provider
                  </legend>
                  <div className="grid grid-cols-2 gap-1.5">
                    {PROVIDERS.map(({ value, label }) => {
                      const active = provider === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={active}
                          onClick={() => {
                            setProvider(value);
                            setModel(value === savedProvider ? savedModel : "");
                            setManualModel(false);
                          }}
                          className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-[12px] font-medium transition-colors cursor-pointer ${
                            active
                              ? "border-blue-400/40 bg-blue-500/12 text-white"
                              : "border-white/[0.08] bg-white/[0.02] text-zinc-300 hover:bg-white/[0.05] hover:text-white"
                          }`}
                        >
                          <BrandIcon brand={value} size={15} />
                          <span className="truncate">{label}</span>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>

                <div className="space-y-1.5">
                  <label htmlFor="agent-model" className="block text-[12px] font-medium text-zinc-200">
                    Model
                  </label>
                  <SettingsModelSelect
                    value={model}
                    manualModel={manualModel}
                    provider={provider}
                    defaultModel={currentCatalog?.default_model}
                    modelOptions={modelOptions}
                    onSelect={(selected) => {
                      setManualModel(selected === MANUAL_MODEL);
                      if (selected !== MANUAL_MODEL) setModel(selected);
                    }}
                  />
                  {manualModel && (
                    <input
                      type="text"
                      aria-label="Custom model ID"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder="Model ID"
                      className="mt-2 w-full rounded-xl border border-white/[0.09] bg-zinc-900 px-3 py-2 font-mono text-[12.5px] text-zinc-100 focus:border-blue-500/50 focus:outline-none"
                    />
                  )}
                  {catalogStatus && (
                    <p role="status" className="text-[11.5px] text-zinc-500">
                      {catalogStatus}
                    </p>
                  )}
                </div>

                <SegmentedSetting
                  label="Reasoning Effort"
                  description="Controls thinking budget for supported reasoning models."
                  value={thinking}
                  options={REASONING_EFFORTS}
                  onChange={setThinking}
                />

                {provider === "custom" && (
                  <div className="space-y-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3.5">
                    <div className="space-y-1">
                      <label className="block text-[11.5px] font-medium text-zinc-300">
                        Custom Base URL
                      </label>
                      <input
                        type="text"
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        placeholder="https://api.example.com/v1"
                        className="w-full rounded-lg border border-white/[0.09] bg-zinc-900 px-3 py-1.5 font-mono text-[12px] text-zinc-100 focus:border-blue-500/50 focus:outline-none"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-[11.5px] font-medium text-zinc-300">
                        API Key (stored locally, never returned in snapshots)
                      </label>
                      <input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder="sk-..."
                        className="w-full rounded-lg border border-white/[0.09] bg-zinc-900 px-3 py-1.5 font-mono text-[12px] text-zinc-100 focus:border-blue-500/50 focus:outline-none"
                      />
                    </div>
                  </div>
                )}
              </>
            )}

            {activeTab === "engines" && (
              <>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-[12px] font-medium text-zinc-200">Primary Engines & Auth</div>
                    <button
                      type="button"
                      disabled={probingAuth}
                      onClick={() => void refreshAuthProbe()}
                      className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-white/[0.08] cursor-pointer"
                    >
                      <ArrowsClockwise size={11} className={probingAuth ? "animate-spin" : ""} />
                      <span>Re-check</span>
                    </button>
                  </div>
                  <div className="divide-y divide-white/[0.06] rounded-xl border border-white/[0.07] bg-white/[0.02]">
                    {(state.onboardingProbe?.primary_engines || []).length > 0
                      ? state.onboardingProbe!.primary_engines.map((eng) => (
                          <div key={eng.id} className="flex items-center justify-between gap-2 px-3.5 py-2.5 text-[12px]">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <BrandIcon brand={eng.id} size={16} />
                              <div className="min-w-0">
                                <div className="font-medium text-zinc-100">{eng.label}</div>
                                <div className="text-[11px] text-zinc-500 truncate">{eng.detail}</div>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              {eng.status === "needs_auth" && eng.loginCommand && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void ufooBridge.sendCommand("onboarding.open_login", { engine: eng.id })
                                  }
                                  className="shrink-0 whitespace-nowrap rounded-md bg-amber-500/20 border border-amber-400/30 px-2 py-0.5 text-[10.5px] text-amber-200 hover:bg-amber-500/30 cursor-pointer"
                                >
                                  Sign in
                                </button>
                              )}
                              <span
                                className={`shrink-0 whitespace-nowrap rounded-md px-2 py-0.5 font-mono text-[10.5px] ${
                                  eng.status === "ready"
                                    ? "bg-emerald-500/15 text-emerald-300"
                                    : eng.status === "needs_auth"
                                    ? "bg-amber-500/15 text-amber-300"
                                    : "bg-white/[0.04] text-zinc-500"
                                }`}
                              >
                                {eng.status === "ready" ? "Ready" : eng.status === "needs_auth" ? "Needs Login" : "Missing"}
                              </span>
                            </div>
                          </div>
                        ))
                      : state.engineCatalog
                          .filter((e) => e.kind !== "acp")
                          .map((eng) => (
                            <div key={eng.id} className="flex items-center justify-between px-3.5 py-2.5 text-[12px]">
                              <div className="flex items-center gap-2.5 min-w-0">
                                <BrandIcon brand={eng.id} size={16} />
                                <div className="min-w-0">
                                  <div className="font-medium text-zinc-100">{eng.label}</div>
                                  <div className="text-[11px] text-zinc-500">{eng.description}</div>
                                </div>
                              </div>
                              <span className="shrink-0 whitespace-nowrap rounded-md bg-emerald-500/15 px-2 py-0.5 font-mono text-[10.5px] text-emerald-300">
                                {eng.kind.toUpperCase()} · Ready
                              </span>
                            </div>
                          ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-[12px] font-medium text-zinc-200">Detected ACP Extensions</div>
                  <div className="divide-y divide-white/[0.06] rounded-xl border border-white/[0.07] bg-white/[0.02]">
                    {state.engineCatalog
                      .filter((e) => e.kind === "acp")
                      .map((eng) => (
                        <div key={eng.id} className="flex items-center justify-between px-3.5 py-2 text-[12px]">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <BrandIcon brand={eng.id} size={16} />
                            <div className="min-w-0">
                              <div className="font-medium text-zinc-200 truncate">{eng.label}</div>
                              <div className="font-mono text-[10.5px] text-zinc-500 truncate">
                                {eng.command || eng.agentType}
                              </div>
                            </div>
                          </div>
                          <span
                            className={`shrink-0 whitespace-nowrap rounded-md px-2 py-0.5 font-mono text-[10.5px] ${
                              eng.available
                                ? "bg-emerald-500/15 text-emerald-300"
                                : "bg-white/[0.04] text-zinc-500"
                            }`}
                          >
                            {eng.available ? "Ready" : "Not installed"}
                          </span>
                        </div>
                      ))}
                  </div>
                </div>

                <div className="space-y-2 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3.5">
                  <div className="text-[12px] font-medium text-zinc-200">Custom ACP Agents</div>
                  {customAcp.length > 0 && (
                    <div className="space-y-1.5">
                      {customAcp.map((item) => (
                        <div
                          key={item.id}
                          className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-zinc-900/70 px-2.5 py-1.5 text-[11.5px]"
                        >
                          <div className="font-mono text-zinc-200 truncate">
                            <span className="text-blue-300">acp:{item.id}</span> → {item.command}{" "}
                            {(item.args || []).join(" ")}
                          </div>
                          <button
                            type="button"
                            onClick={() => setCustomAcp((prev) => prev.filter((x) => x.id !== item.id))}
                            title="Remove custom ACP agent"
                            className="text-zinc-500 hover:text-rose-300 cursor-pointer"
                          >
                            <Trash size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="grid grid-cols-12 gap-2 pt-1">
                    <input
                      type="text"
                      value={newAcpId}
                      onChange={(e) => setNewAcpId(e.target.value)}
                      placeholder="id (e.g. mybot)"
                      className="col-span-3 rounded-lg border border-white/[0.08] bg-zinc-900 px-2.5 py-1.5 font-mono text-[11.5px] text-zinc-100 placeholder:text-zinc-500 focus:border-blue-500/50 focus:outline-none"
                    />
                    <input
                      type="text"
                      value={newAcpCmd}
                      onChange={(e) => setNewAcpCmd(e.target.value)}
                      placeholder="binary path or command"
                      className="col-span-5 rounded-lg border border-white/[0.08] bg-zinc-900 px-2.5 py-1.5 font-mono text-[11.5px] text-zinc-100 placeholder:text-zinc-500 focus:border-blue-500/50 focus:outline-none"
                    />
                    <input
                      type="text"
                      value={newAcpArgs}
                      onChange={(e) => setNewAcpArgs(e.target.value)}
                      placeholder="args"
                      className="col-span-3 rounded-lg border border-white/[0.08] bg-zinc-900 px-2.5 py-1.5 font-mono text-[11.5px] text-zinc-100 placeholder:text-zinc-500 focus:border-blue-500/50 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={handleAddCustomAcp}
                      title="Add ACP agent"
                      className="col-span-1 flex items-center justify-center rounded-lg bg-white/[0.08] text-zinc-200 hover:bg-blue-600 hover:text-white transition-colors cursor-pointer"
                    >
                      <Plus size={14} weight="bold" />
                    </button>
                  </div>
                </div>
              </>
            )}

            {activeTab === "safety" && (
              <>
                <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3.5 space-y-1 text-[11.5px] text-zinc-400">
                  <div className="font-medium text-zinc-200">Shared Workspace & Model-Managed Worktrees</div>
                  <p className="leading-relaxed">
                    All agents and groups share the live project repository directly without framework-level worktree isolation or agent binding. Models may freely create, inspect, and collaborate across any linked git worktrees of this repository on demand.
                  </p>
                </div>

                <SegmentedSetting
                  label="Default Permission Policy"
                  description="Applied to Claude SDK, Codex SDK, ACP agents, and native workers. Toggle per-session anytime from the header."
                  value={permissionMode}
                  options={PERMISSION_MODES}
                  onChange={setPermissionModeState}
                />

                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5">
                    <div className="font-medium text-amber-300">Supervised</div>
                    <div className="mt-0.5 text-zinc-400">Ask approval before edits & shell commands.</div>
                  </div>
                  <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5">
                    <div className="font-medium text-emerald-300">Auto-Edit</div>
                    <div className="mt-0.5 text-zinc-400">Allow file edits; prompt on risky commands.</div>
                  </div>
                  <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5">
                    <div className="font-medium text-rose-300">Full Access</div>
                    <div className="mt-0.5 text-zinc-400">Unattended execution without prompts.</div>
                  </div>
                </div>
              </>
            )}

            {activeTab === "remote" && (() => {
              const sessionInfo = ufooBridge.getRemoteSessionInfo();
              if (isRemoteClient) {
                const isP2p = state.transportMode === "remote-p2p";
                return (
                  <>
                    <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-4 space-y-3.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-emerald-400/25 bg-emerald-500/10 text-emerald-300">
                            <ShieldCheck size={18} weight="duotone" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-[13.5px] font-semibold text-zinc-100">
                                {state.remoteDeviceName || sessionInfo?.deviceName || "Paired Host"}
                              </span>
                              <span
                                className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-medium ${
                                  isP2p
                                    ? "bg-emerald-500/15 text-emerald-300 border border-emerald-400/25"
                                    : "bg-sky-500/15 text-sky-300 border border-sky-400/25"
                                }`}
                              >
                                {isP2p ? "P2P E2EE" : "Relay E2EE"}
                              </span>
                            </div>
                            <div className="mt-0.5 text-[11.5px] text-zinc-500">
                              {state.connectionState === "connected"
                                ? "End-to-end encrypted session active"
                                : state.connectionState === "reconnecting"
                                ? "Reconnecting to host…"
                                : "Disconnected"}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="space-y-2 rounded-lg border border-white/[0.06] bg-zinc-950/90 p-3 text-[11.5px]">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-zinc-500">Host Fingerprint</span>
                          <button
                            type="button"
                            onClick={() =>
                              void handleCopySnippet(
                                state.remoteHostFingerprint || sessionInfo?.hostFingerprint || ""
                              )
                            }
                            className="inline-flex items-center gap-1.5 font-mono text-[11px] text-zinc-200 hover:text-white cursor-pointer"
                          >
                            <span>{state.remoteHostFingerprint || sessionInfo?.hostFingerprint || "—"}</span>
                            <Copy size={11} className="text-zinc-500" />
                          </button>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-zinc-500">Host Device ID</span>
                          <span className="truncate font-mono text-[11px] text-zinc-400">
                            {state.remoteDeviceId || sessionInfo?.deviceId || "—"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-zinc-500">Relay Endpoint</span>
                          <span className="truncate font-mono text-[11px] text-zinc-400 max-w-[260px]">
                            {state.remoteRelayUrl || sessionInfo?.relayUrl || "—"}
                          </span>
                        </div>
                        {sessionInfo?.clientLabel && (
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-zinc-500">This Device</span>
                            <span className="truncate text-zinc-300">{sessionInfo.clientLabel}</span>
                          </div>
                        )}
                      </div>

                      <p className="text-[11px] leading-relaxed text-zinc-500">
                        Protected by ECDH P-256 + HKDF-SHA256 + AES-256-GCM. Relay servers only forward opaque ciphertext and cannot inspect transcripts or approvals.
                      </p>

                      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                        {state.connectionState !== "connected" && (
                          <button
                            type="button"
                            onClick={() => {
                              void ufooBridge.reconnectRemote().catch((err) => {
                                notifyToast(err instanceof Error ? err.message : String(err));
                              });
                            }}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.06] px-3 py-1.5 text-[12px] font-medium text-zinc-100 hover:bg-white/[0.12] transition-colors cursor-pointer"
                          >
                            <ArrowsClockwise size={13} />
                            <span>Reconnect</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={handleUnpairRemoteClient}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/35 bg-rose-500/15 px-3.5 py-1.5 text-[12px] font-medium text-rose-200 hover:bg-rose-500/25 transition-colors cursor-pointer"
                        >
                          <SignOut size={13} />
                          <span>Disconnect / Unpair</span>
                        </button>
                      </div>
                    </div>
                  </>
                );
              }

              const statusBadge = (() => {
                const st = remoteStatus?.state || "disabled";
                if (st === "connected") {
                  return { label: "Connected", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-400/25" };
                }
                if (st === "connecting" || st === "reconnecting") {
                  return { label: st === "connecting" ? "Connecting…" : "Reconnecting…", cls: "bg-amber-500/15 text-amber-300 border-amber-400/25" };
                }
                if (st === "error") {
                  return { label: "Error", cls: "bg-rose-500/15 text-rose-300 border-rose-400/25" };
                }
                return { label: "Disabled", cls: "bg-white/[0.06] text-zinc-400 border-white/[0.08]" };
              })();

              const ticketExpiryMs = pairTicket ? Math.max(0, Date.parse(pairTicket.expires_at) - nowTick) : 0;
              const ticketExpired = Boolean(pairTicket && ticketExpiryMs <= 0);
              const ticketQrSrc = pairTicket
                ? pairTicket.qr_data_url ||
                  (pairTicket.qr_svg
                    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pairTicket.qr_svg)}`
                    : "")
                : "";

              return (
                <>
                  {/* Host Identity & Toggle Card */}
                  <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 space-y-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] font-semibold text-zinc-100">
                            {remoteStatus?.device_name || "This Mac"}
                          </span>
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${statusBadge.cls}`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                remoteStatus?.state === "connected"
                                  ? "bg-emerald-400"
                                  : remoteStatus?.state === "connecting" || remoteStatus?.state === "reconnecting"
                                  ? "bg-amber-400 animate-pulse"
                                  : remoteStatus?.state === "error"
                                  ? "bg-rose-400"
                                  : "bg-zinc-500"
                              }`}
                            />
                            {statusBadge.label}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                          <span className="font-mono truncate max-w-[200px]">
                            ID: {remoteStatus?.device_id || "—"}
                          </span>
                          {remoteStatus?.fingerprint && (
                            <button
                              type="button"
                              onClick={() => void handleCopySnippet(remoteStatus.fingerprint)}
                              title="Copy host key fingerprint"
                              className="inline-flex items-center gap-1 font-mono text-zinc-300 hover:text-white cursor-pointer"
                            >
                              <span>FP: {remoteStatus.fingerprint}</span>
                              {copiedCmd === remoteStatus.fingerprint ? (
                                <Check size={11} className="text-emerald-400" />
                              ) : (
                                <Copy size={11} className="text-zinc-500" />
                              )}
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          disabled={remoteLoading || remoteBusy}
                          onClick={() => void refreshRemoteData(false)}
                          title="Refresh remote status"
                          className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-zinc-400 hover:bg-white/[0.09] hover:text-zinc-100 disabled:opacity-50 transition-colors cursor-pointer"
                        >
                          <ArrowsClockwise size={13} className={remoteLoading ? "animate-spin" : ""} />
                        </button>
                        <button
                          type="button"
                          disabled={remoteBusy}
                          onClick={() => void handleToggleRemoteAccess()}
                          className={`rounded-lg border px-3 py-1 text-[11.5px] font-medium transition-colors disabled:opacity-50 cursor-pointer ${
                            remoteStatus?.enabled
                              ? "border-white/[0.12] bg-white/[0.07] text-zinc-200 hover:bg-rose-500/20 hover:border-rose-500/35 hover:text-rose-200"
                              : "border-blue-500/40 bg-blue-600 text-white hover:bg-blue-500"
                          }`}
                        >
                          {remoteBusy
                            ? "Working…"
                            : remoteStatus?.enabled
                            ? "Disable"
                            : "Enable Remote Access"}
                        </button>
                      </div>
                    </div>

                    {remoteStatus?.remote_url && (
                      <div className="flex items-center justify-between gap-2 rounded-lg border border-blue-400/20 bg-blue-500/[0.06] px-3 py-2">
                        <div className="min-w-0">
                          <div className="text-[10px] font-medium uppercase tracking-wider text-blue-300/80">
                            Personal Remote Web URL
                          </div>
                          <div className="truncate font-mono text-[11.5px] text-zinc-100">
                            {remoteStatus.remote_url}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleCopySnippet(remoteStatus.remote_url || "")}
                          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-white/[0.1] bg-white/[0.05] px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:bg-white/[0.1] transition-colors cursor-pointer"
                        >
                          {copiedCmd === remoteStatus.remote_url ? (
                            <Check size={12} className="text-emerald-400" />
                          ) : (
                            <Copy size={12} />
                          )}
                          <span>{copiedCmd === remoteStatus.remote_url ? "Copied" : "Copy URL"}</span>
                        </button>
                      </div>
                    )}

                    {remoteStatus?.last_error && (
                      <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11.5px] text-rose-200">
                        {remoteStatus.last_error}
                      </div>
                    )}

                    {/* Relay Configuration Fields */}
                    <div className="space-y-2.5 border-t border-white/[0.06] pt-3">
                      <div className="space-y-1">
                        <label className="block text-[11.5px] font-medium text-zinc-300">
                          Relay URL
                        </label>
                        <input
                          type="text"
                          value={remoteRelayUrl}
                          onChange={(e) => {
                            setRemoteRelayUrl(e.target.value);
                            setRemoteConfigDirty(true);
                          }}
                          placeholder="wss://online.ufoo.dev/ufoo/online"
                          className="w-full rounded-lg border border-white/[0.09] bg-zinc-900 px-3 py-1.5 font-mono text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:border-blue-500/50 focus:outline-none"
                        />
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        <div className="space-y-1">
                          <label className="block text-[11.5px] font-medium text-zinc-300">
                            Web Client Base URL <span className="text-zinc-500 font-normal">(optional)</span>
                          </label>
                          <input
                            type="text"
                            value={remoteWebBaseUrl}
                            onChange={(e) => {
                              setRemoteWebBaseUrl(e.target.value);
                              setRemoteConfigDirty(true);
                            }}
                            placeholder="https://online.ufoo.dev"
                            className="w-full rounded-lg border border-white/[0.09] bg-zinc-900 px-3 py-1.5 font-mono text-[11.5px] text-zinc-100 placeholder:text-zinc-600 focus:border-blue-500/50 focus:outline-none"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="block text-[11.5px] font-medium text-zinc-300">
                            Relay Auth Token <span className="text-zinc-500 font-normal">(optional)</span>
                          </label>
                          <input
                            type="password"
                            value={remoteAuthToken}
                            onChange={(e) => {
                              setRemoteAuthToken(e.target.value);
                              setRemoteConfigDirty(true);
                            }}
                            placeholder={remoteStatus?.has_auth_token ? "•••••••• (configured)" : "Bearer token if required"}
                            className="w-full rounded-lg border border-white/[0.09] bg-zinc-900 px-3 py-1.5 font-mono text-[11.5px] text-zinc-100 placeholder:text-zinc-600 focus:border-blue-500/50 focus:outline-none"
                          />
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                        <label className="inline-flex items-center gap-2 text-[11.5px] text-zinc-400 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={remoteAllowInsecureWs}
                            onChange={(e) => {
                              setRemoteAllowInsecureWs(e.target.checked);
                              setRemoteConfigDirty(true);
                            }}
                            className="h-3.5 w-3.5 rounded border-white/20 bg-zinc-900 accent-blue-500"
                          />
                          <span>Allow insecure <code className="font-mono text-zinc-300">ws://</code> (self-hosted LAN relay)</span>
                        </label>

                        {remoteConfigDirty && (
                          <button
                            type="button"
                            disabled={remoteBusy}
                            onClick={() => void handleApplyRemoteConfig()}
                            className="rounded-lg bg-blue-600 px-3 py-1 text-[11.5px] font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors cursor-pointer"
                          >
                            {remoteBusy ? "Applying…" : "Apply & Connect"}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Pair New Device Card */}
                  <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 space-y-3.5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-[12.5px] font-semibold text-zinc-100">
                          <QrCode size={15} className="text-blue-400" />
                          <span>Pair New Device</span>
                        </div>
                        <p className="mt-0.5 text-[11.5px] text-zinc-500">
                          Generate a short-lived one-time QR & pairing code for your phone or remote browser.
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={pairCreating || remoteBusy}
                        onClick={() => void handleCreatePairTicket()}
                        className="shrink-0 rounded-lg border border-blue-500/40 bg-blue-600/90 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors cursor-pointer"
                      >
                        {pairCreating
                          ? "Generating…"
                          : pairTicket
                          ? "Regenerate QR"
                          : "Generate Pairing QR & Code"}
                      </button>
                    </div>

                    {pairTicket && (
                      <div className="flex flex-col sm:flex-row items-center sm:items-start gap-4 rounded-xl border border-white/[0.08] bg-zinc-950/90 p-3.5">
                        {ticketQrSrc && (
                          <div className="shrink-0 rounded-xl bg-white p-2.5 shadow-md">
                            <img
                              src={ticketQrSrc}
                              alt="Device Pairing QR Code"
                              className={`h-36 w-36 block ${ticketExpired ? "opacity-30 grayscale" : ""}`}
                            />
                          </div>
                        )}
                        <div className="min-w-0 flex-1 w-full space-y-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                              One-Time Pairing Code
                            </span>
                            <span
                              className={`rounded-full px-2 py-0.5 font-mono text-[10.5px] ${
                                ticketExpired
                                  ? "bg-rose-500/15 text-rose-300"
                                  : "bg-amber-500/15 text-amber-300"
                              }`}
                            >
                              {ticketExpired ? "Expired" : `Expires in ${formatCountdown(ticketExpiryMs)}`}
                            </span>
                          </div>

                          <div className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.08] bg-zinc-900 px-3 py-2">
                            <span className="font-mono text-[20px] font-semibold tracking-[0.18em] text-white selectable-text">
                              {pairTicket.pair_code}
                            </span>
                            <button
                              type="button"
                              onClick={() => void handleCopySnippet(pairTicket.pair_code)}
                              className="inline-flex items-center gap-1 rounded-md border border-white/[0.09] bg-white/[0.05] px-2.5 py-1 text-[11px] text-zinc-200 hover:bg-white/[0.1] cursor-pointer"
                            >
                              {copiedCmd === pairTicket.pair_code ? (
                                <>
                                  <Check size={12} className="text-emerald-400" />
                                  <span>Copied</span>
                                </>
                              ) : (
                                <>
                                  <Copy size={12} />
                                  <span>Copy</span>
                                </>
                              )}
                            </button>
                          </div>

                          <div className="space-y-1">
                            <div className="text-[11px] text-zinc-500">Direct Pair Link</div>
                            <div className="flex items-center gap-1.5">
                              <input
                                type="text"
                                readOnly
                                value={pairTicket.deep_url}
                                onFocus={(e) => e.currentTarget.select()}
                                className="min-w-0 flex-1 rounded-lg border border-white/[0.07] bg-black/40 px-2.5 py-1.5 font-mono text-[11px] text-zinc-400 focus:outline-none"
                              />
                              <button
                                type="button"
                                onClick={() => void handleCopySnippet(pairTicket.deep_url)}
                                className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-white/[0.09] bg-white/[0.05] px-2.5 py-1.5 text-[11px] text-zinc-200 hover:bg-white/[0.1] cursor-pointer"
                              >
                                <Link size={12} />
                                <span>{copiedCmd === pairTicket.deep_url ? "Copied" : "Copy Link"}</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Paired Devices List */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-[12px] font-medium text-zinc-200">
                        <DeviceMobile size={14} className="text-zinc-400" />
                        <span>Paired Devices</span>
                        <span className="rounded-full bg-white/[0.07] px-1.5 py-0.2 font-mono text-[10px] text-zinc-400">
                          {remoteDevices.length}
                        </span>
                      </div>
                    </div>

                    {remoteDevices.length === 0 ? (
                      <div className="rounded-xl border border-white/[0.07] bg-white/[0.015] px-4 py-6 text-center text-[12px] text-zinc-500">
                        No paired devices yet. Generate a QR code above to connect your phone or browser.
                      </div>
                    ) : (
                      <div className="divide-y divide-white/[0.06] rounded-xl border border-white/[0.07] bg-white/[0.02]">
                        {remoteDevices.map((dev) => (
                          <div
                            key={dev.client_id}
                            className="flex flex-wrap items-center justify-between gap-2.5 px-3.5 py-2.5 text-[12px]"
                          >
                            <div className="min-w-0 flex-1 space-y-0.5">
                              <div className="flex items-center gap-2">
                                <span className="truncate font-medium text-zinc-100">{dev.label}</span>
                                {dev.connected ? (
                                  <span
                                    className={`shrink-0 rounded-full px-2 py-0.2 font-mono text-[10px] ${
                                      dev.transport === "p2p"
                                        ? "bg-emerald-500/15 text-emerald-300"
                                        : "bg-sky-500/15 text-sky-300"
                                    }`}
                                  >
                                    Online · {dev.transport === "p2p" ? "P2P" : "Relay"}
                                  </span>
                                ) : (
                                  <span className="shrink-0 rounded-full bg-white/[0.05] px-2 py-0.2 font-mono text-[10px] text-zinc-500">
                                    Offline
                                  </span>
                                )}
                              </div>
                              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[10.5px] text-zinc-500">
                                <span>{dev.fingerprint}</span>
                                <span>·</span>
                                <span className="truncate max-w-[140px]">{dev.client_id}</span>
                                <span>·</span>
                                <span className="font-sans">
                                  Paired {formatShortTimestamp(dev.paired_at)} · Seen {formatShortTimestamp(dev.last_seen)}
                                </span>
                              </div>
                            </div>
                            <button
                              type="button"
                              disabled={revokingId === dev.client_id}
                              onClick={() => void handleRevokeDevice(dev.client_id, dev.label)}
                              className="shrink-0 rounded-lg border border-rose-500/25 bg-rose-500/10 px-2.5 py-1 text-[11px] font-medium text-rose-300 hover:bg-rose-500/20 disabled:opacity-40 transition-colors cursor-pointer"
                            >
                              {revokingId === dev.client_id ? "Revoking…" : "Revoke"}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              );
            })()}

            {activeTab === "cli" && (
              <>
                <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-0.5 min-w-0">
                      <div className="flex items-center gap-2 text-[12.5px] font-medium text-zinc-100">
                        <span>GlobalDaemon Supervisor</span>
                        {daemonStatus && (
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
                              daemonStatus.launchd.loaded
                                ? "bg-emerald-500/15 text-emerald-300"
                                : "bg-white/[0.07] text-zinc-400"
                            }`}
                          >
                            {daemonStatus.launchd.loaded ? "launchd active" : "Unmanaged"}
                          </span>
                        )}
                      </div>
                      <div className="text-[11.5px] text-zinc-500 leading-relaxed">
                        Keeps <span className="font-mono text-zinc-300">~/.ufoo/run/ufoo.sock</span> supervised via macOS LaunchAgent (<span className="font-mono text-zinc-300">dev.ufoo.daemon</span>) so crashes and restarts heal automatically.
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={daemonBusy}
                      onClick={() => void refreshDaemonStatus()}
                      title="Refresh daemon status"
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-zinc-400 hover:bg-white/[0.09] hover:text-zinc-100 disabled:opacity-50 transition-colors cursor-pointer"
                    >
                      <ArrowsClockwise size={13} className={daemonBusy ? "animate-spin" : ""} />
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-zinc-950/90 px-3 py-2 text-[11.5px]">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          daemonStatus?.daemon_running
                            ? "bg-emerald-400"
                            : "bg-amber-400"
                        }`}
                      />
                      <span className="text-zinc-300 truncate">
                        {daemonStatus
                          ? daemonStatus.daemon_running
                            ? `Running${daemonStatus.daemon_pid ? ` · PID ${daemonStatus.daemon_pid}` : ""}`
                            : "Stopped"
                          : "Checking daemon…"}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {daemonStatus?.supported && (
                        <button
                          type="button"
                          disabled={daemonBusy}
                          onClick={() => void handleToggleLaunchd()}
                          className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 cursor-pointer ${
                            daemonStatus.launchd.loaded
                              ? "border-white/[0.1] bg-white/[0.05] text-zinc-300 hover:bg-white/[0.1]"
                              : "border-blue-500/40 bg-blue-600/90 text-white hover:bg-blue-500"
                          }`}
                        >
                          {daemonStatus.launchd.loaded ? "Disable LaunchAgent" : "Enable LaunchAgent"}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={daemonBusy}
                        onClick={() => void handleRestartDaemon()}
                        className="rounded-md border border-white/[0.1] bg-white/[0.06] px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:bg-white/[0.12] disabled:opacity-50 transition-colors cursor-pointer"
                      >
                        Restart Daemon
                      </button>
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <div className="text-[12.5px] font-medium text-zinc-100">
                      CLI Integration (<span className="font-mono text-zinc-300">~/.ufoo/bin</span>)
                    </div>
                    <div className="text-[11.5px] text-zinc-500">
                      Link <span className="font-mono text-zinc-300">ufoo</span> and{" "}
                      <span className="font-mono text-zinc-300">ucode</span> to the bundled Node runtime.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleInstallCli()}
                    className="shrink-0 rounded-lg border border-white/[0.1] bg-white/[0.07] px-3 py-1.5 text-[12px] font-medium text-zinc-100 hover:bg-blue-600 hover:border-blue-500 transition-colors cursor-pointer"
                  >
                    Install Shims
                  </button>
                </div>

                <div className="space-y-2.5 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                  <div>
                    <div className="text-[12.5px] font-medium text-zinc-100">
                      Expose ufoo as an ACP Server
                    </div>
                    <div className="text-[11.5px] text-zinc-500 mt-0.5">
                      Connect Zed, JetBrains, Neovim, or any ACP host to ufoo:
                    </div>
                  </div>
                  {[
                    { label: "Project Orchestrator (ufoo-agent)", cmd: "ufoo acp" },
                    { label: "Standalone Coding Agent (ucode)", cmd: "ucode --acp" },
                  ].map(({ label, cmd }) => (
                    <div
                      key={cmd}
                      className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-zinc-950/90 px-3 py-2"
                    >
                      <div>
                        <div className="text-[11px] text-zinc-500">{label}</div>
                        <code className="font-mono text-[12px] text-zinc-200">{cmd}</code>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleCopySnippet(cmd)}
                        className="rounded-md border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.1] cursor-pointer"
                      >
                        {copiedCmd === cmd ? "Copied" : "Copy"}
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <footer className="flex shrink-0 items-center justify-between border-t border-white/[0.06] bg-zinc-950/60 px-6 py-3">
            <div className="flex items-center gap-2 text-[11.5px] text-zinc-500">
              {hasUnsavedChanges ? (
                <>
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                  <span className="text-zinc-300">Unsaved changes</span>
                </>
              ) : (
                <span>All settings up to date</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => dispatch({ type: "SET_SETTINGS_MODAL", open: false })}
                className="rounded-lg px-3.5 py-1.5 text-[12.5px] text-zinc-400 hover:bg-white/[0.05] hover:text-white transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleSave()}
                className="rounded-lg bg-blue-600 px-4 py-1.5 text-[12.5px] font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors cursor-pointer"
              >
                {saving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
}

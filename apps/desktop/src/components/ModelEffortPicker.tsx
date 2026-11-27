import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, LockSimple, Shield, ShieldWarning } from "@phosphor-icons/react";
import { ufooBridge } from "../bridge/ufooClient";
import { useWorkspace } from "../store/workspaceStore";
import type { PermissionMode, WorkerModelCatalogResponse } from "../types";
import { BrandIcon, resolveBrandKey } from "./BrandIcon";

const EFFORT_LABELS: Record<string, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

const DEFAULT_EFFORTS = ["off", "low", "medium", "high"];

function computeUpwardPopoverStyle(
  trigger: HTMLElement | null,
  width: number,
  align: "left" | "right" = "left"
): React.CSSProperties {
  if (!trigger) return { left: 16, bottom: 64, width };
  const rect = trigger.getBoundingClientRect();
  const desiredLeft = align === "right" ? rect.right - width : rect.left;
  const clampedLeft = Math.max(8, Math.min(desiredLeft, window.innerWidth - width - 8));
  return {
    left: clampedLeft,
    bottom: Math.max(8, window.innerHeight - rect.top + 8),
    width,
  };
}

export function ModelEffortPicker({
  agentId = "",
  agentType = "main",
  currentModel = "",
  currentThinking = "medium",
  compact = false,
}: {
  agentId?: string;
  agentType?: string;
  currentModel?: string;
  currentThinking?: string;
  compact?: boolean;
}) {
  const { state, configureAgentRuntime } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [catalog, setCatalog] = useState<WorkerModelCatalogResponse | null>(null);
  const [filter, setFilter] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [optimisticModel, setOptimisticModel] = useState("");
  const [optimisticThinking, setOptimisticThinking] = useState("");
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedItemRef = useRef<HTMLButtonElement | null>(null);
  const scrolledForOpenRef = useRef(false);

  const effectiveModel = optimisticModel || currentModel || catalog?.current_model || catalog?.default_model || "default";
  const effectiveThinking = (optimisticThinking || currentThinking || catalog?.current_thinking || "medium").toLowerCase();

  useEffect(() => {
    setOptimisticModel("");
  }, [currentModel, agentId]);

  useEffect(() => {
    setOptimisticThinking("");
  }, [currentThinking, agentId]);

  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => setPopoverStyle(computeUpwardPopoverStyle(triggerRef.current, 312));
    reposition();
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setFilter("");
    void ufooBridge
      .sendCommand<WorkerModelCatalogResponse>("worker.models", {
        agent_id: agentId || "main",
        agent_type: agentType || "main",
      })
      .then((res) => {
        if (!cancelled && res?.ok) {
          setCatalog(res);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, agentId, agentType, state.activeRoot, state.settings.agent_provider]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const models = useMemo(() => {
    const base = Array.isArray(catalog?.models) ? catalog.models : [];
    const list = Array.from(
      new Set([...base, effectiveModel].filter((m) => m && m !== "default"))
    );
    const q = filter.trim().toLowerCase();
    return q ? list.filter((m) => m.toLowerCase().includes(q)) : list;
  }, [catalog?.models, effectiveModel, filter]);

  useEffect(() => {
    if (!open) {
      scrolledForOpenRef.current = false;
    }
  }, [open]);

  useLayoutEffect(() => {
    if (!open || scrolledForOpenRef.current) return;
    const listEl = listRef.current;
    const itemEl = selectedItemRef.current;
    if (!listEl || !itemEl) return;
    const listRect = listEl.getBoundingClientRect();
    const itemRect = itemEl.getBoundingClientRect();
    const offsetInList = itemRect.top - listRect.top + listEl.scrollTop;
    const targetTop = Math.max(0, offsetInList - (listEl.clientHeight - itemEl.clientHeight) / 2);
    listEl.scrollTop = targetTop;
    if (!loading) {
      scrolledForOpenRef.current = true;
    }
  }, [open, loading, models]);

  const thinkingLevels = catalog?.thinking_levels?.length ? catalog.thinking_levels : DEFAULT_EFFORTS;

  const handleSelectModel = async (nextModel: string) => {
    const trimmed = nextModel.trim();
    if (!trimmed || trimmed === effectiveModel || saving) return;
    setOptimisticModel(trimmed);
    setSaving(true);
    try {
      const ok = await configureAgentRuntime(agentId || "main", { model: trimmed });
      if (ok) {
        const tierMatch = catalog?.provider === "agy-cli"
          ? trimmed.match(/-(low|medium|high|xhigh)$/i)
          : null;
        setCatalog((prev) =>
          prev
            ? {
                ...prev,
                current_model: trimmed,
                ...(tierMatch ? { current_thinking: tierMatch[1].toLowerCase() } : {}),
              }
            : prev
        );
        setOpen(false);
      } else {
        setOptimisticModel("");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSelectThinking = async (level: string) => {
    if (level === effectiveThinking || saving) return;
    setOptimisticThinking(level);
    setSaving(true);
    try {
      const ok = await configureAgentRuntime(agentId || "main", { thinking_level: level });
      if (ok) {
        setCatalog((prev) => (prev ? { ...prev, current_thinking: level } : prev));
      } else {
        setOptimisticThinking("");
      }
    } finally {
      setSaving(false);
    }
  };

  const effortTag = EFFORT_LABELS[effectiveThinking] || effectiveThinking;
  const modelBrandKey = resolveBrandKey(effectiveModel);
  const providerBrandKey = resolveBrandKey(catalog?.provider);
  const brandHint =
    (modelBrandKey && modelBrandKey !== "ucode" && modelBrandKey !== "ufoo" ? effectiveModel : "") ||
    (providerBrandKey && providerBrandKey !== "ucode" && providerBrandKey !== "ufoo" ? catalog?.provider : "") ||
    (agentType === "main" ? state.settings.agent_provider : "") ||
    catalog?.provider ||
    effectiveModel ||
    agentType;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Model & Thinking Effort (${effectiveModel} · ${effortTag})`}
        className={`inline-flex min-w-0 overflow-hidden items-center gap-1.5 rounded-lg px-1.5 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100 transition-colors cursor-pointer ${
          compact ? "max-w-[175px]" : "max-w-[240px]"
        }`}
      >
        <BrandIcon brand={brandHint} size={13} />
        <span className="truncate font-mono">{effectiveModel}</span>
        <span className="shrink-0 text-zinc-500">{effortTag}</span>
      </button>

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            style={popoverStyle}
            className="fixed z-50 overflow-hidden rounded-xl border border-white/[0.11] bg-[#141417] shadow-2xl"
          >
            {/* Model Section */}
            <div className="p-2">
              <div className="flex items-center justify-between px-1.5 pb-1.5">
                <span className="text-[10.5px] font-medium text-zinc-500">Model</span>
                {catalog?.provider && (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-zinc-500">
                    <BrandIcon brand={catalog.provider} size={12} />
                    <span>{catalog.provider}</span>
                  </span>
                )}
              </div>

              {(catalog?.models?.length || 0) > 7 && (
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter models…"
                  className="mb-1.5 w-full rounded-lg border border-white/[0.08] bg-zinc-950 px-2.5 py-1 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-500 focus:border-blue-500/45 focus:outline-none"
                />
              )}

              <div ref={listRef} className="max-h-72 overflow-y-auto space-y-0.5">
                {loading && models.length === 0 ? (
                  <div className="px-2.5 py-3 text-center text-[12px] text-zinc-500">
                    Loading models…
                  </div>
                ) : models.length === 0 ? (
                  <div className="px-2.5 py-2.5 text-[12px] text-zinc-500">
                    No preset models reported
                  </div>
                ) : (
                  models.map((m) => {
                    const selected = m === effectiveModel;
                    return (
                      <button
                        key={m}
                        ref={selected ? selectedItemRef : undefined}
                        type="button"
                        disabled={saving}
                        onClick={() => void handleSelectModel(m)}
                        className={`flex min-h-[36px] w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left font-mono text-[12px] leading-snug transition-colors cursor-pointer ${
                          selected
                            ? "bg-white/[0.1] text-white"
                            : "text-zinc-200 hover:bg-white/[0.06] hover:text-white"
                        }`}
                      >
                        <span className="truncate">{m}</span>
                        {selected && <Check size={12} weight="bold" className="shrink-0 text-blue-400" />}
                      </button>
                    );
                  })
                )}
              </div>

              {catalog?.allow_custom && (
                <div className="mt-2 flex items-center gap-1.5 border-t border-white/[0.06] pt-2">
                  <input
                    type="text"
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && customModel.trim()) {
                        e.preventDefault();
                        void handleSelectModel(customModel);
                        setCustomModel("");
                      }
                    }}
                    placeholder="Custom model ID…"
                    className="flex-1 min-w-0 rounded-md border border-white/[0.08] bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-500 focus:border-blue-500/45 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={!customModel.trim() || saving}
                    onClick={() => {
                      void handleSelectModel(customModel);
                      setCustomModel("");
                    }}
                    className="shrink-0 rounded-md bg-white/[0.08] px-2 py-1 text-[11px] text-zinc-200 hover:bg-blue-600 hover:text-white disabled:opacity-40 cursor-pointer"
                  >
                    Use
                  </button>
                </div>
              )}
            </div>

            {/* Thinking Effort Section inside the same unified popover */}
            <div className="border-t border-white/[0.07] bg-zinc-950/70 p-2.5 space-y-1.5">
              <div className="flex items-center justify-between px-0.5 text-[10.5px]">
                <span className="font-medium text-zinc-500">Thinking Effort</span>
                <span className="font-mono text-zinc-400">{effortTag}</span>
              </div>
              <div className="flex items-center gap-1 rounded-lg border border-white/[0.07] bg-zinc-900 p-0.5">
                {thinkingLevels.map((lvl) => {
                  const active = effectiveThinking === lvl;
                  return (
                    <button
                      key={lvl}
                      type="button"
                      disabled={saving}
                      onClick={() => void handleSelectThinking(lvl)}
                      className={`flex-1 rounded-md py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                        active
                          ? "bg-white/[0.14] text-white"
                          : "text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      {EFFORT_LABELS[lvl] || lvl}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

const PERMISSION_OPTIONS: ReadonlyArray<{
  id: PermissionMode;
  label: string;
  desc: string;
  isDefault?: boolean;
  Icon: typeof Shield;
}> = [
  {
    id: "supervised",
    label: "Supervised",
    desc: "Ask before file edits and commands.",
    Icon: LockSimple,
  },
  {
    id: "auto_edit",
    label: "Auto-Edit",
    desc: "Allow file edits; ask before risky commands.",
    isDefault: true,
    Icon: Shield,
  },
  {
    id: "full_access",
    label: "Full Access",
    desc: "Run edits and commands without prompts.",
    Icon: ShieldWarning,
  },
];

export function PermissionPicker({
  agentId = "",
  value = "auto_edit",
  align = "right",
}: {
  agentId?: string;
  value?: PermissionMode | string;
  align?: "left" | "right";
}) {
  const { setPermissionMode } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [optimistic, setOptimistic] = useState<PermissionMode | "">("");
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const normalized = (optimistic || value || "auto_edit") as PermissionMode;
  const current = PERMISSION_OPTIONS.find((o) => o.id === normalized) || PERMISSION_OPTIONS[1];
  const CurrentIcon = current.Icon;

  useEffect(() => {
    setOptimistic("");
  }, [value, agentId]);

  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => setPopoverStyle(computeUpwardPopoverStyle(triggerRef.current, 288, align));
    reposition();
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const handleSelect = async (mode: PermissionMode) => {
    setOpen(false);
    if (mode === current.id) return;
    setOptimistic(mode);
    await setPermissionMode(mode, agentId);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Permission mode: ${current.label}`}
        aria-expanded={open}
        title={`Permission: ${current.label} — ${current.desc}`}
        className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors cursor-pointer ${
          open
            ? "bg-white/[0.1] text-zinc-100"
            : "text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100"
        }`}
      >
        <CurrentIcon size={15} />
      </button>

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            style={popoverStyle}
            className="fixed z-50 overflow-hidden rounded-2xl border border-white/[0.1] bg-[#141417] p-1.5 shadow-2xl"
          >
            <div className="px-2.5 pt-1 pb-1.5 text-[11px] font-medium text-zinc-500">
              This Conversation
            </div>
            <div className="space-y-0.5">
              {PERMISSION_OPTIONS.map((opt) => {
                const active = opt.id === current.id;
                const OptionIcon = opt.Icon;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => void handleSelect(opt.id)}
                    className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors cursor-pointer ${
                      active ? "bg-white/[0.08] text-white" : "text-zinc-200 hover:bg-white/[0.05]"
                    }`}
                  >
                    <OptionIcon size={16} className="shrink-0 text-zinc-400" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[12.5px] font-medium leading-tight">
                        <span>{opt.label}</span>
                        {opt.isDefault && (
                          <span className="rounded-full bg-white/[0.07] px-1.5 py-0.5 text-[10px] font-normal text-zinc-400">
                            Default
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-[11px] leading-snug text-zinc-500">
                        {opt.desc}
                      </div>
                    </div>
                    {active && <Check size={14} weight="bold" className="shrink-0 text-zinc-100" />}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowsLeftRight,
  ArrowUp,
  ArrowsOutSimple,
  BellSimple,
  Paperclip,
  Plus,
} from "@phosphor-icons/react";
import { useWorkspace } from "../store/workspaceStore";
import { isTauriEnvironment, ufooBridge } from "../bridge/ufooClient";
import type {
  ComposerAttachment,
  PendingInteraction,
  PermissionMode,
  QueuedMessageItem,
  WindowMode,
  WorkflowEdge,
  WorkflowNodeGeometry,
  WorkerSummary,
} from "../types";
import { TranscriptStream } from "./TranscriptStream";
import { BackgroundTaskStrip } from "./BackgroundTaskStrip";
import { QueuedMessagesTray } from "./QueuedMessagesTray";
import { AskInteractionDock } from "./AskInteractionDock";
import { ModelEffortPicker, PermissionPicker } from "./ModelEffortPicker";
import { BrandIcon, buildProjectUcodeColorMap } from "./BrandIcon";
import { LayoutModeIcon, LeftSidebarIcon, NavBackIcon, NavForwardIcon, RightSidebarIcon } from "./WindowChromeIcons";
import { MultiWorkflowCanvas } from "./MultiWorkflowCanvas";
import {
  ComposerCommandMenu,
  resolveComposerMenu,
  type ComposerMenuItem,
} from "./ComposerCommandMenu";
import {
  AttachmentStrip,
  DropFilesOverlay,
  readFileAsUpload,
  useTauriFileDrop,
} from "./AttachmentStrip";

const LAYOUT_LABELS: Record<WindowMode, string> = {
  main: "Main",
  side: "Side",
  multi: "Multi",
};

function ComposerActionButton({
  hasContent,
  busy,
  onSend,
  onStop,
}: {
  hasContent: boolean;
  busy: boolean;
  onSend: () => void;
  onStop: () => void;
}) {
  const showStop = Boolean(busy && !hasContent);
  const disabled = !showStop && !hasContent;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={showStop ? onStop : onSend}
      title={showStop ? "Stop current turn" : busy ? "Queue follow-up (Enter) · ⌥⏎ to send now" : "Send"}
      aria-label={showStop ? "Stop current turn" : busy ? "Queue follow-up" : "Send"}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border backdrop-blur-md transition-all ${
        showStop
          ? "border-rose-400/28 bg-gradient-to-b from-rose-500/28 to-rose-800/35 text-rose-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),inset_0_-1px_0_rgba(0,0,0,0.28),0_2px_8px_rgba(0,0,0,0.35)] hover:border-rose-400/45 hover:from-rose-500/38 hover:to-rose-800/45 hover:text-rose-100 active:scale-95 cursor-pointer"
          : hasContent
          ? "border-blue-300/35 bg-gradient-to-b from-blue-500/90 to-blue-600/95 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.32),inset_0_-1px_0_rgba(0,0,0,0.22),0_2px_8px_rgba(37,99,235,0.28)] hover:from-blue-400/95 hover:to-blue-600 active:scale-95 cursor-pointer"
          : "border-white/[0.09] bg-white/[0.045] text-zinc-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.07)] cursor-default"
      }`}
    >
      {showStop ? (
        <span
          aria-hidden="true"
          className="h-[9px] w-[9px] rounded-[2px] bg-rose-200/95 shadow-[0_1px_2px_rgba(0,0,0,0.35)]"
        />
      ) : (
        <ArrowUp size={14} weight="bold" />
      )}
    </button>
  );
}

function LayoutModeCycleButton({
  mode,
  onSwitchMode,
}: {
  mode: WindowMode;
  onSwitchMode: (next: WindowMode) => void;
}) {
  const [displayMode, setDisplayMode] = useState<WindowMode>(mode);
  const [spinKey, setSpinKey] = useState(0);
  const swapTimerRef = useRef<number | null>(null);
  const spinningRef = useRef(false);

  useEffect(() => {
    if (!spinningRef.current) {
      setDisplayMode(mode);
    }
  }, [mode]);

  useEffect(() => {
    return () => {
      if (swapTimerRef.current !== null) window.clearTimeout(swapTimerRef.current);
    };
  }, []);

  const handleClick = () => {
    const base = spinningRef.current ? displayMode : mode;
    const next: WindowMode = base === "main" ? "side" : base === "side" ? "multi" : "main";
    if (swapTimerRef.current !== null) window.clearTimeout(swapTimerRef.current);
    spinningRef.current = true;
    setSpinKey((k) => k + 1);
    swapTimerRef.current = window.setTimeout(() => {
      setDisplayMode(next);
      onSwitchMode(next);
      swapTimerRef.current = window.setTimeout(() => {
        spinningRef.current = false;
        swapTimerRef.current = null;
      }, 200);
    }, 150);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={`Layout: ${LAYOUT_LABELS[displayMode]} — Click to switch (⌘W)`}
      aria-label={`Layout: ${LAYOUT_LABELS[displayMode]}`}
      className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 transition-colors cursor-pointer"
    >
      <span
        key={spinKey}
        className={`inline-flex items-center justify-center ${spinKey > 0 ? "animate-layout-spin" : ""}`}
      >
        <LayoutModeIcon mode={displayMode} />
      </span>
    </button>
  );
}

function WorkerComposer({
  agentId,
  agentType = "worker",
  label,
  model = "",
  thinkingLevel = "medium",
  permissionMode = "auto_edit",
  busy,
  external = false,
  compact = false,
  pendingInteraction = null,
  onOpenFile,
}: {
  agentId: string;
  agentType?: string;
  label: string;
  model?: string;
  thinkingLevel?: string;
  permissionMode?: PermissionMode | string;
  busy?: boolean;
  external?: boolean;
  compact?: boolean;
  pendingInteraction?: PendingInteraction | null;
  onOpenFile?: (path: string) => void;
}) {
  const {
    state,
    dispatch,
    submitWorkerInput,
    removeQueuedMessage,
    clearQueuedMessages,
    sendQueuedMessageNow,
    stageAttachments,
    cancelWorkerTurn,
  } = useWorkspace();
  const draft = state.localPaneDrafts[agentId]?.text ?? "";
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [stagingFiles, setStagingFiles] = useState(false);
  const [htmlDragging, setHtmlDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const workerQueue = !external
    ? state.queuedMessages.workers[agentId] || { items: [], paused: false }
    : { items: [], paused: false };

  useEffect(() => {
    setAttachments([]);
  }, [agentId, state.activeRoot]);

  const attachPaths = async (paths: string[]) => {
    if (!paths.length) return;
    setStagingFiles(true);
    try {
      const staged = await stageAttachments({ paths });
      if (staged.length > 0) setAttachments((prev) => [...prev, ...staged]);
    } finally {
      setStagingFiles(false);
    }
  };

  const attachFileList = async (files: FileList | File[]) => {
    const arr = Array.from(files || []);
    if (arr.length === 0) return;
    setStagingFiles(true);
    try {
      const uploads = await Promise.all(arr.map(readFileAsUpload));
      const staged = await stageAttachments({ uploads });
      if (staged.length > 0) setAttachments((prev) => [...prev, ...staged]);
    } finally {
      setStagingFiles(false);
    }
  };

  const { isTauriDragging } = useTauriFileDrop({
    enabled: true,
    onDropPaths: (paths) => void attachPaths(paths),
  });

  const handleChange = (next: string) => {
    dispatch({ type: "UPDATE_LOCAL_PANE_DRAFT", agentId, text: next });
    // Keep Node host draft revision synchronized across Side <-> Single views
    const rev = (state.localPaneDrafts[agentId]?.rev || 0) + 1;
    void ufooBridge.sendCommand("multi.raw", {
      agent_id: agentId,
      input: next,
      cursor: next.length,
      input_revision: rev,
      submit: false,
    });
  };

  const handleSubmit = async (forceSend = false) => {
    const trimmed = draft.trim();
    if (!trimmed && attachments.length === 0) return;
    const pendingAttachments = attachments;
    setAttachments([]);
    await submitWorkerInput(agentId, trimmed, pendingAttachments, {
      forceSend: forceSend || Boolean(pendingInteraction),
    });
  };

  const handleInteractionOptionRespond = async (answer: string) => {
    const trimmed = String(answer || "").trim();
    if (!trimmed) return;
    await submitWorkerInput(agentId, trimmed, [], { forceSend: true });
  };

  const interactionKind = String(pendingInteraction?.kind || "").toLowerCase();
  const hasChoiceOptions =
    Boolean(pendingInteraction) &&
    interactionKind !== "approval" &&
    Array.isArray(pendingInteraction?.options) &&
    pendingInteraction!.options!.length > 0;
  const composerRingClass = pendingInteraction
    ? interactionKind === "approval"
      ? "border-amber-400/30 focus-within:border-amber-400/50"
      : "border-sky-400/30 focus-within:border-sky-400/50"
    : "border-white/[0.09] focus-within:border-white/[0.2]";

  const handleEditQueued = async (item: QueuedMessageItem) => {
    const removed = await removeQueuedMessage("worker", item.id, agentId);
    if (!removed) return;
    const nextText = draft.trim()
      ? `${removed.text}\n${draft}`
      : removed.text;
    handleChange(nextText);
    if (Array.isArray(removed.attachments) && removed.attachments.length > 0) {
      setAttachments((prev) => [...removed.attachments, ...prev]);
    }
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextText.length, nextText.length);
    });
  };

  return (
    <div className={`${compact ? "px-3 pb-3 pt-1" : "px-3 pb-2.5 md:px-5 md:pb-4 pt-1"} bg-transparent`}>
      <AskInteractionDock
        interaction={pendingInteraction}
        compact={compact}
        canDismiss={false}
        onRespond={(ans) => handleInteractionOptionRespond(ans)}
        onFocusInput={() => textareaRef.current?.focus()}
        onOpenFile={onOpenFile}
      />
      <QueuedMessagesTray
        items={workerQueue.items}
        paused={workerQueue.paused}
        busy={Boolean(busy && !external)}
        compact={compact}
        onSendNow={(id) => void sendQueuedMessageNow("worker", id, agentId)}
        onEdit={(item) => void handleEditQueued(item)}
        onRemove={(id) => void removeQueuedMessage("worker", id, agentId)}
        onClearAll={() => void clearQueuedMessages("worker", agentId)}
      />
      <div
        onDragOver={(e) => {
          if (e.dataTransfer?.types?.includes("Files")) {
            e.preventDefault();
            setHtmlDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setHtmlDragging(false);
          }
        }}
        onDrop={(e) => {
          setHtmlDragging(false);
          if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
            e.preventDefault();
            void attachFileList(e.dataTransfer.files);
          }
        }}
        className={`relative ${compact ? "" : "mx-auto max-w-3xl"} rounded-2xl border ${composerRingClass} bg-zinc-900/90 p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] transition-colors`}
      >
        <DropFilesOverlay visible={isTauriDragging || htmlDragging} />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              void attachFileList(e.target.files);
            }
            e.target.value = "";
          }}
        />
        <AttachmentStrip
          attachments={attachments}
          staging={stagingFiles}
          onRemove={(id) => setAttachments((prev) => prev.filter((item) => item.id !== id))}
        />
        <textarea
          ref={textareaRef}
          rows={compact ? 2 : 3}
          value={draft}
          onChange={(e) => handleChange(e.target.value)}
          onPaste={(e) => {
            const pastedFiles = Array.from(e.clipboardData?.files || []);
            if (pastedFiles.length > 0) {
              e.preventDefault();
              void attachFileList(pastedFiles);
            }
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSubmit(Boolean(e.altKey));
            }
          }}
          placeholder={
            pendingInteraction
              ? hasChoiceOptions
                ? `Or type a custom reply for ${label}…`
                : interactionKind === "approval"
                ? `Optional note or instructions for ${label}…`
                : `Reply to ${label}'s question…`
              : external
              ? `Send bus message to @${label}…`
              : busy
              ? `Queue a follow-up for ${label}… (Enter to queue, ⌥⏎ to send now)`
              : `Message ${label} directly, or drop images & files…`
          }
          className="chat-composer-input w-full resize-none bg-transparent px-2 py-1 text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
        />
        <div className="mt-1.5 flex flex-nowrap items-center justify-between gap-1.5 px-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Attach images or files"
              aria-label="Attach images or files"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 transition-colors cursor-pointer"
            >
              <Paperclip size={14} />
            </button>
            {external ? (
              <span className="font-mono text-[11px] text-zinc-500 truncate">
                @{label} · bus delivery
              </span>
            ) : (
              <ModelEffortPicker
                agentId={agentId}
                agentType={agentType}
                currentModel={model}
                currentThinking={thinkingLevel}
                compact={compact}
              />
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {!external && (
              <PermissionPicker
                agentId={agentId}
                value={permissionMode}
                align="right"
              />
            )}
            <ComposerActionButton
              hasContent={Boolean(draft.trim() || attachments.length > 0)}
              busy={Boolean(busy && !external)}
              onSend={() => void handleSubmit()}
              onStop={() => void cancelWorkerTurn(agentId)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function MainComposer({
  workers,
  workerColorMap,
}: {
  workers: WorkerSummary[];
  workerColorMap: Record<string, string>;
}) {
  const {
    state,
    dispatch,
    submitMainInput,
    submitWorkerInput,
    removeQueuedMessage,
    clearQueuedMessages,
    sendQueuedMessageNow,
    stageAttachments,
    cancelWorkerTurn,
    respondInteraction,
    openDocInInspector,
    setWindowMode,
    notifyToast,
  } = useWorkspace();
  const draftKey = `main:${state.activeRoot}`;
  const input = state.localPaneDrafts[draftKey]?.text || "";
  const setInput = (text: string) => dispatch({ type: "UPDATE_LOCAL_PANE_DRAFT", agentId: draftKey, text });
  const [cursorPos, setCursorPos] = useState(0);
  const [activeMenuIndex, setActiveMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [stagingFiles, setStagingFiles] = useState(false);
  const [htmlDragging, setHtmlDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerBoxRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const leftCoreRef = useRef<HTMLDivElement>(null);
  const rightGroupRef = useRef<HTMLDivElement>(null);
  const commandsBtnRef = useRef<HTMLButtonElement>(null);
  const newSessionBtnRef = useRef<HTMLButtonElement>(null);
  const commandsWidthRef = useRef<number>(84);
  const newSessionWidthRef = useRef<number>(86);
  const [showCommandsBtn, setShowCommandsBtn] = useState(true);
  const [showNewSessionBtn, setShowNewSessionBtn] = useState(true);

  useEffect(() => {
    setAttachments([]);
  }, [state.activeRoot]);

  const attachPaths = async (paths: string[]) => {
    if (!paths.length) return;
    setStagingFiles(true);
    try {
      const staged = await stageAttachments({ paths });
      if (staged.length > 0) setAttachments((prev) => [...prev, ...staged]);
    } finally {
      setStagingFiles(false);
    }
  };

  const attachFileList = async (files: FileList | File[]) => {
    const arr = Array.from(files || []);
    if (arr.length === 0) return;
    setStagingFiles(true);
    try {
      const uploads = await Promise.all(arr.map(readFileAsUpload));
      const staged = await stageAttachments({ uploads });
      if (staged.length > 0) setAttachments((prev) => [...prev, ...staged]);
    } finally {
      setStagingFiles(false);
    }
  };

  const { isTauriDragging } = useTauriFileDrop({
    enabled: true,
    onDropPaths: (paths) => void attachPaths(paths),
  });

  const targetedWorker = useMemo(
    () => (state.targetAgent ? workers.find((w) => w.id === state.targetAgent) || null : null),
    [state.targetAgent, workers]
  );

  // If the previously targeted worker disappeared (archived/deleted), fall back cleanly to ufoo
  useEffect(() => {
    if (state.targetAgent && !targetedWorker) {
      dispatch({ type: "SET_TARGET_AGENT", agentId: "", prefix: "› " });
      void ufooBridge.sendCommand("agent.select", { agent_id: "" });
    }
  }, [state.targetAgent, targetedWorker, dispatch]);

  const menu = useMemo(
    () =>
      resolveComposerMenu({
        input,
        cursor: cursorPos,
        workers,
        workerColorMap,
        backendCompletions: state.completions,
        backendCompletionsText: state.completionsText,
        dismissed: menuDismissed,
        scope: state.scope,
      }),
    [input, cursorPos, workers, workerColorMap, state.completions, state.completionsText, menuDismissed, state.scope]
  );

  // Keep activeMenuIndex clamped whenever menu items change
  useEffect(() => {
    setActiveMenuIndex(0);
  }, [input, menu.mode, menu.items.length]);

  // Dismiss popover when clicking outside the composer container
  useEffect(() => {
    if (menu.mode === "none" || menu.mode === "arg_hint") return;
    const onPointerDownOutside = (e: MouseEvent) => {
      if (!composerBoxRef.current?.contains(e.target as Node)) {
        setMenuDismissed(true);
      }
    };
    window.addEventListener("mousedown", onPointerDownOutside);
    return () => window.removeEventListener("mousedown", onPointerDownOutside);
  }, [menu.mode]);

  // Fetch dynamic completions from backend when navigating into dynamic commands
  const requestDynamicCompletionsIfNeeded = (nextVal: string) => {
    const trimmed = nextVal.trimStart();
    if (!trimmed.startsWith("/")) {
      if (state.completions.length > 0) dispatch({ type: "CLEAR_COMPLETIONS" });
      return;
    }
    const isDynamicCommand = /^\/(resume|model|group\s+run|solo\s+run|settings\s+agent\s+(?:model|thinking))(?:\s|$)/i.test(
      trimmed
    );
    if (isDynamicCommand) {
      void ufooBridge.sendCommand("completion.request", { text: nextVal });
    }
  };

  const focusTextareaAt = (pos: number) => {
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const applyInputProgrammatically = (nextVal: string, nextCursor = nextVal.length) => {
    setInput(nextVal);
    setCursorPos(nextCursor);
    setMenuDismissed(false);
    setActiveMenuIndex(0);
    requestDynamicCompletionsIfNeeded(nextVal);
    focusTextareaAt(nextCursor);
  };

  const handleTextChange = (val: string, selPos?: number) => {
    setInput(val);
    setCursorPos(selPos ?? val.length);
    setMenuDismissed(false);
    requestDynamicCompletionsIfNeeded(val);
  };

  const runSlashCommand = async (rawCmd: string) => {
    const cmd = rawCmd.trim();
    if (!cmd) return;
    if (cmd === "/clear") {
      const res = await ufooBridge.sendCommand<{ ok?: boolean; error?: string }>("chat.clear", {});
      if (res?.ok) notifyToast("Cleared conversation");
      else if (res?.error) notifyToast(res.error);
      return;
    }
    if (cmd === "/window main" || cmd === "/window side" || cmd === "/window multi") {
      const mode = cmd.split(/\s+/)[1] as WindowMode;
      await setWindowMode(mode);
      return;
    }
    if (cmd === "/session new") {
      await submitMainInput("/session new");
      notifyToast("Started fresh ufoo conversation");
      return;
    }
    await submitMainInput(cmd);
  };

  const handleSelectMenuItem = (item: ComposerMenuItem, mode: "primary" | "fillOnly") => {
    if (item.action === "mention" && menu.mentionRange) {
      const before = input.slice(0, menu.mentionRange.start);
      const after = input.slice(menu.mentionRange.end);
      const next = `${before}${item.replace}${after}`;
      const nextPos = before.length + item.replace.length;
      applyInputProgrammatically(next, nextPos);
      return;
    }

    if (item.action === "execute" && mode === "primary") {
      setInput("");
      setCursorPos(0);
      setMenuDismissed(false);
      dispatch({ type: "CLEAR_COMPLETIONS" });
      void runSlashCommand(item.command);
      focusTextareaAt(0);
      return;
    }

    // Drill into submenu, fill argument command, or Tab-fill leaf command
    const nextText = item.replace.endsWith(" ") ? item.replace : `${item.replace} `;
    applyInputProgrammatically(nextText, nextText.length);
  };

  const isTargetedSideInternal = Boolean(
    targetedWorker &&
      targetedWorker.internal &&
      (state.windowMode === "side" || state.windowMode === "multi")
  );
  const activeQueueScope: "main" | "worker" = isTargetedSideInternal ? "worker" : "main";
  const activeQueueAgentId = isTargetedSideInternal && targetedWorker ? targetedWorker.id : "";
  const activeQueue = !targetedWorker
    ? state.queuedMessages.main
    : isTargetedSideInternal && targetedWorker
    ? state.queuedMessages.workers[targetedWorker.id] || { items: [], paused: false }
    : { items: [], paused: false };

  const activePendingInteraction: PendingInteraction | null = !targetedWorker
    ? state.pendingInteraction
    : isTargetedSideInternal && targetedWorker
    ? state.paneFrames[targetedWorker.id]?.pending_interaction || null
    : null;
  const activeInteractionKind = String(activePendingInteraction?.kind || "").toLowerCase();
  const activeInteractionIsChoice =
    Boolean(activePendingInteraction) &&
    activeInteractionKind !== "approval" &&
    Array.isArray(activePendingInteraction?.options) &&
    activePendingInteraction!.options!.length > 0;
  const mainComposerRingClass = activePendingInteraction
    ? activeInteractionKind === "approval"
      ? "border-amber-400/30 focus-within:border-amber-400/50"
      : "border-sky-400/30 focus-within:border-sky-400/50"
    : "border-white/[0.09] focus-within:border-white/[0.2]";

  const handleDockInteractionRespond = async (
    answer: string,
    cancelled = false,
    dismissAll = false
  ) => {
    if (isTargetedSideInternal && targetedWorker) {
      const trimmed = String(answer || "").trim();
      if (!trimmed) return;
      await submitWorkerInput(targetedWorker.id, trimmed, [], { forceSend: true });
      return;
    }
    if (!state.pendingInteraction && !dismissAll) return;
    await respondInteraction(state.pendingInteraction?.id || "", answer, cancelled, dismissAll);
  };

  const handleSend = async (forceSend = false) => {
    const trimmed = input.trim();
    if (!trimmed && attachments.length === 0) return;
    const pendingAttachments = attachments;
    setInput("");
    setCursorPos(0);
    setAttachments([]);
    setMenuDismissed(false);
    dispatch({ type: "CLEAR_COMPLETIONS" });
    if (trimmed.startsWith("/")) {
      await runSlashCommand(trimmed);
      return;
    }
    if (isTargetedSideInternal && targetedWorker) {
      await submitWorkerInput(targetedWorker.id, trimmed, pendingAttachments, {
        forceSend: forceSend || Boolean(activePendingInteraction),
      });
      return;
    }
    if (
      !targetedWorker &&
      state.pendingInteraction &&
      state.pendingInteraction.allowFreeChat !== false &&
      pendingAttachments.length === 0
    ) {
      await respondInteraction(state.pendingInteraction.id, trimmed, false, false);
      return;
    }
    await submitMainInput(trimmed, pendingAttachments, { forceSend });
  };

  const handleEditQueued = async (item: QueuedMessageItem) => {
    const removed = await removeQueuedMessage(activeQueueScope, item.id, activeQueueAgentId);
    if (!removed) return;
    const nextText = input.trim()
      ? `${removed.text}\n${input}`
      : removed.text;
    applyInputProgrammatically(nextText, nextText.length);
    if (Array.isArray(removed.attachments) && removed.attachments.length > 0) {
      setAttachments((prev) => [...removed.attachments, ...prev]);
    }
  };

  const handleNewConversation = async () => {
    await submitMainInput("/session new");
    notifyToast("Started fresh ufoo conversation");
  };

  const handleToggleCommandMenu = () => {
    if (menu.mode === "commands" && input.trim() === "/") {
      setInput("");
      setCursorPos(0);
      setMenuDismissed(false);
      focusTextareaAt(0);
      return;
    }
    if (!input.trimStart().startsWith("/")) {
      applyInputProgrammatically("/", 1);
      return;
    }
    setMenuDismissed((prev) => !prev);
    focusTextareaAt(input.length);
  };

  const targetBusy = targetedWorker
    ? Boolean(
        targetedWorker.internal &&
          (state.paneFrames[targetedWorker.id]?.busy || targetedWorker.activity_state === "working")
      )
    : state.busy;

  useLayoutEffect(() => {
    const toolbarEl = toolbarRef.current;
    const leftCoreEl = leftCoreRef.current;
    const rightEl = rightGroupRef.current;
    if (!toolbarEl || !leftCoreEl || !rightEl) return;

    const measureTextSpanWidth = (el: HTMLElement): number => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return Math.ceil(Math.max(range.getBoundingClientRect().width, el.scrollWidth));
    };

    const measureLeftCoreNaturalWidth = (coreEl: HTMLElement): number => {
      const coreStyle = window.getComputedStyle(coreEl);
      const coreGap = parseFloat(coreStyle.columnGap) || parseFloat(coreStyle.gap) || 6;
      const children = Array.from(coreEl.children) as HTMLElement[];
      let total = 0;
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        let w = Math.ceil(child.getBoundingClientRect().width);
        if (i === 1) {
          if (child.childElementCount > 0) {
            const cs = window.getComputedStyle(child);
            const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
            const border = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
            const gap = parseFloat(cs.columnGap) || parseFloat(cs.gap) || 6;
            const grandkids = Array.from(child.children) as HTMLElement[];
            let inner = pad + border;
            for (let j = 0; j < grandkids.length; j += 1) {
              const gk = grandkids[j];
              const isTextLeaf = gk.tagName === "SPAN" && gk.childElementCount === 0 && Boolean(gk.textContent?.trim());
              inner += isTextLeaf ? measureTextSpanWidth(gk) : Math.ceil(gk.getBoundingClientRect().width);
              if (j > 0) inner += gap;
            }
            const maxW = parseFloat(cs.maxWidth);
            w = Number.isFinite(maxW) && maxW > 0 ? Math.min(Math.ceil(inner), maxW) : Math.ceil(inner);
          } else if (child.textContent?.trim()) {
            w = Math.min(measureTextSpanWidth(child), 240);
          }
        }
        total += w;
        if (i > 0) total += coreGap;
      }
      return Math.ceil(total);
    };

    const recompute = () => {
      if (commandsBtnRef.current) {
        const w = Math.ceil(commandsBtnRef.current.getBoundingClientRect().width);
        if (w > 0) commandsWidthRef.current = w;
      }
      if (newSessionBtnRef.current) {
        const w = Math.ceil(newSessionBtnRef.current.getBoundingClientRect().width);
        if (w > 0) newSessionWidthRef.current = w;
      }

      const style = window.getComputedStyle(toolbarEl);
      const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const toolbarW = Math.floor(toolbarEl.getBoundingClientRect().width - padX);
      if (toolbarW <= 0) return;

      const rightW = Math.ceil(rightEl.getBoundingClientRect().width);
      const leftCoreNeed = measureLeftCoreNaturalWidth(leftCoreEl);

      const GAP = 6;
      const OUTER_GAP = 8;
      const BUFFER = 6;
      const availableForExtras = toolbarW - rightW - OUTER_GAP - leftCoreNeed - BUFFER;

      const cmdNeed = GAP + commandsWidthRef.current;
      const newSessNeed = cmdNeed + GAP + newSessionWidthRef.current;

      const nextShowCommands = availableForExtras >= cmdNeed;
      const nextShowNewSession = !targetedWorker && nextShowCommands && availableForExtras >= newSessNeed;

      setShowCommandsBtn((prev) => (prev === nextShowCommands ? prev : nextShowCommands));
      setShowNewSessionBtn((prev) => (prev === nextShowNewSession ? prev : nextShowNewSession));
    };

    recompute();
    const rafId = window.requestAnimationFrame(recompute);
    const observer = new ResizeObserver(recompute);
    observer.observe(toolbarEl);
    observer.observe(rightEl);
    return () => {
      window.cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [
    targetedWorker,
    targetedWorker?.model,
    targetedWorker?.thinking_level,
    targetedWorker?.permission_mode,
    targetBusy,
    state.scope,
    state.windowMode,
    state.leftSidebarOpen,
    state.rightInspectorOpen,
    state.settings.agent_model,
    state.settings.agent_thinking,
    state.settings.permission_mode,
  ]);

  const isMenuInteractive = (menu.mode === "commands" || menu.mode === "mentions") && menu.items.length > 0;
  const clampedMenuIndex = isMenuInteractive
    ? Math.max(0, Math.min(activeMenuIndex, menu.items.length - 1))
    : 0;

  return (
    <div className="bg-[#0c0c0e] px-3 pb-2.5 md:px-5 md:pb-4 pt-1">
      <div ref={composerBoxRef} className="relative mx-auto max-w-3xl">
        {/* Friendly Desktop Command & @Mention Palette */}
        {state.scope === "project" && !targetedWorker && <BackgroundTaskStrip key={state.activeRoot} tasks={state.backgroundTasks} />}
        <ComposerCommandMenu
          menu={menu}
          activeIndex={clampedMenuIndex}
          onHoverIndex={setActiveMenuIndex}
          onSelectItem={handleSelectMenuItem}
          onNavigateBreadcrumb={(targetInput) => applyInputProgrammatically(targetInput, targetInput.length)}
          onDismiss={() => {
            if (input.trim() === "/") {
              setInput("");
              setCursorPos(0);
            } else {
              setMenuDismissed(true);
            }
          }}
        />

        {/* Pending ask / choice / approval card docked directly above composer */}
        <AskInteractionDock
          interaction={activePendingInteraction}
          sourceLabel={isTargetedSideInternal && targetedWorker ? targetedWorker.label : ""}
          canDismiss={!isTargetedSideInternal}
          onRespond={(ans, cancelled, dismissAll) =>
            handleDockInteractionRespond(ans, cancelled, dismissAll)
          }
          onFocusInput={() => textareaRef.current?.focus()}
          onOpenFile={(p) => void openDocInInspector(p)}
        />

        {/* Queued follow-up messages tray (docked seamlessly above composer) */}
        <QueuedMessagesTray
          items={activeQueue.items}
          paused={activeQueue.paused}
          busy={Boolean(targetBusy)}
          onSendNow={(id) => void sendQueuedMessageNow(activeQueueScope, id, activeQueueAgentId)}
          onEdit={(item) => void handleEditQueued(item)}
          onRemove={(id) => void removeQueuedMessage(activeQueueScope, id, activeQueueAgentId)}
          onClearAll={() => void clearQueuedMessages(activeQueueScope, activeQueueAgentId)}
        />

        <div
          onDragOver={(e) => {
            if (e.dataTransfer?.types?.includes("Files")) {
              e.preventDefault();
              setHtmlDragging(true);
            }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setHtmlDragging(false);
            }
          }}
          onDrop={(e) => {
            setHtmlDragging(false);
            if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
              e.preventDefault();
              void attachFileList(e.dataTransfer.files);
            }
          }}
          className={`relative rounded-2xl border ${mainComposerRingClass} bg-zinc-900/90 p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-colors`}
        >
          <DropFilesOverlay visible={isTauriDragging || htmlDragging} />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                void attachFileList(e.target.files);
              }
              e.target.value = "";
            }}
          />
          <AttachmentStrip
            attachments={attachments}
            staging={stagingFiles}
            onRemove={(id) => setAttachments((prev) => prev.filter((item) => item.id !== id))}
          />
          <textarea
            ref={textareaRef}
            rows={3}
            value={input}
            onChange={(e) => handleTextChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onClick={(e) => setCursorPos(e.currentTarget.selectionStart ?? input.length)}
            onKeyUp={(e) => setCursorPos(e.currentTarget.selectionStart ?? input.length)}
            onPaste={(e) => {
              const pastedFiles = Array.from(e.clipboardData?.files || []);
              if (pastedFiles.length > 0) {
                e.preventDefault();
                void attachFileList(pastedFiles);
              }
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;

              if (isMenuInteractive) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveMenuIndex((i) => (i + 1) % menu.items.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveMenuIndex((i) => (i - 1 + menu.items.length) % menu.items.length);
                  return;
                }
                if (e.key === "Tab") {
                  e.preventDefault();
                  handleSelectMenuItem(menu.items[clampedMenuIndex], "fillOnly");
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSelectMenuItem(menu.items[clampedMenuIndex], "primary");
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  if (input.trim() === "/") {
                    setInput("");
                    setCursorPos(0);
                  } else {
                    setMenuDismissed(true);
                  }
                  return;
                }
              } else if (menu.mode !== "none" && e.key === "Escape") {
                e.preventDefault();
                setMenuDismissed(true);
                return;
              }

              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend(Boolean(e.altKey));
              }
            }}
            placeholder={
              activePendingInteraction
                ? activeInteractionIsChoice
                  ? isTargetedSideInternal && targetedWorker
                    ? `Or type a custom reply for ${targetedWorker.label}…`
                    : "Or type a custom reply…"
                  : activeInteractionKind === "approval"
                  ? "Optional note or instructions…"
                  : isTargetedSideInternal && targetedWorker
                  ? `Reply to ${targetedWorker.label}'s question…`
                  : "Reply to question…"
                : state.scope === "controller"
                ? "Ask UFOO to route across projects, or type / for commands…"
                : targetedWorker
                ? targetedWorker.external
                  ? `Send bus message to @${targetedWorker.label}…`
                  : targetBusy
                  ? `Queue a follow-up for ${targetedWorker.label}… (Enter to queue, ⌥⏎ to send now)`
                  : `Message ${targetedWorker.label} directly, or type / for commands…`
                : targetBusy
                ? "Queue a follow-up for ufoo… (Enter to queue, ⌥⏎ to send now)"
                : "Ask ufoo, type / for commands, or @ to mention an agent…"
            }
            className="chat-composer-input w-full resize-none bg-transparent px-2 py-1 text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
          />

          <div ref={toolbarRef} className="mt-1.5 flex flex-nowrap items-center justify-between gap-2 px-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              <div
                ref={leftCoreRef}
                className={`flex items-center gap-1.5 ${showCommandsBtn || showNewSessionBtn ? "shrink-0" : "min-w-0"}`}
              >
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  title="Attach images or files (or drag & drop / paste)"
                  aria-label="Attach images or files"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 transition-colors cursor-pointer"
                >
                  <Paperclip size={14} />
                </button>

                {/* Unified Model + Thinking Effort Picker (follows active target) */}
                {targetedWorker?.external ? (
                  <span className="truncate font-mono text-[11px] text-zinc-500">
                    @{targetedWorker.label} · bus delivery
                  </span>
                ) : (
                  <ModelEffortPicker
                    agentId={targetedWorker ? targetedWorker.id : ""}
                    agentType={targetedWorker ? targetedWorker.type : "main"}
                    currentModel={targetedWorker ? targetedWorker.model : state.settings.agent_model}
                    currentThinking={targetedWorker ? targetedWorker.thinking_level : state.settings.agent_thinking}
                  />
                )}
              </div>

              {showCommandsBtn && (
                <button
                  ref={commandsBtnRef}
                  type="button"
                  onClick={handleToggleCommandMenu}
                  className={`inline-flex shrink-0 whitespace-nowrap items-center gap-1 rounded-lg px-2 py-1 text-[11px] transition-colors cursor-pointer ${
                    menu.mode === "commands"
                      ? "bg-white/[0.1] text-zinc-100"
                      : "text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-300"
                  }`}
                  title="Browse workspace commands (/)"
                >
                  <span className="font-mono text-[11px] opacity-80">/</span>
                  <span>Commands</span>
                </button>
              )}

              {!targetedWorker && showNewSessionBtn && (
                <button
                  ref={newSessionBtnRef}
                  type="button"
                  onClick={() => void handleNewConversation()}
                  className="shrink-0 whitespace-nowrap rounded-lg px-2 py-1 text-[11px] text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-300 transition-colors cursor-pointer"
                  title="Start a fresh main conversation (/session new)"
                >
                  New Session
                </button>
              )}
            </div>

            <div ref={rightGroupRef} className="flex shrink-0 items-center gap-1.5">
              {state.scope === "project" && (!targetedWorker || targetedWorker.internal) && (
                <PermissionPicker
                  agentId={targetedWorker ? targetedWorker.id : ""}
                  value={targetedWorker ? targetedWorker.permission_mode : state.settings.permission_mode}
                  align="right"
                />
              )}
              <ComposerActionButton
                hasContent={Boolean(input.trim() || attachments.length > 0)}
                busy={Boolean(targetBusy)}
                onSend={() => void handleSend()}
                onStop={() => {
                  if (targetedWorker) void cancelWorkerTurn(targetedWorker.id);
                  else void ufooBridge.sendCommand("task.cancel", {});
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const SPLIT_PANE_STORAGE_KEY = "ufoo.desktop.splitPaneWidth";
const MIN_PRIMARY_CHAT_WIDTH = 300;
const MIN_SECONDARY_PANE_WIDTH = 320;

function readSavedSplitPaneWidth(): number {
  try {
    const raw = Number(window.localStorage.getItem(SPLIT_PANE_STORAGE_KEY));
    return Number.isFinite(raw) && raw >= MIN_SECONDARY_PANE_WIDTH ? Math.round(raw) : 0;
  } catch {
    return 0;
  }
}

export function CenterStage() {
  const {
    state,
    dispatch,
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    selectProjectMain,
    selectWorkerView,
    submitWorkerInput,
    setWindowMode,
    selectSideWorker,
    openDocInInspector,
    handoffWorker,
    notifyToast,
  } = useWorkspace();
  const [handoffMenuOpen, setHandoffMenuOpen] = useState(false);
  const [editingTopGroupId, setEditingTopGroupId] = useState("");
  const [topGroupNameDraft, setTopGroupNameDraft] = useState("");
  const topRenameDoneRef = useRef(false);
  const mainRef = useRef<HTMLElement>(null);
  const [stageWidth, setStageWidth] = useState(0);
  const [preferredSplitWidth, setPreferredSplitWidth] = useState<number>(() => readSavedSplitPaneWidth());
  const [resizingSplit, setResizingSplit] = useState(false);
  const splitDragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const currentProject = useMemo(
    () => state.projects.find((p) => p.root === state.activeRoot),
    [state.projects, state.activeRoot]
  );

  const workers = currentProject?.workers || [];
  const internalWorkers = useMemo(() => workers.filter((w) => w.internal), [workers]);

  const isWorkerSingle = state.stageTarget.kind === "worker_single" && Boolean(state.stageTarget.agentId);
  const selectedWorkerMeta = useMemo(
    () => workers.find((w) => w.id === state.stageTarget.agentId),
    [workers, state.stageTarget.agentId]
  );
  const isExternalWorker = isWorkerSingle && Boolean(
    selectedWorkerMeta?.external || (
      state.workerSingleFrame?.agent_id === state.stageTarget.agentId && state.workerSingleFrame.external
    )
  );

  const groupMembers = state.workflowSnapshot.project_root === state.activeRoot && isWorkerSingle
    ? state.workflowSnapshot.groups.find(group => group.member_ids.includes(state.stageTarget.agentId))?.member_ids
    : undefined;
  const belongsToSelectedGroup = (worker: WorkerSummary) => Boolean(
    groupMembers?.includes(worker.id) || (selectedWorkerMeta?.group_id && worker.group_id === selectedWorkerMeta.group_id)
  );
  const stripWorkers = isWorkerSingle && (groupMembers || selectedWorkerMeta?.group_id)
    ? [...workers.filter(belongsToSelectedGroup), ...workers.filter(worker => !belongsToSelectedGroup(worker))]
    : workers;
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = stripRef.current;
    const selected = strip?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!strip || !selected) return;
    const bounds = strip.getBoundingClientRect();
    const button = selected.getBoundingClientRect();
    if (button.left < bounds.left) strip.scrollLeft += button.left - bounds.left;
    else if (button.right > bounds.right) strip.scrollLeft += button.right - bounds.right;
  }, [state.activeRoot, state.stageTarget.agentId, workers.length, groupMembers, selectedWorkerMeta?.group_id]);

  const activeSideWorker = useMemo(() => {
    if (state.sideAgentId) {
      const exact = internalWorkers.find((w) => w.id === state.sideAgentId);
      if (exact) return exact;
    }
    return internalWorkers[0] || null;
  }, [internalWorkers, state.sideAgentId]);

  const handleClearMain = async () => {
    const res = await ufooBridge.sendCommand<{ ok?: boolean; error?: string }>("chat.clear", {});
    if (res && res.ok === false) {
      notifyToast(res.error || "Failed to clear conversation");
    } else {
      notifyToast("Conversation cleared");
    }
  };

  const handleClearWorker = async (agentId: string, label: string) => {
    const res = await ufooBridge.sendCommand<{
      ok?: boolean;
      context_reset?: boolean;
      warning?: string;
      error?: string;
    }>("worker.clear", { agent_id: agentId });
    if (res && res.ok === false) {
      notifyToast(res.error || `Failed to clear ${label}`);
    } else if (res?.context_reset === false) {
      notifyToast(`Cleared ${label} view (restart worker to reset old runner context)`);
    } else {
      notifyToast(`Cleared ${label}`);
    }
  };

  const handleLaunchInternalQuick = async (agent = "ucode") => {
    await ufooBridge.sendCommand("worker.launch", { agent });
    notifyToast(`Launching ${agent} worker…`);
  };

  useEffect(() => {
    if (state.scope === "project" && state.windowMode === "multi") {
      void ufooBridge.sendCommand("workflow.snapshot", {});
    }
  }, [state.scope, state.windowMode, state.activeRoot]);

  const handleConnectWorkflowEdge = async (from: string, to: string) => {
    const res = await ufooBridge.sendCommand<{
      ok?: boolean;
      created_group?: boolean;
      already_connected?: boolean;
      error?: string;
    }>("workflow.connect", { from, to });
    if (!res?.ok) {
      notifyToast(res?.error || "Could not connect agents");
      return;
    }
    if (res.already_connected) return;
    const fromLabel = workers.find((w) => w.id === from)?.label || from;
    const toLabel = workers.find((w) => w.id === to)?.label || to;
    notifyToast(
      res.created_group
        ? `Connected ${fromLabel} → ${toLabel} · Temp group formed`
        : `Connected ${fromLabel} → ${toLabel}`
    );
  };

  const handleDisconnectWorkflowEdge = async (edge: WorkflowEdge) => {
    const res = await ufooBridge.sendCommand<{
      ok?: boolean;
      dissolved?: boolean;
      error?: string;
    }>("workflow.disconnect", { edge_id: edge.id, from: edge.from, to: edge.to });
    if (!res?.ok) {
      notifyToast(res?.error || "Could not remove link");
      return;
    }
    notifyToast(res.dissolved ? "Link removed · Temp group dissolved" : "Link removed");
  };

  const handleDisbandWorkflowGroup = async () => {
    const res = await ufooBridge.sendCommand<{ ok?: boolean; error?: string }>("workflow.disband", {});
    if (!res?.ok) {
      notifyToast(res?.error || "Could not dissolve temporary group");
      return;
    }
    notifyToast("Temporary group dissolved");
  };

  const handleRenameWorkflowGroup = async (name: string) => {
    const res = await ufooBridge.sendCommand<{ ok?: boolean; name?: string; error?: string }>(
      "workflow.rename",
      { name }
    );
    if (!res?.ok) {
      notifyToast(res?.error || "Could not rename temporary group");
      return;
    }
    notifyToast(`Renamed group to ${res.name || name}`);
  };

  const handleSaveWorkflowPositions = (positions: Record<string, WorkflowNodeGeometry>) => {
    void ufooBridge.sendCommand("workflow.layout", { positions });
  };

  const quickEngines = useMemo(
    () => state.engineCatalog.filter((e) => e.available || e.kind !== "acp"),
    [state.engineCatalog]
  );

  const workerBrandMap = useMemo(() => {
    const map: Record<string, string> = { ufoo: "ufoo", "ufoo-agent": "ufoo" };
    for (const a of currentProject?.archived || []) {
      if (a.id) map[a.id] = a.type;
      if (a.label) {
        map[a.label] = a.type;
        map[a.label.toLowerCase()] = a.type;
      }
    }
    for (const w of workers) {
      if (w.id) map[w.id] = w.type;
      if (w.label) {
        map[w.label] = w.type;
        map[w.label.toLowerCase()] = w.type;
      }
      if (w.group_member_id) {
        map[w.group_member_id] = w.type;
        map[w.group_member_id.toLowerCase()] = w.type;
      }
    }
    return map;
  }, [workers, currentProject?.archived]);

  const workerColorMap = useMemo(
    () =>
      buildProjectUcodeColorMap(
        currentProject?.root || state.activeRoot,
        workers,
        currentProject?.archived || []
      ),
    [currentProject?.root, currentProject?.archived, state.activeRoot, workers]
  );

  const isSplitLayout =
    !isWorkerSingle &&
    state.scope === "project" &&
    (state.windowMode === "side" || state.windowMode === "multi");
  const activeSideFrame = activeSideWorker ? state.paneFrames[activeSideWorker.id] : undefined;

  useEffect(() => {
    const el = mainRef.current;
    if (!isSplitLayout || !el) return;
    const measure = () => {
      const next = Math.round(el.getBoundingClientRect().width);
      if (next > 0) setStageWidth(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      splitDragRef.current = null;
    };
  }, [isSplitLayout]);

  useEffect(() => {
    try {
      if (preferredSplitWidth > 0) {
        window.localStorage.setItem(SPLIT_PANE_STORAGE_KEY, String(preferredSplitWidth));
      } else {
        window.localStorage.removeItem(SPLIT_PANE_STORAGE_KEY);
      }
    } catch {
      // ignore storage errors
    }
  }, [preferredSplitWidth]);

  const maxSecondaryWidth = Math.max(0, stageWidth - MIN_PRIMARY_CHAT_WIDTH);
  const minSecondaryWidth = Math.min(MIN_SECONDARY_PANE_WIDTH, maxSecondaryWidth);
  const clampSecondaryWidth = (value: number) =>
    Math.max(minSecondaryWidth, Math.min(Math.round(value), maxSecondaryWidth));
  const defaultSecondaryWidth =
    stageWidth > 0
      ? Math.round(stageWidth * (state.windowMode === "multi" ? 0.58 : 0.5))
      : 0;
  const resolvedSecondaryWidth =
    stageWidth > 0
      ? clampSecondaryWidth(preferredSplitWidth > 0 ? preferredSplitWidth : defaultSecondaryWidth)
      : 0;

  const startSplitResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || splitDragRef.current || resolvedSecondaryWidth <= 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    splitDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: resolvedSecondaryWidth,
    };
    setResizingSplit(true);
  };

  const moveSplitResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = splitDragRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    setPreferredSplitWidth(clampSecondaryWidth(gesture.startWidth + gesture.startX - event.clientX));
  };

  const finishSplitResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (splitDragRef.current?.pointerId !== event.pointerId) return;
    splitDragRef.current = null;
    setResizingSplit(false);
  };

  const resizeSplitWithKeys = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (resolvedSecondaryWidth <= 0) return;
    const targets: Record<string, number> = {
      ArrowLeft: resolvedSecondaryWidth + 20,
      ArrowRight: resolvedSecondaryWidth - 20,
      Home: minSecondaryWidth,
      End: maxSecondaryWidth,
    };
    if (!Object.hasOwn(targets, event.key)) return;
    event.preventDefault();
    setPreferredSplitWidth(clampSecondaryWidth(targets[event.key]));
  };

  const renderSplitResizeHandle = (label: string) => (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={minSecondaryWidth}
      aria-valuemax={maxSecondaryWidth}
      aria-valuenow={resolvedSecondaryWidth}
      tabIndex={0}
      title="Drag to resize · Double-click to reset width"
      onPointerDown={startSplitResize}
      onPointerMove={moveSplitResize}
      onPointerUp={finishSplitResize}
      onPointerCancel={finishSplitResize}
      onLostPointerCapture={finishSplitResize}
      onKeyDown={resizeSplitWithKeys}
      onDoubleClick={() => setPreferredSplitWidth(0)}
      data-resizing={resizingSplit || undefined}
      className="group absolute -left-1.5 top-2 bottom-2 z-20 w-3 cursor-col-resize touch-none outline-none focus-visible:ring-1 focus-visible:ring-white/20"
    >
      <div className="pointer-events-none absolute left-1/2 top-1 h-5 w-px rounded-full bg-white/10 group-hover:bg-white/25 group-data-[resizing=true]:bg-blue-400/60 transition-colors" />
      <div className="pointer-events-none absolute left-1/2 top-11 bottom-0 w-px rounded-full bg-white/[0.07] group-hover:bg-white/20 group-data-[resizing=true]:bg-blue-400/60 transition-colors" />
    </div>
  );

  const showRightToggleInCenter = state.scope === "project" && !state.rightInspectorOpen;

  const pendingAttentionCount = useMemo(() => {
    const queueCount = state.pendingInteractions.length || (state.pendingInteraction ? 1 : 0);
    const waitingOthers = state.projects.filter(
      (p) => p.waitingUser && p.root !== state.activeRoot
    ).length;
    return queueCount + waitingOthers;
  }, [state.pendingInteractions, state.pendingInteraction, state.projects, state.activeRoot]);

  const conversationStrip = state.scope === "project" && workers.length > 0 && (
    <div className="shrink-0 px-3 pt-1 md:px-5">
      <div ref={stripRef} role="group" aria-label="Switch conversation" className="mx-auto flex w-full max-w-3xl items-center gap-1 overflow-x-auto pb-0.5">
        <button
          type="button"
          aria-pressed={!isWorkerSingle && !state.targetAgent}
          onClick={() => void selectProjectMain(state.activeRoot)}
          className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors cursor-pointer ${
            !isWorkerSingle && !state.targetAgent
              ? "border-white/[0.12] bg-white/[0.1] text-white"
              : "border-transparent text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
          }`}
        >
          <BrandIcon brand="ufoo" size={13} />
          <span>ufoo</span>
          {state.busy && (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300 animate-pulse" />
          )}
        </button>

        {stripWorkers.map((w) => {
          const selected = isWorkerSingle ? state.stageTarget.agentId === w.id : state.targetAgent === w.id;
          const working = Boolean(state.paneFrames[w.id]?.busy || w.activity_state === "working");
          return (
            <button
              key={w.id}
              type="button"
              aria-pressed={selected}
              onClick={() => void selectWorkerView(state.activeRoot, w.id)}
              title={w.label}
              className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors cursor-pointer ${
                selected
                  ? "border-white/[0.12] bg-white/[0.1] text-white"
                  : "border-transparent text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
              }`}
            >
              <BrandIcon brand={w.type} color={workerColorMap[w.id]} size={13} />
              <span className="font-mono truncate max-w-[132px]">{w.label}</span>
              {w.external && (
                <span className="rounded bg-white/[0.06] px-1 font-mono text-[9px] text-zinc-400">
                  MCP
                </span>
              )}
              {working && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400 animate-pulse" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );

  const renderRightSidebarToggle = () => (
    <button
      type="button"
      onClick={() => dispatch({ type: "TOGGLE_RIGHT_INSPECTOR" })}
      title="Show Workspace Inspector (⌘⌥B)"
      aria-label="Show Workspace Inspector"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 transition-colors cursor-pointer"
    >
      <RightSidebarIcon active={false} />
    </button>
  );

  return (
    <main ref={mainRef} className="flex h-full min-w-0 flex-1 bg-[#0c0c0e]">
      {/* Primary Column: Full-width in Main/Single/Global, Left Column in Side/Multi */}
      <div
        className={`flex h-full min-h-0 flex-1 flex-col bg-[#0c0c0e] ${
          isSplitLayout ? "min-w-0 md:min-w-[300px]" : "min-w-0"
        }`}
      >
        {/* Top Stage Bar (Desktop >= md; Mobile uses Mobile Top Bar in App.tsx) */}
        <header
          data-tauri-drag-region
          className={`hidden md:flex h-[44px] shrink-0 items-center justify-between border-b border-white/[0.06] bg-[#0c0c0e] pr-2.5 ${
            !state.leftSidebarOpen
              ? isTauriEnvironment()
                ? "pl-[82px]"
                : "pl-2.5"
              : "pl-4"
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            {!state.leftSidebarOpen && (
              <div className="mr-1 flex items-center gap-0.5">
                <button
                  type="button"
                  disabled={!canGoBack}
                  onClick={() => void goBack()}
                  title="Back (⌘[)"
                  aria-label="Go Back"
                  className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                    canGoBack
                      ? "text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 cursor-pointer"
                      : "text-zinc-700 cursor-default"
                  }`}
                >
                  <NavBackIcon />
                </button>
                <button
                  type="button"
                  disabled={!canGoForward}
                  onClick={() => void goForward()}
                  title="Forward (⌘])"
                  aria-label="Go Forward"
                  className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                    canGoForward
                      ? "text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 cursor-pointer"
                      : "text-zinc-700 cursor-default"
                  }`}
                >
                  <NavForwardIcon />
                </button>
                <button
                  type="button"
                  onClick={() => dispatch({ type: "TOGGLE_LEFT_SIDEBAR" })}
                  title="Show Sidebar (⌘B)"
                  aria-label="Show Sidebar"
                  className="ml-0.5 flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 transition-colors cursor-pointer"
                >
                  <LeftSidebarIcon active={false} />
                </button>
              </div>
            )}

            {isWorkerSingle ? (
              <div className="flex items-center gap-2 min-w-0">
                <button
                  type="button"
                  onClick={() => currentProject && void selectProjectMain(currentProject.root)}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 transition-colors cursor-pointer"
                >
                  <ArrowLeft size={13} />
                  <span>{currentProject?.label || "Project"}</span>
                </button>
                <span className="text-zinc-600">/</span>
                <BrandIcon
                  brand={selectedWorkerMeta?.type || state.workerSingleFrame?.type}
                  color={workerColorMap[state.stageTarget.agentId]}
                  size={15}
                />
                <span className="font-mono text-[13px] font-semibold text-zinc-100 truncate">
                  {state.workerSingleFrame?.label || selectedWorkerMeta?.label || state.stageTarget.agentId}
                </span>
                {selectedWorkerMeta?.worktree_branch && (
                  <span className="hidden md:inline-block rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 font-mono text-[10.5px] text-zinc-400 truncate max-w-[150px]">
                    {selectedWorkerMeta.worktree_branch}
                  </span>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[13.5px] font-semibold text-zinc-100 truncate">
                  {state.scope === "controller"
                    ? "UFOO"
                    : `${currentProject?.label || "Workspace"} · ufoo`}
                </span>
                {!isSplitLayout && currentProject?.branch && (
                  <span className="hidden sm:inline-block rounded-md border border-white/[0.07] bg-white/[0.03] px-2 py-0.5 font-mono text-[11px] text-zinc-400 truncate max-w-[160px]">
                    {currentProject.branch}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {/* Quick Approval Inbox Badge Button when approvals are pending */}
            {pendingAttentionCount > 0 && (
              <button
                type="button"
                onClick={() => dispatch({ type: "SET_APPROVAL_INBOX_OPEN", open: true })}
                title="Open Approval Inbox"
                aria-label={`${pendingAttentionCount} pending approval${pendingAttentionCount === 1 ? "" : "s"}`}
                className="inline-flex items-center gap-1 rounded-full border border-amber-400/35 bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-semibold text-amber-200 hover:bg-amber-500/25 transition-colors cursor-pointer"
              >
                <BellSimple size={11} weight="fill" />
                <span className="font-mono">{pendingAttentionCount}</span>
              </button>
            )}

            {/* Rotating 3-State Layout Switcher Icon (Main -> Side -> Multi) */}
            {state.scope === "project" && !isWorkerSingle && (
              <LayoutModeCycleButton
                mode={state.windowMode}
                onSwitchMode={(next) =>
                  void setWindowMode(next, next === "side" ? activeSideWorker?.id : "")
                }
              />
            )}

            {/* Mid-Thread Cross-Engine Handoff on Single-Worker View (icon-only) */}
            {state.scope === "project" && isWorkerSingle && !isExternalWorker && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setHandoffMenuOpen((v) => !v)}
                  title="Hand off to another engine"
                  aria-label="Hand off to another engine"
                  aria-expanded={handoffMenuOpen}
                  className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors cursor-pointer ${
                    handoffMenuOpen
                      ? "bg-white/[0.1] text-zinc-100"
                      : "text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100"
                  }`}
                >
                  <ArrowsLeftRight size={15} />
                </button>
                {handoffMenuOpen && (
                  <div className="absolute right-0 top-full mt-1.5 z-40 w-48 rounded-xl border border-white/[0.1] bg-zinc-900 p-1 shadow-2xl">
                    <div className="px-2.5 py-1 text-[10px] font-medium text-zinc-500">
                      Continue thread on…
                    </div>
                    {quickEngines.map((eng) => (
                      <button
                        key={eng.agentType}
                        type="button"
                        onClick={() => {
                          setHandoffMenuOpen(false);
                          void handoffWorker(state.stageTarget.agentId, eng.agentType);
                        }}
                        className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-zinc-200 hover:bg-white/[0.09] hover:text-white cursor-pointer"
                      >
                        <span className="inline-flex items-center gap-2 min-w-0">
                          <BrandIcon brand={eng.agentType} size={14} />
                          <span className="truncate">{eng.label}</span>
                        </span>
                        <span className="font-mono text-[9.5px] text-zinc-500 uppercase shrink-0">{eng.kind}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {showRightToggleInCenter && !isSplitLayout && renderRightSidebarToggle()}
          </div>
        </header>

        {/* Primary Column Body */}
        {isWorkerSingle ? (
          <div className="flex flex-1 min-h-0 flex-col">
            <TranscriptStream key={state.stageTarget.agentId}
              entries={state.workerSingleFrame?.entries || []}
              planLines={state.workerSingleFrame?.plan || []}
              planItems={state.workerSingleFrame?.plan_items || []}
              pendingInteraction={
                state.workerSingleFrame?.pending_interaction ||
                state.paneFrames[state.stageTarget.agentId]?.pending_interaction ||
                null
              }
              busy={Boolean(state.workerSingleFrame?.busy)}
              statusText={state.workerSingleFrame?.status || ""}
              changedFiles={state.workerSingleFrame?.changed_files || []}
              defaultSpeaker={state.workerSingleFrame?.label || selectedWorkerMeta?.label || ""}
              defaultSpeakerBrand={state.workerSingleFrame?.type || selectedWorkerMeta?.type || ""}
              defaultSpeakerColor={workerColorMap[state.stageTarget.agentId]}
              workerBrandMap={workerBrandMap}
              workerColorMap={workerColorMap}
              onOpenFile={(p) => void openDocInInspector(p)}
              onClearConversation={
                !isExternalWorker
                  ? () =>
                      void handleClearWorker(
                        state.stageTarget.agentId,
                        state.workerSingleFrame?.label || selectedWorkerMeta?.label || state.stageTarget.agentId
                      )
                  : undefined
              }
              emptyHint="What do you want to do now?"
            />

            {conversationStrip}
            <WorkerComposer
              key={state.stageTarget.agentId}
              agentId={state.stageTarget.agentId}
              agentType={state.workerSingleFrame?.type || selectedWorkerMeta?.type || "worker"}
              label={state.workerSingleFrame?.label || selectedWorkerMeta?.label || state.stageTarget.agentId}
              model={state.workerSingleFrame?.model || selectedWorkerMeta?.model || ""}
              thinkingLevel={state.workerSingleFrame?.thinking_level || selectedWorkerMeta?.thinking_level || "medium"}
              permissionMode={state.workerSingleFrame?.permission_mode || selectedWorkerMeta?.permission_mode || state.settings.permission_mode || "auto_edit"}
              busy={Boolean(state.workerSingleFrame?.busy)}
              external={isExternalWorker}
              pendingInteraction={
                state.workerSingleFrame?.pending_interaction ||
                state.paneFrames[state.stageTarget.agentId]?.pending_interaction ||
                null
              }
              onOpenFile={(p) => void openDocInInspector(p)}
            />
          </div>
        ) : (
          <div className="flex flex-1 min-h-0 flex-col">
            <TranscriptStream
              entries={state.entries}
              planLines={state.planLines}
              planItems={state.planItems}
              pendingInteraction={state.pendingInteraction}
              busy={state.busy}
              statusText={state.statusText}
              defaultSpeaker="ufoo"
              defaultSpeakerBrand="ufoo"
              workerBrandMap={workerBrandMap}
              workerColorMap={workerColorMap}
              onOpenFile={(p) => void openDocInInspector(p)}
              onInspectWorkerInSide={(id) =>
                isSplitLayout ? void selectSideWorker(id) : void setWindowMode("side", id)
              }
              onClearConversation={() => void handleClearMain()}
              compact={isSplitLayout}
            />
            {conversationStrip}
            <MainComposer workers={workers} workerColorMap={workerColorMap} />
          </div>
        )}
      </div>

      {/* Secondary Column: Worker Agent(s) in Side or Multi Mode (Desktop >= md only) */}
      {isSplitLayout && state.windowMode === "side" && (
        <div
          style={resolvedSecondaryWidth > 0 ? { width: resolvedSecondaryWidth } : undefined}
          className={`relative hidden md:flex h-full min-h-0 min-w-0 flex-col bg-[#0c0c0e] ${
            resolvedSecondaryWidth > 0 ? "shrink-0" : "flex-1"
          }`}
        >
          {renderSplitResizeHandle("Resize side worker pane")}
          {/* Side Mode Top Bar: Clean active worker identity (switching lives above MainComposer) */}
          <div
            data-tauri-drag-region
            className="flex h-[44px] shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] bg-[#0c0c0e] pl-3.5 pr-2.5"
          >
            <div className="flex items-center gap-2 min-w-0">
              {activeSideWorker ? (
                <button
                  type="button"
                  onClick={() => {
                    dispatch({
                      type: "SET_TARGET_AGENT",
                      agentId: activeSideWorker.id,
                      prefix: `›@${activeSideWorker.label} `,
                    });
                    void ufooBridge.sendCommand("agent.select", {
                      agent_id: activeSideWorker.id,
                      label: activeSideWorker.label,
                    });
                  }}
                  title="Target this worker in the composer"
                  className="inline-flex items-center gap-2 min-w-0 rounded-lg px-1.5 py-1 text-left hover:bg-white/[0.05] transition-colors cursor-pointer"
                >
                  <BrandIcon brand={activeSideWorker.type} color={workerColorMap[activeSideWorker.id]} size={14} />
                  <span className="font-mono text-[12.5px] font-medium text-zinc-100 truncate">
                    {activeSideWorker.label}
                  </span>
                </button>
              ) : (
                <span className="text-[12px] text-zinc-500">No active workers</span>
              )}
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {activeSideFrame?.usage && (
                <span className="hidden xl:inline font-mono text-[10.5px] text-zinc-500 mr-1">
                  {activeSideFrame.usage}
                </span>
              )}
              <button
                type="button"
                onClick={() => void handleLaunchInternalQuick(state.defaultWorkerAgent || "ucode")}
                title={`Launch ${state.defaultWorkerAgent || "ucode"} worker`}
                aria-label="Launch worker"
                className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 transition-colors cursor-pointer"
              >
                <Plus size={14} />
              </button>
              {activeSideWorker && currentProject && (
                <button
                  type="button"
                  onClick={() => void selectWorkerView(currentProject.root, activeSideWorker.id)}
                  title="Expand to Single-Worker View"
                  aria-label="Expand to Single-Worker View"
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 transition-colors cursor-pointer"
                >
                  <ArrowsOutSimple size={14} />
                </button>
              )}
              {showRightToggleInCenter && renderRightSidebarToggle()}
            </div>
          </div>

          {activeSideWorker ? (
            <div className="flex flex-1 min-h-0 flex-col">
              <TranscriptStream
                entries={activeSideFrame?.entries || []}
                planLines={activeSideFrame?.plan || []}
                planItems={activeSideFrame?.plan_items || []}
                pendingInteraction={activeSideFrame?.pending_interaction || null}
                busy={Boolean(activeSideFrame?.busy || activeSideWorker.activity_state === "working")}
                statusText={activeSideFrame?.status || activeSideWorker.activity_detail || ""}
                changedFiles={activeSideFrame?.changed_files || []}
                defaultSpeaker={activeSideWorker.label}
                defaultSpeakerBrand={activeSideWorker.type}
                defaultSpeakerColor={workerColorMap[activeSideWorker.id]}
                workerBrandMap={workerBrandMap}
                workerColorMap={workerColorMap}
                onOpenFile={(p) => void openDocInInspector(p)}
                onClearConversation={() =>
                  void handleClearWorker(activeSideWorker.id, activeSideWorker.label)
                }
                compact
                emptyHint="What do you want to do now?"
              />
              {activeSideFrame?.pending_interaction &&
                state.targetAgent !== activeSideWorker.id && (
                  <div className="px-3 pb-2 pt-1">
                    <AskInteractionDock
                      interaction={activeSideFrame.pending_interaction}
                      sourceLabel={activeSideWorker.label}
                      compact
                      canDismiss={false}
                      onRespond={async (ans) => {
                        const trimmed = String(ans || "").trim();
                        if (!trimmed) return;
                        await submitWorkerInput(activeSideWorker.id, trimmed, [], {
                          forceSend: true,
                        });
                      }}
                      onFocusInput={() => {
                        dispatch({
                          type: "SET_TARGET_AGENT",
                          agentId: activeSideWorker.id,
                          prefix: `›@${activeSideWorker.label} `,
                        });
                        void ufooBridge.sendCommand("agent.select", {
                          agent_id: activeSideWorker.id,
                          label: activeSideWorker.label,
                        });
                      }}
                      onOpenFile={(p) => void openDocInInspector(p)}
                    />
                  </div>
                )}
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
              <div className="text-[13px] font-medium text-zinc-300">
                Side pane ready for workers
              </div>
              <div className="mt-1 max-w-xs text-[12px] text-zinc-500">
                Launch an internal worker (`ucode`, `codex`, or `claude`) to inspect and steer it alongside ufoo.
              </div>
              <div className="mt-3 flex flex-wrap justify-center items-center gap-2">
                {quickEngines.map((eng) => (
                  <button
                    key={eng.agentType}
                    type="button"
                    onClick={() => void handleLaunchInternalQuick(eng.agentType)}
                    className="inline-flex items-center gap-2 rounded-lg border border-white/[0.09] bg-white/[0.04] px-3 py-1.5 font-mono text-[12px] text-zinc-200 hover:bg-white/[0.09] hover:text-white transition-colors cursor-pointer"
                  >
                    <BrandIcon brand={eng.agentType} size={14} />
                    <span>{eng.label.replace(/\s*\(ACP\)$/i, "")}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {isSplitLayout && state.windowMode === "multi" && (
        <div
          style={resolvedSecondaryWidth > 0 ? { width: resolvedSecondaryWidth } : undefined}
          className={`relative hidden md:flex h-full min-h-0 min-w-0 flex-col bg-[#0c0c0e] ${
            resolvedSecondaryWidth > 0 ? "shrink-0" : "flex-1"
          }`}
        >
          {renderSplitResizeHandle("Resize Agent Group canvas")}
          {/* Multi Mode Top Bar */}
          <div
            data-tauri-drag-region
            className="flex h-[44px] shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] bg-[#0c0c0e] pl-3.5 pr-2.5"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[12.5px] font-medium text-zinc-200">Agent Group</span>
              <span className="font-mono text-[11px] text-zinc-500">{workers.length}</span>
              {state.workflowSnapshot.groups
                .filter((g) => g.member_ids.some((id) => workers.some((w) => w.id === id)))
                .map((g) =>
                g.origin === "adhoc" && editingTopGroupId === g.group_id ? (
                  <input
                    key={g.group_id}
                    type="text"
                    autoFocus
                    maxLength={48}
                    value={topGroupNameDraft}
                    onChange={(e) => setTopGroupNameDraft(e.target.value)}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={() => {
                      if (topRenameDoneRef.current) return;
                      topRenameDoneRef.current = true;
                      const trimmed = topGroupNameDraft.trim();
                      setEditingTopGroupId("");
                      if (trimmed && trimmed !== g.name) void handleRenameWorkflowGroup(trimmed);
                    }}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (topRenameDoneRef.current) return;
                        topRenameDoneRef.current = true;
                        const trimmed = topGroupNameDraft.trim();
                        setEditingTopGroupId("");
                        if (trimmed && trimmed !== g.name) void handleRenameWorkflowGroup(trimmed);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        topRenameDoneRef.current = true;
                        setEditingTopGroupId("");
                      }
                    }}
                    className="w-[140px] rounded-md border border-emerald-400/45 bg-[#15151a] px-1.5 py-0.5 text-[10.5px] font-medium text-emerald-200 focus:outline-none"
                  />
                ) : (
                  <span
                    key={g.group_id}
                    onDoubleClick={() => {
                      if (g.origin !== "adhoc") return;
                      topRenameDoneRef.current = false;
                      setEditingTopGroupId(g.group_id);
                      setTopGroupNameDraft(g.name);
                    }}
                    title={g.origin === "adhoc" ? "Double-click to rename temporary group" : g.name}
                    className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium truncate max-w-[160px] ${
                      g.origin === "adhoc"
                        ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300 cursor-text hover:border-emerald-400/45"
                        : "border-white/[0.09] bg-white/[0.04] text-zinc-300"
                    }`}
                  >
                    {g.origin === "adhoc" && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                    )}
                    <span className="truncate">{g.name}</span>
                  </span>
                )
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => void handleLaunchInternalQuick(state.defaultWorkerAgent || "ucode")}
                title={`Launch ${state.defaultWorkerAgent || "ucode"} worker`}
                aria-label="Launch worker"
                className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 transition-colors cursor-pointer"
              >
                <Plus size={14} />
              </button>
              {showRightToggleInCenter && renderRightSidebarToggle()}
            </div>
          </div>

          {workers.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
              <div className="text-[13px] font-medium text-zinc-300">
                Agent Group canvas ready
              </div>
              <div className="mt-1 max-w-xs text-[12px] text-zinc-500">
                Launch 2+ workers and drag wires between ports to form a temporary group, or run `/group run`.
              </div>
              <div className="mt-3 flex flex-wrap justify-center items-center gap-2">
                {quickEngines.map((eng) => (
                  <button
                    key={eng.agentType}
                    type="button"
                    onClick={() => void handleLaunchInternalQuick(eng.agentType)}
                    className="inline-flex items-center gap-2 rounded-lg border border-white/[0.09] bg-white/[0.04] px-3 py-1.5 font-mono text-[12px] text-zinc-200 hover:bg-white/[0.09] hover:text-white transition-colors cursor-pointer"
                  >
                    <BrandIcon brand={eng.agentType} size={14} />
                    <span>{eng.label.replace(/\s*\(ACP\)$/i, "")}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <MultiWorkflowCanvas
              workers={workers}
              workerColorMap={workerColorMap}
              paneFrames={state.paneFrames}
              workflow={state.workflowSnapshot}
              pulses={state.workflowPulses}
              selectedTargetId={state.targetAgent}
              onSelectWorker={(worker) => {
                dispatch({
                  type: "SET_TARGET_AGENT",
                  agentId: worker.id,
                  prefix: `›@${worker.label} `,
                });
                void ufooBridge.sendCommand("agent.select", {
                  agent_id: worker.id,
                  label: worker.label,
                });
              }}
              onMaximizeWorker={(worker) =>
                currentProject && void selectWorkerView(currentProject.root, worker.id)
              }
              onOpenFile={(p) => void openDocInInspector(p)}
              onClearWorker={(worker) => void handleClearWorker(worker.id, worker.label)}
              onConnectEdge={handleConnectWorkflowEdge}
              onDisconnectEdge={handleDisconnectWorkflowEdge}
              onDisbandGroup={handleDisbandWorkflowGroup}
              onRenameGroup={handleRenameWorkflowGroup}
              onSavePositions={handleSaveWorkflowPositions}
            />
          )}
        </div>
      )}
    </main>
  );
}

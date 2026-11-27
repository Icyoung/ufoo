import React, { Component, useEffect, useMemo } from "react";
import {
  BellSimple,
  ChatCircleDots,
  GearSix,
  GitDiff,
  List,
} from "@phosphor-icons/react";
import { WorkspaceProvider, useWorkspace } from "./store/workspaceStore";
import { isTauriEnvironment } from "./bridge/ufooClient";
import { LeftSidebar } from "./components/LeftSidebar";
import { CenterStage } from "./components/CenterStage";
import { RightInspector } from "./components/RightInspector";
import { SettingsModal } from "./components/SettingsModal";
import { CommandPalette } from "./components/CommandPalette";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { RemoteConnectScreen } from "./components/RemoteConnectScreen";
import { ApprovalInbox } from "./components/ApprovalInbox";
import { DotGridLoader } from "./components/DotGridLoader";
import type { MobileTab } from "./types";

class AppErrorBoundary extends Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-[100dvh] w-full flex-col items-center justify-center bg-[#0c0c0e] p-8 text-center text-zinc-200">
          <div className="max-w-md space-y-3 rounded-xl border border-white/[0.1] bg-zinc-950 p-5">
            <div className="text-[14px] font-semibold text-zinc-100">UI Render Error</div>
            <div className="font-mono text-[11.5px] text-rose-300 break-words">
              {this.state.error.message}
            </div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-[12px] font-medium text-white hover:bg-blue-500 cursor-pointer"
            >
              Reload Window
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function WorkbenchShell() {
  const { state, dispatch, setWindowMode, canGoBack, canGoForward, goBack, goForward } = useWorkspace();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && state.approvalInboxOpen) {
        e.preventDefault();
        dispatch({ type: "SET_APPROVAL_INBOX_OPEN", open: false });
        return;
      }
      if (e.key === "Escape" && state.mobileDrawerOpen) {
        e.preventDefault();
        dispatch({ type: "SET_MOBILE_DRAWER", open: false });
        return;
      }
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        const target = e.target as HTMLElement | null;
        const editing = Boolean(target && target.closest("input, textarea, [contenteditable='true']"));
        if (!editing && e.key === "ArrowLeft" && canGoBack) {
          e.preventDefault();
          void goBack();
          return;
        }
        if (!editing && e.key === "ArrowRight" && canGoForward) {
          e.preventDefault();
          void goForward();
          return;
        }
      }
      if (!(e.metaKey || e.ctrlKey)) return;

      const key = e.key.toLowerCase();
      if (key === "[" && !e.shiftKey && !e.altKey) {
        if (canGoBack) {
          e.preventDefault();
          void goBack();
        }
        return;
      }
      if (key === "]" && !e.shiftKey && !e.altKey) {
        if (canGoForward) {
          e.preventDefault();
          void goForward();
        }
        return;
      }
      if (key === "k") {
        e.preventDefault();
        dispatch({ type: "SET_COMMAND_PALETTE", open: !state.commandPaletteOpen });
        return;
      }
      if (key === "b" && e.altKey) {
        e.preventDefault();
        dispatch({ type: "TOGGLE_RIGHT_INSPECTOR" });
        return;
      }
      if (key === "b" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "TOGGLE_LEFT_SIDEBAR" });
        return;
      }
      if (key === ",") {
        e.preventDefault();
        dispatch({ type: "SET_SETTINGS_MODAL", open: !state.settingsModalOpen });
        return;
      }
      if (key === "w" && !e.shiftKey && state.stageTarget.kind === "project_main" && state.scope === "project") {
        // Align with CLI TUI window cycle: main -> side -> multi -> main
        e.preventDefault();
        const next =
          state.windowMode === "main"
            ? "side"
            : state.windowMode === "side"
            ? "multi"
            : "main";
        void setWindowMode(next);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    dispatch,
    setWindowMode,
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    state.windowMode,
    state.stageTarget,
    state.scope,
    state.settingsModalOpen,
    state.commandPaletteOpen,
    state.approvalInboxOpen,
    state.mobileDrawerOpen,
  ]);

  const currentProject = useMemo(
    () => state.projects.find((p) => p.root === state.activeRoot),
    [state.projects, state.activeRoot]
  );

  const activeMobileTitle = useMemo(() => {
    if (state.scope === "controller") return "UFOO";
    if (state.stageTarget.kind === "worker_single" && state.stageTarget.agentId) {
      const worker = currentProject?.workers.find((w) => w.id === state.stageTarget.agentId);
      return state.workerSingleFrame?.label || worker?.label || state.stageTarget.agentId;
    }
    return currentProject?.label || "Workspace";
  }, [state.scope, state.stageTarget, state.workerSingleFrame, currentProject]);

  const totalAttentionCount = useMemo(() => {
    const queueCount = state.pendingInteractions.length || (state.pendingInteraction ? 1 : 0);
    const waitingOthers = state.projects.filter(
      (p) => p.waitingUser && p.root !== state.activeRoot
    ).length;
    return queueCount + waitingOthers;
  }, [state.pendingInteractions, state.pendingInteraction, state.projects, state.activeRoot]);

  const changedFilesCount = state.changesSnapshot?.files.length || 0;

  const showRemoteConnect =
    !isTauriEnvironment() &&
    (state.transportMode === "unpaired" ||
      ((state.transportMode === "remote-relay" || state.transportMode === "remote-p2p") &&
        !state.connected &&
        state.projects.length === 0 &&
        state.entries.length === 0 &&
        state.remotePairingState !== "connected"));

  if (showRemoteConnect) {
    return (
      <>
        <RemoteConnectScreen />
        {state.toastMessage && (
          <div className="fixed bottom-5 right-5 z-50 rounded-xl border border-white/[0.12] bg-zinc-900/95 px-3.5 py-2 text-[12px] text-zinc-100 shadow-2xl backdrop-blur-xl">
            {state.toastMessage}
          </div>
        )}
      </>
    );
  }

  const mobileTabs: Array<{
    id: MobileTab;
    label: string;
    badge?: number;
    badgeTone?: "amber" | "blue";
  }> = [
    { id: "inbox", label: "Inbox", badge: totalAttentionCount, badgeTone: "amber" },
    { id: "chat", label: "Chat" },
    { id: "changes", label: "Changes", badge: changedFilesCount, badgeTone: "blue" },
  ];

  return (
    <div className="relative flex h-[100dvh] w-full flex-col md:flex-row overflow-hidden bg-[#0c0c0e] md:bg-transparent text-zinc-100">
      {/* Compact Mobile Top Bar (< md only) */}
      <header className="flex md:hidden shrink-0 items-center justify-between gap-2 border-b border-white/[0.07] bg-zinc-950/95 px-2.5 py-2 safe-top backdrop-blur-xl">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => dispatch({ type: "SET_MOBILE_DRAWER", open: true })}
            aria-label="Open Projects Menu"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-zinc-300 hover:bg-white/[0.08] hover:text-white active:scale-95 transition-all cursor-pointer"
          >
            <List size={19} weight="bold" />
          </button>
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold text-zinc-100">
              {activeMobileTitle}
            </span>
            {state.busy && (
              <DotGridLoader size="xs" colorClass="bg-blue-400" />
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => dispatch({ type: "SET_SETTINGS_MODAL", open: true, tab: "general" })}
            aria-label="Settings"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-zinc-400 hover:bg-white/[0.08] hover:text-white transition-colors cursor-pointer"
          >
            <GearSix size={18} />
          </button>
        </div>
      </header>

      {/* Desktop LeftSidebar (>= md only) */}
      <LeftSidebar />

      {/* Mobile Slide-Over Backdrop Drawer for LeftSidebar (< md only) */}
      {state.mobileDrawerOpen && (
        <div
          className="fixed inset-0 z-40 flex md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Workspace Navigation"
        >
          <div
            onClick={() => dispatch({ type: "SET_MOBILE_DRAWER", open: false })}
            className="fixed inset-0 bg-black/65 backdrop-blur-[2px]"
          />
          <div className="relative z-10 flex h-full">
            <LeftSidebar mobileDrawer />
          </div>
        </div>
      )}

      {/* Main Content Stage */}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {/* Mobile Approval Inbox Tab (< md) */}
        {state.mobileTab === "inbox" && (
          <div className="flex md:hidden h-full w-full min-w-0 flex-1">
            <ApprovalInbox />
          </div>
        )}

        {/* CenterStage: always shown on Desktop (>= md), shown on Mobile when mobileTab === "chat" */}
        <div
          className={`${
            state.mobileTab === "chat" ? "flex" : "hidden md:flex"
          } h-full min-h-0 min-w-0 flex-1`}
        >
          <CenterStage />
        </div>

        {/* Desktop RightInspector (>= md) */}
        <RightInspector />

        {/* Mobile Full-Width Changes / Docs / Context Inspector (< md) */}
        {state.mobileTab === "changes" && (
          <div className="flex md:hidden h-full w-full min-w-0 flex-1">
            <RightInspector mobileFullWidth />
          </div>
        )}
      </div>

      {/* Mobile Bottom Tab Bar (< md only) */}
      <nav
        aria-label="Mobile Navigation"
        className="flex md:hidden shrink-0 items-stretch border-t border-white/[0.08] bg-zinc-950/95 px-2 pt-1.5 pb-1.5 safe-bottom backdrop-blur-xl"
      >
        {mobileTabs.map(({ id, label, badge, badgeTone }) => {
          const active = state.mobileTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => dispatch({ type: "SET_MOBILE_TAB", tab: id })}
              aria-current={active ? "page" : undefined}
              className={`relative flex flex-1 flex-col items-center justify-center gap-0.5 rounded-xl py-1.5 text-[11px] font-medium transition-colors cursor-pointer ${
                active ? "bg-white/[0.08] text-white" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <span className="relative inline-flex items-center justify-center">
                {id === "inbox" ? (
                  <BellSimple size={19} weight={active ? "fill" : "regular"} />
                ) : id === "chat" ? (
                  <ChatCircleDots size={19} weight={active ? "fill" : "regular"} />
                ) : (
                  <GitDiff size={19} weight={active ? "fill" : "regular"} />
                )}
                {typeof badge === "number" && badge > 0 && (
                  <span
                    className={`absolute -right-2.5 -top-1.5 min-w-[16px] rounded-full px-1 py-[1px] text-center font-mono text-[9.5px] font-bold leading-tight ${
                      badgeTone === "amber"
                        ? "bg-amber-400 text-zinc-950"
                        : "bg-blue-500 text-white"
                    }`}
                  >
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </span>
              <span>{label}</span>
            </button>
          );
        })}
      </nav>

      {/* Desktop Quick Approval Inbox Modal */}
      {state.approvalInboxOpen && (
        <div
          onClick={() => dispatch({ type: "SET_APPROVAL_INBOX_OPEN", open: false })}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm p-4 md:p-6"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex h-[560px] max-h-[85vh] w-full max-w-[600px] overflow-hidden rounded-2xl border border-white/[0.11] bg-[#0c0c0e] shadow-2xl"
          >
            <ApprovalInbox
              onCloseModal={() => dispatch({ type: "SET_APPROVAL_INBOX_OPEN", open: false })}
            />
          </div>
        </div>
      )}

      <SettingsModal />
      <CommandPalette />
      <OnboardingWizard />

      {state.toastMessage && (
        <div className="fixed bottom-20 md:bottom-5 right-4 md:right-5 z-50 rounded-xl border border-white/[0.12] bg-zinc-900/95 px-3.5 py-2 text-[12px] text-zinc-100 shadow-2xl backdrop-blur-xl">
          {state.toastMessage}
        </div>
      )}
    </div>
  );
}

export function App() {
  return (
    <AppErrorBoundary>
      <WorkspaceProvider>
        <WorkbenchShell />
      </WorkspaceProvider>
    </AppErrorBoundary>
  );
}

import React, { useEffect } from "react";
import { WorkspaceProvider, useWorkspace } from "./store/workspaceStore";
import { LeftSidebar } from "./components/LeftSidebar";
import { CenterStage } from "./components/CenterStage";
import { RightInspector } from "./components/RightInspector";
import { SettingsModal } from "./components/SettingsModal";

function WorkbenchShell() {
  const { state, dispatch, setWindowMode, continueInCli } = useWorkspace();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;

      const key = e.key.toLowerCase();
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
      if (key === "t" && e.shiftKey && state.scope === "project") {
        e.preventDefault();
        void continueInCli(
          state.stageTarget.kind === "worker_single" ? state.stageTarget.agentId : ""
        );
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    dispatch,
    setWindowMode,
    continueInCli,
    state.windowMode,
    state.stageTarget,
    state.scope,
    state.settingsModalOpen,
  ]);

  return (
    <div className="relative flex h-[100dvh] w-full overflow-hidden bg-transparent text-zinc-100">
      <LeftSidebar />
      <div className="flex h-full min-w-0 flex-1">
        <CenterStage />
        <RightInspector />
      </div>
      <SettingsModal />

      {state.toastMessage && (
        <div className="fixed bottom-5 right-5 z-50 rounded-xl border border-white/[0.12] bg-zinc-900/95 px-3.5 py-2 text-[12px] text-zinc-100 shadow-2xl backdrop-blur-xl">
          {state.toastMessage}
        </div>
      )}
    </div>
  );
}

export function App() {
  return (
    <WorkspaceProvider>
      <WorkbenchShell />
    </WorkspaceProvider>
  );
}

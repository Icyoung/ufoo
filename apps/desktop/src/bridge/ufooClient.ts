import type { UiEnvelope } from "../types";

const previewProjectRoot = "/workspace/ufoo";

type EventListener = (envelope: UiEnvelope) => void;

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

class UfooDesktopBridge {
  private listeners = new Set<EventListener>();
  private initialized = false;
  private reqSeq = 0;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (isTauriEnvironment()) {
      const { listen } = await import("@tauri-apps/api/event");
      const { invoke } = await import("@tauri-apps/api/core");

      await listen<UiEnvelope>("ufoo://ui-event", (event) => {
        if (event.payload) {
          this.emit(event.payload);
        }
      });

      await listen<string>("ufoo://deep-link", async (event) => {
        if (event.payload) {
          await this.sendCommand("handoff.open_url", { url: event.payload });
        }
      });

      // Request initial resync snapshot once WebView listener is attached
      try {
        await invoke("ufoo_client_ready");
      } catch {
        // Host may still be booting; events will stream automatically on ready
      }
      return;
    }

    // Browser dev preview seed so layout/UI can also be inspected standalone
    this.seedPreviewState();
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(envelope: UiEnvelope) {
    for (const fn of this.listeners) {
      try {
        fn(envelope);
      } catch (err) {
        console.error("[ufoo-bridge] listener error", err);
      }
    }
  }

  async sendCommand<T = Record<string, any>>(
    name: string,
    payload: Record<string, any> = {}
  ): Promise<T> {
    const requestId = `ui-${Date.now().toString(36)}-${++this.reqSeq}`;
    if (isTauriEnvironment()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<T>("ufoo_send_command", {
        name,
        requestId,
        payload,
      });
    }
    return this.handlePreviewCommand(name, payload) as T;
  }

  async pickProjectFolder(): Promise<string | null> {
    if (isTauriEnvironment()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<string | null>("ufoo_pick_folder");
    }
    const manual = window.prompt("Enter project workspace path:");
    return manual ? manual.trim() : null;
  }

  async openProjectInFinder(root: string): Promise<void> {
    if (!isTauriEnvironment()) {
      throw new Error("Open in Finder is available in the Ufoo desktop app.");
    }
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke<void>("ufoo_open_project_in_finder", { root });
  }

  private seedPreviewState() {
    setTimeout(() => {
      this.emit({
        protocol: "ufoo-ui/1",
        kind: "event",
        name: "projects.tree",
        payload: {
          controller_root: "~/.ufoo",
          active_root: previewProjectRoot,
          scope: "project",
          stage_target: { kind: "project_main", agentId: "" },
          projects: [
            {
              id: "ufoo-repo",
              label: "ufoo",
              root: previewProjectRoot,
              branch: "master",
              status: "running",
              active: true,
              selectedAsMain: true,
              selectedWorkerId: "",
              mainBusy: false,
              waitingUser: false,
              conversationId: "main-default",
              workers: [
                {
                  id: "ucode:a1b2c3d4",
                  label: "ucode-1",
                  type: "ucode",
                  internal: true,
                  external: false,
                  activity_state: "working",
                  activity_detail: "Implementing desktopUiHost.js",
                },
                {
                  id: "codex:e5f60718",
                  label: "codex-1",
                  type: "codex",
                  internal: true,
                  external: false,
                  activity_state: "idle",
                  activity_detail: "Verified 120 unit tests",
                  group_id: "grp-core",
                  group_template_alias: "dev-pair",
                },
                {
                  id: "cursor:99887766",
                  label: "cursor-1",
                  type: "cursor",
                  internal: false,
                  external: true,
                  activity_state: "idle",
                  activity_detail: "",
                  host_name: "Cursor",
                },
              ],
              recoverable: [],
            },
          ],
        },
      });
      this.emit({
        protocol: "ufoo-ui/1",
        kind: "snapshot",
        name: "app.snapshot",
        payload: {
          status: "ready",
          package_version: "4.1.0",
          active_root: previewProjectRoot,
          scope: "project",
          stage_target: { kind: "project_main", agentId: "" },
          entries: [
            {
              id: "demo-1",
              kind: "user",
              text: "为 ufoo 设计并落地支持 CLI 双向接力的 macOS 桌面应用。",
            },
            {
              id: "demo-2",
              kind: "thinking",
              text: "Confirmed architecture: Tauri v2 shell + shared Node desktopUiHost connected to GlobalDaemon (~/.ufoo/run/ufoo.sock).",
            },
            {
              id: "demo-3",
              kind: "tool",
              text: "• Read & verified 6 runtime contracts",
              detail: "src/runtime/contracts/uiProtocol.js\nsrc/runtime/daemon/globalDaemon.js\nsrc/ui/desktopUiHost.js",
            },
            {
              id: "demo-4",
              kind: "assistant",
              speaker: "ufoo",
              text: "已完成共享核心桥接层 `src/ui/desktopUiHost.js` 与双向接力协议。你可以在顶栏切换 **Main / Side / Multi** 视图，或在左侧点击任意二级 Worker 单独进入专注视图。",
            },
          ],
          settings: {
            agent_provider: "codex-cli",
            agent_model: "gpt-6.1-sol",
            agent_thinking: "medium",
          },
          window: { active: false, mode: "main", panes: [] },
        },
      });
    }, 30);
  }

  private handlePreviewCommand(name: string, payload: Record<string, any>) {
    if (name === "settings.models") {
      const models = payload.agent_provider === "codex-cli" ? ["gpt-6.1-sol"] : [];
      return { ok: Boolean(models.length), models, default_model: models[0] || "" };
    }
    if (name === "window.set") {
      const mode = payload.mode || "main";
      this.emit({
        protocol: "ufoo-ui/1",
        kind: "event",
        name: "window.set",
        payload: {
          active: mode !== "main",
          mode,
          panes: [
            { agent_id: "ucode:a1b2c3d4", label: "ucode-1", mode: "internal" },
            ...(mode === "multi" ? [{ agent_id: "codex:e5f60718", label: "codex-1", mode: "internal" }] : []),
          ],
        },
      });
    }
    if (name === "worker.focus_view") {
      const id = payload.agent_id || "";
      if (!id || id === "main") {
        this.emit({
          protocol: "ufoo-ui/1",
          kind: "event",
          name: "handoff.state",
          payload: { stage_target: { kind: "project_main", agentId: "" } },
        });
      } else {
        this.emit({
          protocol: "ufoo-ui/1",
          kind: "event",
          name: "worker.view.frame",
          payload: {
            project_root: previewProjectRoot,
            agent_id: id,
            label: id.startsWith("cursor") ? "cursor-1" : "ucode-1",
            type: id.startsWith("cursor") ? "cursor" : "ucode",
            internal: !id.startsWith("cursor"),
            external: id.startsWith("cursor"),
            entries: [
              { id: "w-1", kind: "user", text: "Implement desktopUiHost.js and verify unit tests." },
              { id: "w-2", kind: "assistant", text: "All 120 Phase 0 tests in `test/unit/ui/desktopUiHost.test.js` passed." },
            ],
            reports: [],
            status: "ready",
            busy: false,
            usage: "18% ctx",
            plan: ["✓ Extend uiProtocol", "✓ Implement desktopUiHost", "◐ Connect Tauri v2 UI"],
            activity_detail: "",
            host_name: "Cursor",
            input: "",
            input_revision: 0,
          },
        });
      }
    }
    return { ok: true };
  }
}

export const ufooBridge = new UfooDesktopBridge();

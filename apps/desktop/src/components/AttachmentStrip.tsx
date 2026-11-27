import React, { useEffect, useRef, useState } from "react";
import { FileText, Image as ImageIcon, Paperclip, X } from "@phosphor-icons/react";
import type { ComposerAttachment } from "../types";
import { isTauriEnvironment } from "../bridge/ufooClient";

export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function readFileAsUpload(
  file: File
): Promise<{ name: string; data_base64: string; media_type: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve({
        name: file.name || (file.type.startsWith("image/") ? "pasted-image.png" : "attachment"),
        data_base64: result,
        media_type: file.type || "application/octet-stream",
      });
    };
    reader.onerror = () => reject(new Error(`Could not read ${file.name || "file"}`));
    reader.readAsDataURL(file);
  });
}

/**
 * Subscribe to native Tauri v2 OS file drag-and-drop events (`tauri://drag-drop`).
 * In browser preview mode this cleanly no-ops so standard HTML5 drop handlers take over.
 */
export function useTauriFileDrop({
  enabled,
  onDropPaths,
}: {
  enabled: boolean;
  onDropPaths: (paths: string[]) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const callbackRef = useRef(onDropPaths);
  callbackRef.current = onDropPaths;

  useEffect(() => {
    if (!enabled || !isTauriEnvironment()) {
      setDragging(false);
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        if (disposed) return;
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload as { type?: string; paths?: string[] };
          if (!payload) return;
          if (payload.type === "enter" || payload.type === "over") {
            setDragging(true);
          } else if (payload.type === "drop") {
            setDragging(false);
            if (Array.isArray(payload.paths) && payload.paths.length > 0) {
              callbackRef.current(payload.paths);
            }
          } else if (payload.type === "leave") {
            setDragging(false);
          }
        });
      } catch {
        // Fallback silently to HTML5 drag-drop if webview drag-drop event is unavailable
      }
    })();

    return () => {
      disposed = true;
      setDragging(false);
      if (unlisten) {
        try {
          unlisten();
        } catch {
          // ignore cleanup errors
        }
      }
    };
  }, [enabled]);

  return { isTauriDragging: dragging };
}

export function AttachmentStrip({
  attachments,
  staging = false,
  onRemove,
}: {
  attachments: ComposerAttachment[];
  staging?: boolean;
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0 && !staging) return null;

  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1.5 px-1.5 pt-0.5">
      {attachments.map((att) => {
        const sizeLabel = formatAttachmentSize(att.bytes);
        if (att.kind === "image" && att.preview_data_url) {
          return (
            <div
              key={att.id}
              title={att.path}
              className="group/att relative flex items-center gap-2 rounded-xl border border-white/[0.1] bg-white/[0.04] p-1 pr-2.5 transition-colors hover:border-white/[0.18]"
            >
              <img
                src={att.preview_data_url}
                alt={att.name}
                className="h-9 w-9 shrink-0 rounded-lg object-cover border border-white/[0.08] bg-black/40"
              />
              <div className="min-w-0 max-w-[136px]">
                <div className="truncate text-[11.5px] font-medium text-zinc-200">{att.name}</div>
                {sizeLabel && (
                  <div className="font-mono text-[9.5px] text-zinc-500">{sizeLabel}</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => onRemove(att.id)}
                title="Remove attachment"
                aria-label={`Remove ${att.name}`}
                className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-white/[0.12] hover:text-zinc-100 transition-colors cursor-pointer"
              >
                <X size={10} weight="bold" />
              </button>
            </div>
          );
        }

        return (
          <div
            key={att.id}
            title={att.path}
            className="group/att flex items-center gap-1.5 rounded-xl border border-white/[0.09] bg-white/[0.04] px-2.5 py-1.5 transition-colors hover:border-white/[0.18]"
          >
            {att.kind === "image" ? (
              <ImageIcon size={13} className="shrink-0 text-zinc-400" />
            ) : (
              <FileText size={13} className="shrink-0 text-zinc-400" />
            )}
            <span className="max-w-[150px] truncate text-[11.5px] font-medium text-zinc-200">
              {att.name}
            </span>
            {sizeLabel && (
              <span className="font-mono text-[9.5px] text-zinc-500">{sizeLabel}</span>
            )}
            <button
              type="button"
              onClick={() => onRemove(att.id)}
              title="Remove attachment"
              aria-label={`Remove ${att.name}`}
              className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-white/[0.12] hover:text-zinc-100 transition-colors cursor-pointer"
            >
              <X size={10} weight="bold" />
            </button>
          </div>
        );
      })}

      {staging && (
        <div className="inline-flex items-center gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-[11px] text-zinc-400">
          <span className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-zinc-500 border-t-zinc-200" />
          <span>Attaching…</span>
        </div>
      )}
    </div>
  );
}

export function DropFilesOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-2xl border border-dashed border-white/[0.28] bg-[#121216]/88 backdrop-blur-sm">
      <div className="flex items-center gap-2 rounded-full border border-white/[0.12] bg-white/[0.06] px-3.5 py-1.5 text-[12px] font-medium text-zinc-100 shadow-lg">
        <Paperclip size={14} className="text-zinc-300" />
        <span>Drop images or files to attach</span>
      </div>
    </div>
  );
}

import React from "react";
import {
  ArrowBendDownRight,
  ArrowUp,
  Paperclip,
  X,
} from "@phosphor-icons/react";
import type { QueuedMessageItem } from "../types";

interface QueuedMessagesTrayProps {
  items: QueuedMessageItem[];
  paused?: boolean;
  busy?: boolean;
  onSendNow: (id: string) => void;
  onEdit: (item: QueuedMessageItem) => void;
  onRemove: (id: string) => void;
  onClearAll?: () => void;
  compact?: boolean;
}

export function QueuedMessagesTray({
  items,
  paused = false,
  busy = false,
  onSendNow,
  onEdit,
  onRemove,
  compact = false,
}: QueuedMessagesTrayProps) {
  if (!items || items.length === 0) return null;

  return (
    <div
      className={`${
        compact ? "mx-2" : "mx-auto max-w-3xl px-2.5"
      } animate-peer-content-swap`}
    >
      <div className="max-h-32 overflow-y-auto rounded-t-xl border border-b-0 border-white/[0.09] bg-zinc-900/65 divide-y divide-white/[0.05]">
        {items.map((item, idx) => {
          const atts = Array.isArray(item.attachments) ? item.attachments : [];
          return (
            <div
              key={item.id}
              className="group flex items-center gap-2 px-3 py-1.5 text-[12px] hover:bg-white/[0.03] transition-colors"
            >
              <ArrowBendDownRight
                size={12}
                className="shrink-0 text-zinc-500"
                aria-hidden="true"
              />

              <button
                type="button"
                onClick={() => onEdit(item)}
                title="Click to edit"
                className="flex min-w-0 flex-1 items-center gap-2 text-left cursor-pointer"
              >
                <span className="min-w-0 truncate text-zinc-300 group-hover:text-zinc-100 transition-colors">
                  {item.text || atts.map((a) => a.name).join(", ")}
                </span>
                {item.text && atts.length > 0 && (
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-zinc-500">
                    <Paperclip size={11} />
                    <span>{atts.length}</span>
                  </span>
                )}
              </button>

              {paused && idx === 0 && (
                <span className="shrink-0 text-[10.5px] text-zinc-500 select-none">
                  Paused
                </span>
              )}

              <div className="flex shrink-0 items-center gap-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
                <button
                  type="button"
                  onClick={() => onSendNow(item.id)}
                  title={busy ? "Send now (interrupts current turn)" : "Send now"}
                  aria-label="Send now"
                  className="flex h-5 w-5 items-center justify-center rounded-md text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-100 transition-colors cursor-pointer"
                >
                  <ArrowUp size={12} weight="bold" />
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(item.id)}
                  title="Remove"
                  aria-label="Remove"
                  className="flex h-5 w-5 items-center justify-center rounded-md text-zinc-500 hover:bg-white/[0.08] hover:text-zinc-200 transition-colors cursor-pointer"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

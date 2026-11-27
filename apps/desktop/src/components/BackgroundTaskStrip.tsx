import { useState } from "react";
import type { BackgroundTask } from "../types";
import { DotGridLoader } from "./DotGridLoader";

export function BackgroundTaskStrip({ tasks }: { tasks: BackgroundTask[] }) {
  const [expanded, setExpanded] = useState("");
  const selected = tasks.find(task => task.id === expanded);
  if (!tasks.length) return null;
  return (
    <div className="relative mb-1" onKeyDown={event => {
      if (event.key === "Escape") setExpanded("");
    }}>
      {selected && (
        <div className="absolute inset-x-0 bottom-full z-10 mb-1 max-h-[30dvh] overflow-y-auto rounded-xl border border-white/10 bg-zinc-900 p-3 text-xs shadow-lg">
          <strong>{selected.title}</strong>
          <span className="ml-2 text-zinc-400">{selected.status === "queued" ? "Queued" : "In progress"}</span>
          {selected.progress?.kind === "tool" && (
            <div className="mt-2 flex flex-wrap items-baseline gap-x-2">
              <span className="break-all font-mono text-zinc-200">{selected.progress.title}</span>
              <span className="text-zinc-400">{{ running: "Running", done: "Done", failed: "Failed" }[selected.progress.status]}</span>
            </div>
          )}
          <p className="mt-1 whitespace-pre-wrap break-words text-zinc-300">{selected.progress?.text ?? selected.detail}</p>
        </div>
      )}
      <div className="flex gap-1.5 overflow-x-auto py-1">
        {tasks.map(task => (
          <button key={task.id} type="button" aria-expanded={expanded === task.id}
            onClick={() => setExpanded(expanded === task.id ? "" : task.id)}
            className="inline-flex h-7 max-w-56 shrink-0 items-center gap-2 rounded-lg border border-white/10 bg-zinc-900 px-2.5 text-xs text-zinc-300 hover:bg-zinc-800 aria-expanded:bg-zinc-800">
            <DotGridLoader size="xs" queued={task.status === "queued"} label={task.status === "queued" ? "Queued" : "In progress"} />
            <span className="truncate">{task.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { ufooBridge } from "../bridge/ufooClient";

interface Props {
  filePath: string;
  mime: string;
  revision: string;
  size: number;
}

export function WorkspaceFilePreview({ filePath, mime, revision, size }: Props) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [percent, setPercent] = useState(0);
  const name = filePath.split("/").pop() || filePath;

  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";
    async function load() {
      const parts: BlobPart[] = [];
      let offset = 0;
      while (offset < size) {
        const chunk = await ufooBridge.sendCommand<{ data: string; nextOffset: number; error?: string }>(
          "workspace.file.preview", { filePath, revision, offset }
        );
        if (cancelled) return;
        if (!chunk.data || !(chunk.nextOffset > offset)) throw new Error(chunk.error || "Could not load file preview");
        parts.push(Uint8Array.from(atob(chunk.data), char => char.charCodeAt(0)));
        offset = chunk.nextOffset;
        setPercent(Math.floor(100 * offset / size));
      }
      objectUrl = URL.createObjectURL(new Blob(parts, { type: mime }));
      setUrl(objectUrl);
    }
    void load().catch(err => { if (!cancelled) setError(String(err.message || err)); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [filePath, mime, revision, size]);

  if (error || !url) return <p className="p-3 text-xs text-zinc-400">{error || `Loading preview… ${percent}%`}</p>;
  if (mime === "text/html") return <iframe title={name} src={url} sandbox="allow-scripts" className="h-full w-full border-0 bg-white" />;
  if (mime.startsWith("video/")) return <video src={url} aria-label={name} controls playsInline
    className="h-full w-full object-contain" onError={() => setError("This video could not be played in this browser.")} />;
  return <img src={url} alt={name} className="mx-auto max-h-full max-w-full object-contain"
    onError={() => setError("This image could not be displayed.")} />;
}

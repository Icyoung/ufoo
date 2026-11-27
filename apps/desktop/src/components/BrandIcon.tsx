import React from "react";

const UFOO_PLANET_ASSET = new URL("../assets/ufoo-planet.png", import.meta.url).href;

const BRAND_ASSETS: Record<string, string> = {
  claude: new URL("../assets/brands/claude.svg", import.meta.url).href,
  codex: new URL("../assets/brands/codex.svg", import.meta.url).href,
  antigravity: new URL("../assets/brands/antigravity.svg", import.meta.url).href,
  gemini: new URL("../assets/brands/gemini.svg", import.meta.url).href,
  opencode: new URL("../assets/brands/opencode.svg", import.meta.url).href,
  kimi: new URL("../assets/brands/kimi.svg", import.meta.url).href,
  grok: new URL("../assets/brands/grok.svg", import.meta.url).href,
  goose: new URL("../assets/brands/goose.svg", import.meta.url).href,
  ufoo: UFOO_PLANET_ASSET,
  ucode: UFOO_PLANET_ASSET,
};

/**
 * Curated 12-color non-orange palette for `ucode` workers.
 * Orange (#FD5D23) is reserved exclusively for `ufoo`.
 * Ordered for maximum perceptual contrast across the first workers in a project.
 */
export const UCODE_COLOR_PALETTE = [
  "#38BDF8", // 0: Sky Blue
  "#34D399", // 1: Emerald
  "#A78BFA", // 2: Violet
  "#F472B6", // 3: Rose Pink
  "#FDE047", // 4: Lemon Yellow
  "#22D3EE", // 5: Cyan
  "#E879F9", // 6: Fuchsia
  "#A3E635", // 7: Lime
  "#60A5FA", // 8: Cobalt Blue
  "#2DD4BF", // 9: Teal
  "#818CF8", // 10: Indigo
  "#4ADE80", // 11: Spring Green
] as const;

export const UCODE_DEFAULT_COLOR = UCODE_COLOR_PALETTE[0];

const UCODE_COLOR_STORAGE_KEY = "ufoo.desktop.ucodeColors.v1";

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

let projectColorRegistry: Record<string, Record<string, number>> | null = null;

function loadProjectColorRegistry(): Record<string, Record<string, number>> {
  if (projectColorRegistry) return projectColorRegistry;
  projectColorRegistry = {};
  try {
    const raw = window.localStorage.getItem(UCODE_COLOR_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [projectKey, entries] of Object.entries(parsed as Record<string, unknown>)) {
          if (!entries || typeof entries !== "object") continue;
          const clean: Record<string, number> = {};
          for (const [workerId, slot] of Object.entries(entries as Record<string, unknown>)) {
            if (typeof slot === "number" && Number.isInteger(slot) && slot >= 0 && slot < UCODE_COLOR_PALETTE.length) {
              clean[workerId] = slot;
            }
          }
          projectColorRegistry[projectKey] = clean;
        }
      }
    }
  } catch {
    // ignore storage errors
  }
  return projectColorRegistry;
}

function saveProjectColorRegistry(registry: Record<string, Record<string, number>>) {
  try {
    window.localStorage.setItem(UCODE_COLOR_STORAGE_KEY, JSON.stringify(registry));
  } catch {
    // ignore storage errors
  }
}

export function resolveBrandKey(raw?: string): keyof typeof BRAND_ASSETS | null {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;
  if (s.includes("claude") || s.includes("anthropic")) return "claude";
  if (
    s.includes("codex") ||
    s.includes("openai") ||
    /(?:^|\/)(?:gpt[-.]|chatgpt[-.]|o[134](?:[-.]|$))/.test(s)
  ) {
    return "codex";
  }
  if (s.includes("antigravity") || s === "agy" || s.startsWith("agy-") || s.startsWith("agy:")) return "antigravity";
  if (s.includes("gemini")) return "gemini";
  if (s.includes("opencode")) return "opencode";
  if (s.includes("kimi") || s.includes("moonshot")) return "kimi";
  if (s.includes("grok") || s.includes("xai")) return "grok";
  if (s.includes("goose")) return "goose";
  if (s === "ucode" || s.startsWith("ucode-") || s.startsWith("ucode:")) return "ucode";
  if (s === "ufoo" || s.startsWith("ufoo-") || s.endsWith(":ufoo-agent") || s === "main") return "ufoo";
  return null;
}

export function isUcodeBrand(typeOrId?: string): boolean {
  return resolveBrandKey(typeOrId) === "ucode";
}

export function resolveUcodeFallbackColor(seed?: string): string {
  const s = String(seed || "").trim().toLowerCase();
  if (!s || s === "ucode") return UCODE_DEFAULT_COLOR;
  return UCODE_COLOR_PALETTE[hashString(s) % UCODE_COLOR_PALETTE.length];
}

export interface UcodeColorCandidate {
  id: string;
  label?: string;
  type?: string;
  group_member_id?: string;
}

/**
 * Assigns a stable, unique non-orange color from the 12-color palette to each
 * `ucode` worker within a project so no two `ucode` workers in the same project
 * share a color (up to 12).
 */
export function buildProjectUcodeColorMap(
  projectRoot: string,
  workers: ReadonlyArray<UcodeColorCandidate>,
  archived: ReadonlyArray<UcodeColorCandidate> = []
): Record<string, string> {
  const projectKey = String(projectRoot || "__default__").trim() || "__default__";
  const registry = loadProjectColorRegistry();
  const assigned = registry[projectKey] || (registry[projectKey] = {});
  const projectOffset = projectRoot ? hashString(projectKey) % UCODE_COLOR_PALETTE.length : 0;

  const seenIds = new Set<string>();
  const activeUcodes: UcodeColorCandidate[] = [];
  const archivedUcodes: UcodeColorCandidate[] = [];

  for (const w of workers || []) {
    if (!w?.id || seenIds.has(w.id)) continue;
    if (!isUcodeBrand(w.type) && !isUcodeBrand(w.id)) continue;
    seenIds.add(w.id);
    activeUcodes.push(w);
  }
  for (const a of archived || []) {
    if (!a?.id || seenIds.has(a.id)) continue;
    if (!isUcodeBrand(a.type) && !isUcodeBrand(a.id)) continue;
    seenIds.add(a.id);
    archivedUcodes.push(a);
  }

  const ordered = [...activeUcodes, ...archivedUcodes];
  const usedByActive = new Set<number>();
  const usedByCurrent = new Set<number>();
  const activeIdSet = new Set(activeUcodes.map((w) => w.id));
  let dirty = false;

  // Keep valid non-colliding assignments first (active workers have priority)
  const needsSlot: UcodeColorCandidate[] = [];
  for (const item of ordered) {
    const existing = assigned[item.id];
    const isActive = activeIdSet.has(item.id);
    const validSlot =
      typeof existing === "number" &&
      Number.isInteger(existing) &&
      existing >= 0 &&
      existing < UCODE_COLOR_PALETTE.length;
    if (validSlot && (!usedByCurrent.has(existing) || (!isActive && usedByCurrent.size >= UCODE_COLOR_PALETTE.length))) {
      usedByCurrent.add(existing);
      if (isActive) usedByActive.add(existing);
    } else {
      needsSlot.push(item);
    }
  }

  const usedHistorically = new Set<number>(Object.values(assigned));

  for (const item of needsSlot) {
    const isActive = activeIdSet.has(item.id);
    let chosen = -1;
    // 1. Prefer a slot never used in this project yet
    for (let step = 0; step < UCODE_COLOR_PALETTE.length; step += 1) {
      const candidate = (projectOffset + step) % UCODE_COLOR_PALETTE.length;
      if (!usedByCurrent.has(candidate) && !usedHistorically.has(candidate)) {
        chosen = candidate;
        break;
      }
    }
    // 2. Otherwise pick any slot unused by currently present workers/archived items
    if (chosen === -1) {
      for (let step = 0; step < UCODE_COLOR_PALETTE.length; step += 1) {
        const candidate = (projectOffset + step) % UCODE_COLOR_PALETTE.length;
        if (!usedByCurrent.has(candidate)) {
          chosen = candidate;
          break;
        }
      }
    }
    // 3. If >12 ucode workers exist in one project, avoid colliding with active workers first
    if (chosen === -1) {
      for (let step = 0; step < UCODE_COLOR_PALETTE.length; step += 1) {
        const candidate = (projectOffset + step) % UCODE_COLOR_PALETTE.length;
        if (!usedByActive.has(candidate)) {
          chosen = candidate;
          break;
        }
      }
    }
    if (chosen === -1) {
      chosen = (projectOffset + hashString(item.id)) % UCODE_COLOR_PALETTE.length;
    }
    assigned[item.id] = chosen;
    usedByCurrent.add(chosen);
    usedHistorically.add(chosen);
    if (isActive) usedByActive.add(chosen);
    dirty = true;
  }

  if (dirty) {
    saveProjectColorRegistry(registry);
  }

  const map: Record<string, string> = {};
  for (const [histId, slot] of Object.entries(assigned)) {
    const color = UCODE_COLOR_PALETTE[slot];
    if (!color) continue;
    map[histId] = color;
    map[histId.toLowerCase()] = color;
  }
  for (const item of ordered) {
    const slot = assigned[item.id];
    const color = UCODE_COLOR_PALETTE[slot] || UCODE_DEFAULT_COLOR;
    map[item.id] = color;
    map[item.id.toLowerCase()] = color;
    if (item.label) {
      map[item.label] = color;
      map[item.label.toLowerCase()] = color;
    }
    if (item.group_member_id) {
      map[item.group_member_id] = color;
      map[item.group_member_id.toLowerCase()] = color;
    }
  }
  return map;
}

export function BrandIcon({
  brand,
  color,
  size = 15,
  className = "",
}: {
  brand?: string;
  color?: string;
  size?: number;
  className?: string;
}) {
  const key = resolveBrandKey(brand);
  if (!key) return null;
  const src = BRAND_ASSETS[key];

  // Only `ufoo` uses the original orange planet asset; `ucode` always renders with a non-orange palette tint.
  if (key === "ucode") {
    const tint = color || resolveUcodeFallbackColor(brand);
    return (
      <span
        role="img"
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          backgroundColor: tint,
          WebkitMaskImage: `url("${src}")`,
          maskImage: `url("${src}")`,
          WebkitMaskSize: "contain",
          maskSize: "contain",
          WebkitMaskRepeat: "no-repeat",
          maskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
          maskPosition: "center",
        }}
        className={`inline-block shrink-0 select-none ${className}`}
      />
    );
  }

  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={`shrink-0 object-contain select-none ${className}`}
    />
  );
}

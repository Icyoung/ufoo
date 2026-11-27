import React from "react";

export type DotGridLoaderSize = "xs" | "sm" | "md" | "lg";

const SIZE_CONFIG: Record<DotGridLoaderSize, { box: string; dot: string }> = {
  xs: { box: "h-[9px] w-[9px] gap-[2px]", dot: "h-[3.5px] w-[3.5px]" },
  sm: { box: "h-[11px] w-[11px] gap-[2.5px]", dot: "h-[4px] w-[4px]" },
  md: { box: "h-[14px] w-[14px] gap-[3px]", dot: "h-[5.5px] w-[5.5px]" },
  lg: { box: "h-[18px] w-[18px] gap-[4px]", dot: "h-[7px] w-[7px]" },
};

const DELAYS = ["0ms", "180ms", "540ms", "360ms"] as const;

export function DotGridLoader({
  size = "sm",
  active = true,
  colorClass = "bg-zinc-200",
  inactiveColorClass = "bg-zinc-400/70",
  label = "Loading",
  className = "",
}: {
  size?: DotGridLoaderSize;
  active?: boolean;
  colorClass?: string;
  inactiveColorClass?: string;
  label?: string;
  className?: string;
}) {
  const cfg = SIZE_CONFIG[size] || SIZE_CONFIG.sm;
  const dotColor = active ? `${colorClass} agy-plan-dot` : inactiveColorClass;

  return (
    <span
      role="status"
      aria-label={label}
      className={`inline-grid shrink-0 grid-cols-2 ${cfg.box} ${className}`}
    >
      {DELAYS.map((delay) => (
        <span
          key={delay}
          className={`rounded-full ${cfg.dot} ${dotColor}`}
          style={active ? { animationDelay: delay } : undefined}
        />
      ))}
    </span>
  );
}

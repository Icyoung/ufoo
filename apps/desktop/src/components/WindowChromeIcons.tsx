import React from "react";
import type { WindowMode } from "../types";

export function NavBackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13 8H3.25M7.4 3.85L3.25 8L7.4 12.15"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function NavForwardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 8H12.75M8.6 3.85L12.75 8L8.6 12.15"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LeftSidebarIcon({ active = false }: { active?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="2.4"
        y="3.4"
        width="2.8"
        height="9.2"
        rx="1.2"
        fill="currentColor"
        fillOpacity={active ? "0.26" : "0.1"}
      />
      <rect
        x="1.75"
        y="2.75"
        width="12.5"
        height="10.5"
        rx="2.25"
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <line
        x1="5.75"
        y1="2.75"
        x2="5.75"
        y2="13.25"
        stroke="currentColor"
        strokeWidth="1.35"
      />
    </svg>
  );
}

export function RightSidebarIcon({ active = false }: { active?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="10.8"
        y="3.4"
        width="2.8"
        height="9.2"
        rx="1.2"
        fill="currentColor"
        fillOpacity={active ? "0.26" : "0.1"}
      />
      <rect
        x="1.75"
        y="2.75"
        width="12.5"
        height="10.5"
        rx="2.25"
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <line
        x1="10.25"
        y1="2.75"
        x2="10.25"
        y2="13.25"
        stroke="currentColor"
        strokeWidth="1.35"
      />
    </svg>
  );
}

export function LayoutModeIcon({ mode }: { mode: WindowMode }) {
  if (mode === "side") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect
          x="8.65"
          y="3.4"
          width="4.95"
          height="9.2"
          rx="1.2"
          fill="currentColor"
          fillOpacity="0.22"
        />
        <rect
          x="1.75"
          y="2.75"
          width="12.5"
          height="10.5"
          rx="2.25"
          stroke="currentColor"
          strokeWidth="1.35"
        />
        <line
          x1="8"
          y1="2.75"
          x2="8"
          y2="13.25"
          stroke="currentColor"
          strokeWidth="1.35"
        />
      </svg>
    );
  }
  if (mode === "multi") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect
          x="7.9"
          y="3.4"
          width="5.7"
          height="4.1"
          rx="0.9"
          fill="currentColor"
          fillOpacity="0.24"
        />
        <rect
          x="7.9"
          y="8.5"
          width="5.7"
          height="4.1"
          rx="0.9"
          fill="currentColor"
          fillOpacity="0.14"
        />
        <rect
          x="1.75"
          y="2.75"
          width="12.5"
          height="10.5"
          rx="2.25"
          stroke="currentColor"
          strokeWidth="1.35"
        />
        <line
          x1="7.25"
          y1="2.75"
          x2="7.25"
          y2="13.25"
          stroke="currentColor"
          strokeWidth="1.35"
        />
        <line
          x1="7.25"
          y1="8"
          x2="14.25"
          y2="8"
          stroke="currentColor"
          strokeWidth="1.25"
        />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="3.1"
        y="4.1"
        width="9.8"
        height="7.8"
        rx="1.15"
        fill="currentColor"
        fillOpacity="0.14"
      />
      <rect
        x="1.75"
        y="2.75"
        width="12.5"
        height="10.5"
        rx="2.25"
        stroke="currentColor"
        strokeWidth="1.35"
      />
    </svg>
  );
}

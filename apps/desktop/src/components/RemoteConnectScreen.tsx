import React, { useEffect, useState } from "react";
import {
  ArrowsClockwise,
  Key,
  LockSimple,
  Play,
  ShieldCheck,
  SignOut,
  WarningCircle,
  WifiHigh,
} from "@phosphor-icons/react";
import { useWorkspace } from "../store/workspaceStore";
import {
  defaultDeviceLabel,
  inferDefaultRelayUrl,
  isSameOriginDefaultRelay,
  ufooBridge,
} from "../bridge/ufooClient";
import { formatPairCode } from "../bridge/remoteCrypto";
import { BrandIcon } from "./BrandIcon";

export function RemoteConnectScreen() {
  const { state, notifyToast } = useWorkspace();
  const [relayUrl, setRelayUrl] = useState(
    () => state.remoteDeepLink?.relayUrl || state.remoteRelayUrl || inferDefaultRelayUrl()
  );
  const [showCustomRelay, setShowCustomRelay] = useState(
    () => !isSameOriginDefaultRelay(state.remoteDeepLink?.relayUrl || state.remoteRelayUrl || inferDefaultRelayUrl())
  );
  const [pairCode, setPairCode] = useState(() => state.remoteDeepLink?.pairCode || "");
  const [deviceLabel, setDeviceLabel] = useState(() => defaultDeviceLabel());
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    if (state.remoteDeepLink?.relayUrl) {
      setRelayUrl(state.remoteDeepLink.relayUrl);
      if (!isSameOriginDefaultRelay(state.remoteDeepLink.relayUrl)) {
        setShowCustomRelay(true);
      }
    }
    if (state.remoteDeepLink?.pairCode) {
      setPairCode(state.remoteDeepLink.pairCode);
    }
  }, [state.remoteDeepLink]);

  const targetDeviceId = state.remoteDeepLink?.deviceId || state.remoteRouteDeviceId || "";
  const errorBanner = localError || state.remoteError;
  const isPairing = submitting || state.remotePairingState === "pairing";
  const isResumingSaved =
    state.remoteHasSavedSession &&
    state.transportMode !== "unpaired" &&
    state.transportMode !== "preview";

  const handleSubmitPair = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isPairing) return;
    setLocalError("");
    const trimmedRelay = relayUrl.trim() || inferDefaultRelayUrl();
    const trimmedCode = pairCode.trim();
    if (!trimmedRelay) {
      setLocalError("Enter your Ufoo Relay URL");
      return;
    }
    if (!trimmedCode) {
      setLocalError("Enter the one-time pairing code from Desktop Settings");
      return;
    }

    setSubmitting(true);
    try {
      const info = await ufooBridge.pairRemote({
        relayUrl: trimmedRelay,
        pairCode: trimmedCode,
        label: deviceLabel.trim() || defaultDeviceLabel(),
        deviceId: targetDeviceId || undefined,
        expectedFingerprint: state.remoteDeepLink?.fingerprint || undefined,
      });
      notifyToast(`Paired with ${info.deviceName}`);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetryReconnect = async () => {
    setLocalError("");
    try {
      await ufooBridge.reconnectRemote();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleEnterPreview = () => {
    setLocalError("");
    ufooBridge.enterPreviewMode();
  };

  return (
    <div className="relative flex min-h-[100dvh] w-full flex-col items-center justify-center overflow-y-auto bg-[#09090b] px-4 py-8 text-zinc-100 safe-area-inset">
      {/* Subtle Ambient Backdrop Glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 overflow-hidden"
      >
        <div className="absolute -top-32 left-1/2 h-80 w-[440px] -translate-x-1/2 rounded-full bg-blue-500/[0.09] blur-[110px]" />
        <div className="absolute bottom-0 right-1/4 h-64 w-72 rounded-full bg-emerald-500/[0.06] blur-[100px]" />
      </div>

      <div className="relative z-10 w-full max-w-[420px] space-y-5">
        {/* Brand Header */}
        <div className="flex flex-col items-center text-center space-y-2">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/[0.12] bg-zinc-900/90 shadow-[0_12px_40px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.08)]">
            <BrandIcon brand="ufoo" size={30} />
          </div>
          <div className="space-y-1">
            <h1 className="text-[20px] font-semibold tracking-tight text-white">
              Ufoo Remote
            </h1>
            <p className="text-[12.5px] text-zinc-400">
              End-to-end encrypted control for your desktop agents
            </p>
          </div>
        </div>

        {/* Main Glass Card */}
        <div className="rounded-2xl border border-white/[0.1] bg-[#111114]/90 p-5 shadow-[0_24px_64px_rgba(0,0,0,0.65),inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-xl space-y-4">
          {errorBanner && (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-[12px] leading-relaxed text-rose-200"
            >
              <WarningCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-rose-400" />
              <span className="min-w-0 break-words">{errorBanner}</span>
            </div>
          )}

          {isResumingSaved ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-zinc-950/80 p-3.5">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-blue-400/20 bg-blue-500/10 text-blue-300">
                  {state.remotePairingState === "error" ? (
                    <WifiHigh size={18} />
                  ) : (
                    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-semibold text-zinc-100">
                    {state.remoteDeviceName || "Paired Host"}
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-zinc-400">
                    {state.remotePairingState === "error"
                      ? "Host unreachable — retrying automatically…"
                      : "Negotiating P2P & verifying E2EE keys…"}
                  </div>
                  {state.remoteHostFingerprint && (
                    <div className="mt-1 font-mono text-[10.5px] text-zinc-500">
                      FP: {state.remoteHostFingerprint}
                    </div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => void handleRetryReconnect()}
                  className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-white/[0.1] bg-white/[0.07] px-3 text-[12.5px] font-medium text-zinc-100 hover:bg-white/[0.12] transition-colors cursor-pointer"
                >
                  <ArrowsClockwise size={14} />
                  <span>Retry Now</span>
                </button>
                <button
                  type="button"
                  onClick={() => ufooBridge.unpairRemote()}
                  className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 text-[12.5px] font-medium text-rose-200 hover:bg-rose-500/20 transition-colors cursor-pointer"
                >
                  <SignOut size={14} />
                  <span>Unpair</span>
                </button>
              </div>
            </div>
          ) : isPairing ? (
            <div className="flex flex-col items-center py-6 text-center space-y-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-blue-400/25 bg-blue-500/10">
                <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
              </div>
              <div className="space-y-1">
                <div className="text-[14px] font-semibold text-zinc-100">
                  Pairing with Host…
                </div>
                <p className="text-[12px] text-zinc-400">
                  Generating ECDH P-256 keys, exchanging cryptographic proof, and opening an encrypted tunnel.
                </p>
              </div>
              <div className="w-full rounded-xl border border-white/[0.06] bg-zinc-950/80 px-3 py-2 font-mono text-[11px] text-zinc-500 truncate">
                {relayUrl}
              </div>
            </div>
          ) : (
            <form onSubmit={(e) => void handleSubmitPair(e)} className="space-y-3.5">
              {targetDeviceId && (
                <div className="flex items-center justify-between gap-2 rounded-xl border border-blue-400/20 bg-blue-500/[0.07] px-3 py-2 text-[11.5px]">
                  <span className="text-zinc-400 shrink-0">Device</span>
                  <span className="truncate font-mono text-blue-200">
                    /remote/{targetDeviceId}
                  </span>
                </div>
              )}

              <div className="space-y-1.5">
                <label
                  htmlFor="ufoo-pair-code"
                  className="flex items-center justify-between text-[12px] font-medium text-zinc-300"
                >
                  <span>Pairing Code</span>
                  <span className="text-[10.5px] font-normal text-zinc-500">One-time 8-char code</span>
                </label>
                <div className="relative">
                  <Key
                    size={15}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
                  />
                  <input
                    id="ufoo-pair-code"
                    type="text"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    value={pairCode}
                    onChange={(e) => setPairCode(formatPairCode(e.target.value).slice(0, 9))}
                    placeholder="ABCD-1234"
                    className="h-11 w-full rounded-xl border border-white/[0.1] bg-zinc-950/90 pl-9 pr-3 font-mono text-[16px] font-semibold tracking-[0.16em] text-white placeholder:font-normal placeholder:tracking-normal placeholder:text-zinc-600 focus:border-blue-500/50 focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="ufoo-device-label"
                  className="block text-[12px] font-medium text-zinc-300"
                >
                  Device Label <span className="font-normal text-zinc-500">(optional)</span>
                </label>
                <input
                  id="ufoo-device-label"
                  type="text"
                  maxLength={64}
                  value={deviceLabel}
                  onChange={(e) => setDeviceLabel(e.target.value)}
                  placeholder="My iPhone"
                  className="h-10 w-full rounded-xl border border-white/[0.1] bg-zinc-950/90 px-3 text-[13px] text-zinc-100 placeholder:text-zinc-600 focus:border-blue-500/50 focus:outline-none"
                />
              </div>

              {showCustomRelay ? (
                <div className="space-y-1.5">
                  <label
                    htmlFor="ufoo-relay-url"
                    className="flex items-center justify-between text-[12px] font-medium text-zinc-300"
                  >
                    <span>Relay URL</span>
                    <button
                      type="button"
                      onClick={() => {
                        setRelayUrl(inferDefaultRelayUrl());
                        setShowCustomRelay(false);
                      }}
                      className="text-[10.5px] font-normal text-zinc-500 hover:text-zinc-300 cursor-pointer"
                    >
                      Use default
                    </button>
                  </label>
                  <input
                    id="ufoo-relay-url"
                    type="url"
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={relayUrl}
                    onChange={(e) => setRelayUrl(e.target.value)}
                    placeholder="wss://online.ufoo.dev/ufoo/online"
                    className="h-10 w-full rounded-xl border border-white/[0.1] bg-zinc-950/90 px-3 font-mono text-[12px] text-zinc-100 placeholder:text-zinc-600 focus:border-blue-500/50 focus:outline-none"
                  />
                </div>
              ) : (
                <div className="flex items-center justify-between text-[11px] text-zinc-500">
                  <span className="truncate font-mono">Relay: {relayUrl.replace(/^wss?:\/\//, "")}</span>
                  <button
                    type="button"
                    onClick={() => setShowCustomRelay(true)}
                    className="shrink-0 ml-2 text-zinc-400 hover:text-zinc-200 underline underline-offset-2 cursor-pointer"
                  >
                    Custom relay
                  </button>
                </div>
              )}

              <button
                type="submit"
                disabled={isPairing || !relayUrl.trim() || !pairCode.trim()}
                className="mt-1 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-[13.5px] font-medium text-white shadow-[0_8px_24px_rgba(37,99,235,0.35)] hover:bg-blue-500 active:scale-[0.99] disabled:opacity-40 transition-all cursor-pointer"
              >
                <LockSimple size={15} weight="bold" />
                <span>Pair & Connect</span>
              </button>
            </form>
          )}

          <div className="relative py-0.5">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-white/[0.07]" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-[#111114] px-2.5 text-[11px] text-zinc-500">or</span>
            </div>
          </div>

          <button
            type="button"
            onClick={handleEnterPreview}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-white/[0.09] bg-white/[0.03] px-4 text-[12.5px] font-medium text-zinc-300 hover:bg-white/[0.08] hover:text-white transition-colors cursor-pointer"
          >
            <Play size={13} weight="fill" />
            <span>Preview Demo</span>
          </button>
        </div>

        {/* Security & Setup Footnote */}
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.015] px-4 py-3 text-[11.5px] leading-relaxed text-zinc-500 space-y-1.5">
          <div className="flex items-center gap-1.5 font-medium text-zinc-300">
            <ShieldCheck size={14} className="text-emerald-400 shrink-0" />
            <span>Zero-Knowledge End-to-End Encrypted</span>
          </div>
          <p>
            Open <span className="text-zinc-300">Settings → Remote Access</span> in the Ufoo desktop app to scan a pairing QR code or copy a one-time code.
          </p>
        </div>
      </div>
    </div>
  );
}

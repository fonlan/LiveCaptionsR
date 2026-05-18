import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import type { AppConfig, SessionMetadata } from "../types";
import {
  DEFAULT_CONFIG,
  DEFAULT_PROXY,
  DEFAULT_SUMMARY_PROMPT,
  DEFAULT_TRANSLATION_PROMPT,
} from "../types";

export type UseAppStartupOptions = {
  setAppVersion: React.Dispatch<React.SetStateAction<string>>;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  setIsRunning: React.Dispatch<React.SetStateAction<boolean>>;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  setSessions: React.Dispatch<React.SetStateAction<SessionMetadata[]>>;
  /** Kept in sync with `isRunning` so async callbacks read fresh state. */
  isRunningRef: React.MutableRefObject<boolean>;
};

/**
 * Mount-time bootstrap: fans out the four "must have before first
 * render" backend calls (version / config / watcher state / session
 * list), reconciles their results with sensible fallbacks, and emits a
 * `log_startup_metric` event with the timings.
 *
 * Each backend call is `Promise.allSettled`'d so a single failure
 * (e.g. config file missing) doesn't block the rest of the UI from
 * loading. Errors are logged to the console with context.
 *
 * The caller owns all the state setters/refs that get written; the
 * hook returns nothing, just fires off the effect.
 */
export function useAppStartup({
  setAppVersion,
  setConfig,
  setIsRunning,
  setStatus,
  setSessions,
  isRunningRef,
}: UseAppStartupOptions): void {
  useEffect(() => {
    let cancelled = false;

    async function init() {
      const frontendInitBegin = performance.now();
      const bootMark = (window as Window & { __LCR_BOOT_TS__?: number }).__LCR_BOOT_TS__;
      const webviewBootMs =
        typeof bootMark === "number" && Number.isFinite(bootMark)
          ? Math.max(0, Math.round(frontendInitBegin - bootMark))
          : null;

      const [versionResult, configResult, runningResult, sessionsResult] =
        await Promise.allSettled([
          getVersion(),
          invoke<AppConfig>("get_config"),
          invoke<boolean>("is_watcher_running"),
          invoke<SessionMetadata[]>("get_sessions"),
        ]);

      if (cancelled) {
        return;
      }

      if (versionResult.status === "fulfilled") {
        setAppVersion(versionResult.value);
      } else {
        console.error("Failed to load app version:", versionResult.reason);
      }

      if (configResult.status === "fulfilled") {
        const savedConfig = configResult.value;
        setConfig({
          ...DEFAULT_CONFIG,
          ...savedConfig,
          // Fall back to the bundled default prompts when the user hasn't
          // overridden them yet (older configs may have empty strings).
          summary_prompt: savedConfig.summary_prompt || DEFAULT_SUMMARY_PROMPT,
          translation_prompt: savedConfig.translation_prompt ?? DEFAULT_TRANSLATION_PROMPT,
          google_proxy: savedConfig.google_proxy || DEFAULT_PROXY,
          microsoft_proxy: savedConfig.microsoft_proxy || DEFAULT_PROXY,
        });
      } else {
        console.error("Failed to load config:", configResult.reason);
      }

      if (runningResult.status === "fulfilled") {
        const running = runningResult.value;
        setIsRunning(running);
        isRunningRef.current = running;
        if (running) setStatus("Running");
      } else {
        console.error("Failed to query watcher status:", runningResult.reason);
      }

      if (sessionsResult.status === "fulfilled") {
        setSessions(sessionsResult.value);
      } else {
        console.error("Failed to load sessions:", sessionsResult.reason);
      }

      const frontendInitMs = Math.max(0, Math.round(performance.now() - frontendInitBegin));
      const perceivedStartupMs = frontendInitMs + (webviewBootMs ?? 0);
      console.info(
        `[startup] frontend init completed in ${frontendInitMs}ms (webview_boot_ms=${webviewBootMs ?? "unknown"}, perceived_startup_ms=${perceivedStartupMs})`,
      );
      void invoke("log_startup_metric", {
        frontendInitMs,
        webviewBootMs,
        initSource: "frontend",
        configLoaded: configResult.status === "fulfilled",
        sessionsLoaded: sessionsResult.status === "fulfilled",
        watcherStateLoaded: runningResult.status === "fulfilled",
      }).catch(err => {
        console.warn("Failed to report startup metric:", err);
      });
    }

    void init();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

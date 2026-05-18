import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

export type UseCaptionVisibilityOptions = {
  /**
   * Mirrors the `hide_system_window` config flag. The initial visibility
   * defaults to the inverse of this value, and the visibility resets to
   * the inverse whenever the flag changes (e.g. user toggles it in
   * settings).
   */
  hideSystemWindow: boolean;
};

export type UseCaptionVisibilityResult = {
  isWindowVisible: boolean;
};

/**
 * Tracks whether the underlying caption source window (Windows
 * LiveCaptions / Teams) is currently shown to the user.
 *
 * Subscribes to the backend `caption-visibility` event and re-syncs
 * against the `hide_system_window` config whenever that flag flips so
 * the icon in the title bar stays in lockstep with the on-screen state.
 */
export function useCaptionVisibility({
  hideSystemWindow,
}: UseCaptionVisibilityOptions): UseCaptionVisibilityResult {
  const [isWindowVisible, setIsWindowVisible] = useState<boolean>(!hideSystemWindow);

  useEffect(() => {
    const unlistenVisibility = listen<boolean>("caption-visibility", event => {
      setIsWindowVisible(event.payload);
    });
    return () => {
      unlistenVisibility.then(f => f());
    };
  }, []);

  useEffect(() => {
    setIsWindowVisible(!hideSystemWindow);
  }, [hideSystemWindow]);

  return { isWindowVisible };
}

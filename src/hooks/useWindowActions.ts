import { useCallback, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type UseWindowActionsResult = {
  handleWindowMinimize: () => void;
  handleWindowMaximize: () => void;
  handleWindowClose: () => void;
};

/**
 * Custom titlebar actions: minimize / maximize-toggle / close.
 *
 * All three swallow exceptions from the Tauri bridge so a transient
 * IPC failure (e.g. window being torn down) doesn't propagate into
 * React's render tree. The errors still surface in the console.
 */
export function useWindowActions(): UseWindowActionsResult {
  const runWindowAction = useCallback(
    async (action: (appWindow: ReturnType<typeof getCurrentWindow>) => Promise<void>) => {
      try {
        const appWindow = getCurrentWindow();
        await action(appWindow);
      } catch (err) {
        console.error("Window action failed:", err);
      }
    },
    [],
  );

  return useMemo(
    () => ({
      handleWindowMinimize: () => {
        void runWindowAction(window => window.minimize());
      },
      handleWindowMaximize: () => {
        void runWindowAction(window => window.toggleMaximize());
      },
      handleWindowClose: () => {
        void runWindowAction(window => window.close());
      },
    }),
    [runWindowAction],
  );
}

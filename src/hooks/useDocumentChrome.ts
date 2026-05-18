import { useEffect } from "react";

export type UseDocumentChromeOptions = {
  theme: string | undefined;
  opacity: number | undefined;
};

/**
 * Side effects that paint the surrounding document chrome based on
 * config:
 *  - `data-theme` attribute on `<html>` (drives CSS variables; falls
 *    back to "dark" when the config theme is empty).
 *  - `--app-opacity` CSS custom property on `<html>` (falls back to
 *    `1.0`).
 *  - In production builds, suppress the native context menu so
 *    right-click doesn't surface the WebView2 dev menu. Skipped in dev
 *    so the inspector "Inspect" entry stays reachable.
 */
export function useDocumentChrome({ theme, opacity }: UseDocumentChromeOptions): void {
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme || "dark");
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--app-opacity",
      (opacity ?? 1.0).toString(),
    );
  }, [opacity]);

  useEffect(() => {
    if (!import.meta.env.PROD) {
      return;
    }

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };

    document.addEventListener("contextmenu", handleContextMenu);
    return () => {
      document.removeEventListener("contextmenu", handleContextMenu);
    };
  }, []);
}

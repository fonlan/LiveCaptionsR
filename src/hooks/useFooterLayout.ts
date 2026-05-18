import { useLayoutEffect, useRef, useState } from "react";

const FOOTER_HORIZONTAL_PADDING_PX = 48;

export type UseFooterLayoutOptions = {
  /**
   * Signals that should trigger a re-measurement even when no size has
   * changed (e.g. localized labels, status text, app version).
   */
  signals: ReadonlyArray<unknown>;
};

export type UseFooterLayoutResult = {
  footerRef: React.RefObject<HTMLElement | null>;
  footerStatusRef: React.RefObject<HTMLDivElement | null>;
  footerTrailingRef: React.RefObject<HTMLDivElement | null>;
  footerExpandedControlsMeasureRef: React.RefObject<HTMLDivElement | null>;
  isFooterToggleLabelCollapsed: boolean;
};

/**
 * Tracks footer layout via `ResizeObserver` and decides whether the centre
 * toggle button needs to drop its label to keep both side panels visible.
 *
 * Consumers attach the returned refs to the footer container, the left
 * status block, the right trailing block, and an off-screen measurement
 * clone of the expanded controls. The `signals` array re-runs the
 * measurement when external state (e.g. translated strings) changes.
 */
export function useFooterLayout({ signals }: UseFooterLayoutOptions): UseFooterLayoutResult {
  const footerRef = useRef<HTMLElement>(null);
  const footerStatusRef = useRef<HTMLDivElement>(null);
  const footerTrailingRef = useRef<HTMLDivElement>(null);
  const footerExpandedControlsMeasureRef = useRef<HTMLDivElement>(null);
  const [isFooterToggleLabelCollapsed, setIsFooterToggleLabelCollapsed] = useState(false);

  useLayoutEffect(() => {
    const footer = footerRef.current;
    const statusNode = footerStatusRef.current;
    const trailingNode = footerTrailingRef.current;
    const measureNode = footerExpandedControlsMeasureRef.current;

    if (
      !footer ||
      !statusNode ||
      !trailingNode ||
      !measureNode ||
      typeof ResizeObserver === "undefined"
    ) {
      return;
    }

    const syncFooterToggleLabelCollapse = () => {
      const footerWidth = footer.clientWidth;
      const expandedControlsWidth = measureNode.offsetWidth;

      if (footerWidth === 0 || expandedControlsWidth === 0) {
        setIsFooterToggleLabelCollapsed(false);
        return;
      }

      const maxSideWidth = Math.max(statusNode.offsetWidth, trailingNode.offsetWidth);
      const centeredWidthBudget = Math.max(
        0,
        footerWidth - maxSideWidth * 2 - FOOTER_HORIZONTAL_PADDING_PX,
      );
      setIsFooterToggleLabelCollapsed(expandedControlsWidth > centeredWidthBudget);
    };

    const observer = new ResizeObserver(syncFooterToggleLabelCollapse);
    observer.observe(footer);
    observer.observe(statusNode);
    observer.observe(trailingNode);
    observer.observe(measureNode);
    syncFooterToggleLabelCollapse();

    return () => {
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, signals);

  return {
    footerRef,
    footerStatusRef,
    footerTrailingRef,
    footerExpandedControlsMeasureRef,
    isFooterToggleLabelCollapsed,
  };
}

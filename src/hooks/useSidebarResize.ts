import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

export type UseSidebarResizeOptions = {
  /** Initial width when no value has been persisted yet. */
  defaultWidth: number;
  /**
   * Width clamp applied during the drag. Owned by the caller because
   * the two sidebars in the app constrain each other and can't share a
   * single hook instance.
   */
  clamp: (value: number) => number;
  /**
   * Sign of the mouse delta relative to "wider": +1 when dragging the
   * mouse to the right grows the sidebar (left-anchored sidebar), -1
   * when dragging to the right shrinks it (right-anchored sidebar).
   */
  deltaSign: 1 | -1;
};

export type UseSidebarResizeResult = {
  width: number;
  setWidth: React.Dispatch<React.SetStateAction<number>>;
  isResizing: boolean;
  /**
   * Attach to the resize-handle's `onMouseDown`. Captures the current
   * pointer position + width and starts the global drag effect.
   */
  handleResizeStart: (event: ReactMouseEvent) => void;
};

/**
 * Drag-to-resize state machine for a single sidebar. Owns the width
 * state, the "drag in progress" flag, the start-position ref, the
 * global mousemove/mouseup listeners (only attached while resizing),
 * and the body cursor/userSelect overrides.
 *
 * Two instances coexist in App.tsx for the left (sessions) and right
 * (chat) sidebars; both clamps depend on each other's width, so the
 * caller owns the clamp callback and any cross-sidebar
 * recompute/effect coordination.
 */
export function useSidebarResize({
  defaultWidth,
  clamp,
  deltaSign,
}: UseSidebarResizeOptions): UseSidebarResizeResult {
  const [width, setWidth] = useState<number>(defaultWidth);
  const [isResizing, setIsResizing] = useState<boolean>(false);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      resizeRef.current = { startX: event.clientX, startWidth: width };
      setIsResizing(true);
    },
    [width],
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (event: MouseEvent) => {
      const resizeState = resizeRef.current;
      if (!resizeState) return;
      const deltaX = (event.clientX - resizeState.startX) * deltaSign;
      setWidth(clamp(resizeState.startWidth + deltaX));
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      resizeRef.current = null;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [clamp, deltaSign, isResizing]);

  return { width, setWidth, isResizing, handleResizeStart };
}

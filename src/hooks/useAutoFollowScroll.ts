import { useCallback, useEffect, useRef, useState } from "react";
import type { WheelEvent as ReactWheelEvent } from "react";

const AUTO_FOLLOW_ENABLE_THRESHOLD = 8;
const AUTO_FOLLOW_DISABLE_THRESHOLD = 120;
const AUTO_FOLLOW_DRIFT_GUARD_MS = 240;
const STICK_TO_BOTTOM_EPSILON = 4;
const USER_SCROLL_INTENT_TIMEOUT_MS = 450;

export type UseAutoFollowScrollOptions = {
  /**
   * Values that should trigger a "content changed -> snap to bottom"
   * check while auto-follow is on (e.g. cards array, partial text).
   */
  contentSignals: ReadonlyArray<unknown>;
};

export type UseAutoFollowScrollResult = {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  autoFollow: boolean;
  setAutoFollow: React.Dispatch<React.SetStateAction<boolean>>;
  autoFollowRef: React.MutableRefObject<boolean>;
  /**
   * Imperatively disable auto-follow. Equivalent to
   * `setAutoFollow(false); autoFollowRef.current = false;` but does both
   * atomically so callers don't drift.
   */
  disableAutoFollow: () => void;
  listScrollTop: number;
  listViewportHeight: number;
  handleScrollWheel: (event: ReactWheelEvent<HTMLDivElement>) => void;
};

/**
 * Self-contained auto-follow scroll state machine for the caption list.
 *
 * Owns the scroll container ref, the `autoFollow` flag (plus its mirror
 * ref for non-rerendering reads on hot paths), and the rAF-throttled
 * `listScrollTop` / `listViewportHeight` signals consumed by the virtual
 * list. Re-snaps to the bottom whenever any `contentSignals` change while
 * auto-follow is on, but yields to the user if they scrolled away. Users
 * who scroll back to the bottom re-enable auto-follow automatically.
 */
export function useAutoFollowScroll({
  contentSignals,
}: UseAutoFollowScrollOptions): UseAutoFollowScrollResult {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [autoFollow, setAutoFollow] = useState<boolean>(true);
  const autoFollowRef = useRef<boolean>(true);
  const [listScrollTop, setListScrollTop] = useState(0);
  const [listViewportHeight, setListViewportHeight] = useState(0);

  const lastScrollTopRef = useRef<number>(0);
  const lastAutoFollowSyncAtRef = useRef<number>(0);
  const lastUserScrollIntentAtRef = useRef<number>(0);
  const scrollRafRef = useRef<number | null>(null);
  const queuedScrollTopRef = useRef<number>(0);
  const queuedViewportHeightRef = useRef<number>(0);

  const markUserScrollIntent = useCallback(() => {
    lastUserScrollIntentAtRef.current = window.performance.now();
  }, []);

  const hasRecentUserScrollIntent = useCallback(() => {
    return (
      window.performance.now() - lastUserScrollIntentAtRef.current <=
      USER_SCROLL_INTENT_TIMEOUT_MS
    );
  }, []);

  const snapToBottomIfNeeded = useCallback((container: HTMLDivElement) => {
    const targetTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const distanceToBottom = targetTop - container.scrollTop;

    if (distanceToBottom > STICK_TO_BOTTOM_EPSILON) {
      lastAutoFollowSyncAtRef.current = window.performance.now();
      container.scrollTo({ top: targetTop, behavior: "auto" });
      return true;
    }

    return false;
  }, []);

  const handleScrollWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (!event.ctrlKey) {
        // Keep native wheel physics so Windows mouse-wheel feel follows
        // OS/browser settings.
        markUserScrollIntent();
      }
    },
    [markUserScrollIntent],
  );

  const disableAutoFollow = useCallback(() => {
    autoFollowRef.current = false;
    setAutoFollow(false);
  }, []);

  useEffect(() => {
    autoFollowRef.current = autoFollow;
  }, [autoFollow]);

  // Re-snap to the bottom whenever fresh content arrives while auto-follow
  // is on. `contentSignals` lets callers decide what counts as "content"
  // (cards array, partial text, index map, etc.).
  useEffect(() => {
    if (!autoFollow) {
      return;
    }
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }
    lastAutoFollowSyncAtRef.current = window.performance.now();
    snapToBottomIfNeeded(container);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFollow, snapToBottomIfNeeded, ...contentSignals]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    setListViewportHeight(container.clientHeight);
    lastScrollTopRef.current = container.scrollTop;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const distanceToBottom = scrollHeight - scrollTop - clientHeight;
      const scrollingUp = scrollTop + 2 < lastScrollTopRef.current;
      const userScrollLikely = hasRecentUserScrollIntent();
      const recentAutoFollowSync =
        window.performance.now() - lastAutoFollowSyncAtRef.current <=
        AUTO_FOLLOW_DRIFT_GUARD_MS;
      lastScrollTopRef.current = scrollTop;

      queuedScrollTopRef.current = scrollTop;
      queuedViewportHeightRef.current = clientHeight;
      if (scrollRafRef.current === null) {
        scrollRafRef.current = window.requestAnimationFrame(() => {
          setListScrollTop(queuedScrollTopRef.current);
          setListViewportHeight(prev =>
            prev === queuedViewportHeightRef.current ? prev : queuedViewportHeightRef.current,
          );
          scrollRafRef.current = null;
        });
      }

      if (autoFollowRef.current) {
        if (!userScrollLikely && recentAutoFollowSync) {
          snapToBottomIfNeeded(container);
          return;
        }

        if (scrollingUp && distanceToBottom > AUTO_FOLLOW_ENABLE_THRESHOLD) {
          autoFollowRef.current = false;
          setAutoFollow(false);
          return;
        }
        if (distanceToBottom > AUTO_FOLLOW_DISABLE_THRESHOLD) {
          autoFollowRef.current = false;
          setAutoFollow(false);
        }
      } else if (distanceToBottom <= AUTO_FOLLOW_ENABLE_THRESHOLD) {
        lastAutoFollowSyncAtRef.current = window.performance.now();
        autoFollowRef.current = true;
        setAutoFollow(true);
      }
    };

    const handleResize = () => {
      const nextHeight = container.clientHeight;
      setListViewportHeight(prev => (prev === nextHeight ? prev : nextHeight));
    };

    container.addEventListener("scroll", handleScroll);
    window.addEventListener("resize", handleResize);

    handleScroll();

    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
      }
      container.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleResize);
    };
  }, [hasRecentUserScrollIntent, snapToBottomIfNeeded]);

  return {
    scrollContainerRef,
    autoFollow,
    setAutoFollow,
    autoFollowRef,
    disableAutoFollow,
    listScrollTop,
    listViewportHeight,
    handleScrollWheel,
  };
}

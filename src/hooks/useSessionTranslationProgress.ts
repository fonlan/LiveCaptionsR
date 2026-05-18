import { useCallback, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import type { AddToast } from "./useToasts";

export type UseSessionTranslationProgressOptions = {
  addToast: AddToast;
  t: TFunction;
};

export type UseSessionTranslationProgressResult = {
  isSessionTranslating: boolean;
  sessionTranslationTotal: number;
  sessionTranslationCompleted: number;
  /** Percent (0-100) of the current batch, clamped to integer. */
  sessionTranslationProgressPercent: number;
  /** Live access to the batch id for guarded async callbacks. */
  activeSessionTranslationBatchIdRef: React.MutableRefObject<string | null>;
  /**
   * Mark the start of a new batch. Resets the counter and the
   * `isSessionTranslating` flag; if `total === 0` the hook stays
   * idle (no batch).
   */
  startSessionTranslationProgress: (batchId: string, total: number) => void;
  /**
   * Increment the completed counter for `batchId` and emit a success
   * toast once it reaches `total`. No-ops when the batch id doesn't
   * match (e.g. user already cancelled / restarted).
   */
  markSessionTranslationProgressStep: (batchId: string) => void;
  /** Wipe the batch state entirely; safe to call from cancel paths. */
  resetSessionTranslationProgress: () => void;
};

/**
 * Counts how many of the cards in the active session's "translate all"
 * batch have completed. Pairs the React state used for rendering the
 * progress bar with a parallel set of refs so async translation result
 * handlers can check the batch id without re-rendering.
 *
 * Emits a single success toast when the batch reaches its total so the
 * caller doesn't have to thread that check through every callsite.
 */
export function useSessionTranslationProgress({
  addToast,
  t,
}: UseSessionTranslationProgressOptions): UseSessionTranslationProgressResult {
  const [isSessionTranslating, setIsSessionTranslating] = useState<boolean>(false);
  const [sessionTranslationTotal, setSessionTranslationTotal] = useState<number>(0);
  const [sessionTranslationCompleted, setSessionTranslationCompleted] = useState<number>(0);

  const activeSessionTranslationBatchIdRef = useRef<string | null>(null);
  const totalRef = useRef<number>(0);
  const completedRef = useRef<number>(0);

  const resetSessionTranslationProgress = useCallback(() => {
    activeSessionTranslationBatchIdRef.current = null;
    totalRef.current = 0;
    completedRef.current = 0;
    setIsSessionTranslating(false);
    setSessionTranslationTotal(0);
    setSessionTranslationCompleted(0);
  }, []);

  const startSessionTranslationProgress = useCallback(
    (batchId: string, total: number) => {
      activeSessionTranslationBatchIdRef.current = batchId;
      totalRef.current = total;
      completedRef.current = 0;
      setIsSessionTranslating(total > 0);
      setSessionTranslationTotal(total);
      setSessionTranslationCompleted(0);
    },
    [],
  );

  const markSessionTranslationProgressStep = useCallback(
    (batchId: string) => {
      if (activeSessionTranslationBatchIdRef.current !== batchId) return;

      const total = totalRef.current;
      if (total <= 0) return;

      const next = Math.min(total, completedRef.current + 1);
      completedRef.current = next;
      setSessionTranslationCompleted(next);

      if (next >= total) {
        setIsSessionTranslating(false);
        addToast(
          "success",
          t("toast.sessionTranslationComplete", { completed: next, total }),
        );
      }
    },
    [addToast, t],
  );

  const sessionTranslationProgressPercent = useMemo(
    () =>
      sessionTranslationTotal > 0
        ? Math.round((sessionTranslationCompleted / sessionTranslationTotal) * 100)
        : 0,
    [sessionTranslationCompleted, sessionTranslationTotal],
  );

  return {
    isSessionTranslating,
    sessionTranslationTotal,
    sessionTranslationCompleted,
    sessionTranslationProgressPercent,
    activeSessionTranslationBatchIdRef,
    startSessionTranslationProgress,
    markSessionTranslationProgressStep,
    resetSessionTranslationProgress,
  };
}

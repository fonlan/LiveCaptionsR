import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { generateId } from "../utils/textUtils";

const SUMMARY_TYPEWRITER_INTERVAL_MS = 16;
const SUMMARY_TYPEWRITER_CHARS_PER_TICK = 3;

export type SummaryStreamEvent = {
  request_id: string;
  status: "chunk" | "done" | "error";
  chunk?: string | null;
  full_text?: string | null;
  error?: string | null;
};

export type UseSummaryStreamResult = {
  summaryText: string;
  setSummaryText: React.Dispatch<React.SetStateAction<string>>;
  isSummarizing: boolean;
  /**
   * Reset the typewriter and arm a fresh `request_id` for the next
   * stream. Returns the generated id so the caller can pass it to the
   * backend invoke. Also clears `summaryText` and flips `isSummarizing`
   * to `true`.
   */
  beginSummary: () => string;
  /**
   * Abort the current stream and surface an error message. Safe to
   * call from `catch` blocks around the backend invoke.
   */
  failSummary: (errorMessage: string) => void;
};

/**
 * Owns the streamed-summary state machine: the visible `summaryText`,
 * the `isSummarizing` flag, the in-flight `request_id`, and a small
 * typewriter that paces incoming chunks so the UI doesn't flash on
 * fast providers. Subscribes to the backend `summary-stream` event for
 * its lifetime.
 *
 * Callers initiate a new summary with `beginSummary()` (which returns
 * the request id to pass to the backend invoke), and only need to call
 * `failSummary(msg)` if the kickoff itself rejects; the hook handles
 * chunks/done/error from the event stream on its own.
 */
export function useSummaryStream(): UseSummaryStreamResult {
  const [summaryText, setSummaryText] = useState<string>("");
  const [isSummarizing, setIsSummarizing] = useState<boolean>(false);

  const activeRequestIdRef = useRef<string | null>(null);
  const typingQueueRef = useRef<string>("");
  const typingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamDoneRef = useRef<boolean>(false);
  const finalTextRef = useRef<string>("");

  const stopTypewriter = useCallback(() => {
    if (typingTimerRef.current) {
      clearInterval(typingTimerRef.current);
      typingTimerRef.current = null;
    }
  }, []);

  const finishStreamIfReady = useCallback(() => {
    if (!streamDoneRef.current || typingQueueRef.current.length > 0) {
      return;
    }

    stopTypewriter();
    activeRequestIdRef.current = null;
    const finalText = finalTextRef.current;
    setSummaryText(currentText => (currentText !== finalText ? finalText : currentText));
    setIsSummarizing(false);
  }, [stopTypewriter]);

  const ensureTypewriterRunning = useCallback(() => {
    if (typingTimerRef.current) {
      return;
    }

    typingTimerRef.current = setInterval(() => {
      const queue = typingQueueRef.current;
      if (queue.length === 0) {
        finishStreamIfReady();
        return;
      }

      const take = Math.min(SUMMARY_TYPEWRITER_CHARS_PER_TICK, queue.length);
      const nextChunk = queue.slice(0, take);
      typingQueueRef.current = queue.slice(take);
      setSummaryText(prev => prev + nextChunk);

      if (typingQueueRef.current.length === 0) {
        finishStreamIfReady();
      }
    }, SUMMARY_TYPEWRITER_INTERVAL_MS);
  }, [finishStreamIfReady]);

  const beginSummary = useCallback((): string => {
    setIsSummarizing(true);
    setSummaryText("");
    stopTypewriter();
    typingQueueRef.current = "";
    streamDoneRef.current = false;
    finalTextRef.current = "";
    const requestId = generateId();
    activeRequestIdRef.current = requestId;
    return requestId;
  }, [stopTypewriter]);

  const failSummary = useCallback(
    (errorMessage: string) => {
      activeRequestIdRef.current = null;
      typingQueueRef.current = "";
      finalTextRef.current = "";
      streamDoneRef.current = true;
      stopTypewriter();
      setSummaryText(errorMessage);
      setIsSummarizing(false);
    },
    [stopTypewriter],
  );

  useEffect(() => {
    const unlistenSummaryStream = listen<SummaryStreamEvent>("summary-stream", event => {
      const payload = event.payload;
      if (
        !activeRequestIdRef.current ||
        payload.request_id !== activeRequestIdRef.current
      ) {
        return;
      }

      if (payload.status === "chunk") {
        if (payload.chunk) {
          typingQueueRef.current += payload.chunk;
          ensureTypewriterRunning();
        }
        return;
      }

      if (payload.status === "done") {
        finalTextRef.current = payload.full_text ?? finalTextRef.current;
        streamDoneRef.current = true;
        finishStreamIfReady();
        return;
      }

      if (payload.status === "error") {
        const errorMessage = payload.error
          ? `Error generating summary: ${payload.error}`
          : "Error generating summary";
        failSummary(errorMessage);
      }
    });

    return () => {
      unlistenSummaryStream.then(f => f());
    };
  }, [ensureTypewriterRunning, failSummary, finishStreamIfReady]);

  useEffect(() => {
    return () => {
      stopTypewriter();
    };
  }, [stopTypewriter]);

  return {
    summaryText,
    setSummaryText,
    isSummarizing,
    beginSummary,
    failSummary,
  };
}

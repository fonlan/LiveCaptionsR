import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SentenceCard, Session, SessionMetadata } from "../types";

const SESSION_AUTO_SAVE_DEBOUNCE_MS = 2000;

export type ActiveSession = {
  id: string;
  name: string;
  createdAt: number;
};

export type UseSessionsOptions = {
  /**
   * Live cards backing the active session. Used by the debounced
   * auto-save loop. Pass through your `cards` state directly.
   */
  cards: SentenceCard[];
};

export type UseSessionsResult = {
  sessions: SessionMetadata[];
  setSessions: React.Dispatch<React.SetStateAction<SessionMetadata[]>>;
  refreshSessionList: () => Promise<void>;

  activeSessionId: string | null;
  activeSessionName: string;
  activeSessionCreatedAt: number;

  activeSessionIdRef: React.MutableRefObject<string | null>;
  activeSessionNameRef: React.MutableRefObject<string>;
  activeSessionCreatedAtRef: React.MutableRefObject<number>;

  /** Replace the active session triple atomically. */
  setActiveSession: (session: ActiveSession | null) => void;
  /** Convenience for `setActiveSession(null)`. */
  clearActiveSession: () => void;
  /** Update only the active session name (e.g. after a rename). */
  setActiveSessionName: (name: string) => void;
};

/**
 * Owns session-list state plus the active-session triple
 * (id / name / createdAt). Keeps mirror refs in sync for hot paths and
 * runs a debounced "save the cards of the current session" loop so the
 * caller only has to pass the live `cards` array.
 *
 * Higher-level handlers (create/select/delete/clear/rename) still live
 * in the caller because they need to coordinate with caption state
 * (cards, partial text, autoFollow, etc.); this hook just exposes the
 * primitives they need.
 */
export function useSessions({ cards }: UseSessionsOptions): UseSessionsResult {
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSessionName, setActiveSessionNameState] = useState<string>("");
  const [activeSessionCreatedAt, setActiveSessionCreatedAt] = useState<number>(0);

  const activeSessionIdRef = useRef<string | null>(null);
  const activeSessionNameRef = useRef<string>("");
  const activeSessionCreatedAtRef = useRef<number>(0);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    activeSessionNameRef.current = activeSessionName;
    activeSessionCreatedAtRef.current = activeSessionCreatedAt;
  }, [activeSessionId, activeSessionName, activeSessionCreatedAt]);

  // Debounced auto-save loop. `cards` triggers the save; we read the
  // active session triple at fire time so renames between keystrokes
  // still apply.
  useEffect(() => {
    if (!activeSessionId || !activeSessionCreatedAt) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      const sessionToSave: Session = {
        id: activeSessionId,
        name: activeSessionName,
        created_at: activeSessionCreatedAt,
        cards,
      };
      invoke("save_session_data", { session: sessionToSave }).catch(e =>
        console.error("Auto-save failed", e),
      );
    }, SESSION_AUTO_SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [cards, activeSessionId, activeSessionName, activeSessionCreatedAt]);

  const refreshSessionList = useCallback(async () => {
    try {
      const list = await invoke<SessionMetadata[]>("get_sessions");
      setSessions(list);
    } catch (e) {
      console.error("Failed to load sessions:", e);
    }
  }, []);

  const setActiveSession = useCallback((session: ActiveSession | null) => {
    if (session) {
      setActiveSessionId(session.id);
      setActiveSessionNameState(session.name);
      setActiveSessionCreatedAt(session.createdAt);
    } else {
      setActiveSessionId(null);
      setActiveSessionNameState("");
      setActiveSessionCreatedAt(0);
    }
  }, []);

  const clearActiveSession = useCallback(() => {
    setActiveSession(null);
  }, [setActiveSession]);

  const setActiveSessionName = useCallback((name: string) => {
    setActiveSessionNameState(name);
  }, []);

  return {
    sessions,
    setSessions,
    refreshSessionList,
    activeSessionId,
    activeSessionName,
    activeSessionCreatedAt,
    activeSessionIdRef,
    activeSessionNameRef,
    activeSessionCreatedAtRef,
    setActiveSession,
    clearActiveSession,
    setActiveSessionName,
  };
}

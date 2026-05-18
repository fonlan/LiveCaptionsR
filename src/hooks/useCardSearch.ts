import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import type { SentenceCard } from "../types";
import type { AddToast } from "./useToasts";

export type CardSearchMatch = {
  cardId: string;
  cardNumber: number;
};

export const normalizeCardSearchKeyword = (value: string): string =>
  value.trim().toLocaleLowerCase();

export const buildCardSearchHaystack = (
  card: SentenceCard,
  translatedText?: string | null,
): string => `${card.user ?? ""}\n${card.original}\n${translatedText ?? ""}`.toLocaleLowerCase();

export type UseCardSearchOptions = {
  cards: SentenceCard[];
  tempTranslations: Record<string, { translated?: string | null } | undefined>;
  /** Active session id; toggling it resets the search panel. */
  activeSessionId: string | null | undefined;
  /** Scroll the card list to the given 1-based card number. */
  jumpToCardByNumber: (cardNumber: number) => boolean | void;
  addToast: AddToast;
  t: TFunction;
  /**
   * Modal flags that should suppress the global Ctrl/Cmd+F shortcut while
   * any of them is true (i.e. a modal already owns the keyboard).
   */
  modalFlags: ReadonlyArray<boolean>;
};

export type UseCardSearchResult = {
  isCardSearchOpen: boolean;
  cardSearchQuery: string;
  setCardSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  normalizedCardSearchQuery: string;
  activeCardSearchMatchIndex: number;
  cardSearchMatches: CardSearchMatch[];
  cardSearchInputRef: React.RefObject<HTMLInputElement | null>;
  handleOpenCardSearch: () => void;
  handleCloseCardSearch: () => void;
  handleToggleCardSearch: () => void;
  handleNavigateCardSearch: (direction: "next" | "prev") => void;
  handleCardSearchKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
};

/**
 * Owns the in-app card-search panel (Ctrl/Cmd+F) lifecycle: the open/closed
 * state, the query string, derived matches against the visible card list, and
 * keyboard wiring for prev/next navigation. The `modalFlags` argument lets the
 * caller suppress the global shortcut while any of its modals is open.
 */
export function useCardSearch({
  cards,
  tempTranslations,
  activeSessionId,
  jumpToCardByNumber,
  addToast,
  t,
  modalFlags,
}: UseCardSearchOptions): UseCardSearchResult {
  const [isCardSearchOpen, setIsCardSearchOpen] = useState(false);
  const [cardSearchQuery, setCardSearchQuery] = useState("");
  const [activeCardSearchMatchIndex, setActiveCardSearchMatchIndex] = useState(-1);
  const cardSearchInputRef = useRef<HTMLInputElement>(null);

  const normalizedCardSearchQuery = useMemo(
    () => normalizeCardSearchKeyword(cardSearchQuery),
    [cardSearchQuery],
  );

  const cardSearchMatches = useMemo<CardSearchMatch[]>(() => {
    if (!isCardSearchOpen || !normalizedCardSearchQuery) {
      return [];
    }

    return cards.reduce<CardSearchMatch[]>((matches, card, index) => {
      const translatedText = tempTranslations[card.id]?.translated ?? card.translated;
      const haystack = buildCardSearchHaystack(card, translatedText);

      if (haystack.includes(normalizedCardSearchQuery)) {
        matches.push({
          cardId: card.id,
          cardNumber: index + 1,
        });
      }

      return matches;
    }, []);
  }, [cards, isCardSearchOpen, normalizedCardSearchQuery, tempTranslations]);

  useEffect(() => {
    setIsCardSearchOpen(false);
    setCardSearchQuery("");
    setActiveCardSearchMatchIndex(-1);
  }, [activeSessionId]);

  useEffect(() => {
    if (!isCardSearchOpen) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      cardSearchInputRef.current?.focus();
      cardSearchInputRef.current?.select();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [isCardSearchOpen]);

  useEffect(() => {
    setActiveCardSearchMatchIndex(-1);
  }, [normalizedCardSearchQuery]);

  useEffect(() => {
    setActiveCardSearchMatchIndex(prev => {
      if (!normalizedCardSearchQuery || cardSearchMatches.length === 0) {
        return -1;
      }

      if (prev < 0) {
        return prev;
      }

      return Math.min(prev, cardSearchMatches.length - 1);
    });
  }, [cardSearchMatches.length, normalizedCardSearchQuery]);

  const handleOpenCardSearch = useCallback(() => {
    setIsCardSearchOpen(true);

    window.requestAnimationFrame(() => {
      cardSearchInputRef.current?.focus();
      cardSearchInputRef.current?.select();
    });
  }, []);

  const handleCloseCardSearch = useCallback(() => {
    setIsCardSearchOpen(false);
    cardSearchInputRef.current?.blur();
  }, []);

  const handleToggleCardSearch = useCallback(() => {
    setIsCardSearchOpen(prev => {
      const next = !prev;
      if (next) {
        window.requestAnimationFrame(() => {
          cardSearchInputRef.current?.focus();
          cardSearchInputRef.current?.select();
        });
      }
      return next;
    });
  }, []);

  const handleNavigateCardSearch = useCallback(
    (direction: "next" | "prev") => {
      if (!normalizedCardSearchQuery) {
        cardSearchInputRef.current?.focus();
        return;
      }

      if (cardSearchMatches.length === 0) {
        addToast("error", t("headerSearch.noResults"));
        return;
      }

      const nextIndex =
        activeCardSearchMatchIndex < 0
          ? direction === "next"
            ? 0
            : cardSearchMatches.length - 1
          : (activeCardSearchMatchIndex +
              (direction === "next" ? 1 : -1) +
              cardSearchMatches.length) %
            cardSearchMatches.length;

      setActiveCardSearchMatchIndex(nextIndex);
      jumpToCardByNumber(cardSearchMatches[nextIndex].cardNumber);
    },
    [
      activeCardSearchMatchIndex,
      addToast,
      cardSearchMatches,
      jumpToCardByNumber,
      normalizedCardSearchQuery,
      t,
    ],
  );

  const handleCardSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") {
        return;
      }

      event.preventDefault();
      handleNavigateCardSearch(event.shiftKey ? "prev" : "next");
    },
    [handleNavigateCardSearch],
  );

  const anyModalOpen = modalFlags.some(Boolean);
  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (anyModalOpen) {
        return;
      }

      if (
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        (event.key === "Escape" || event.key === "Esc") &&
        isCardSearchOpen
      ) {
        event.preventDefault();
        handleCloseCardSearch();
        return;
      }

      const isFindShortcut =
        (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f";
      if (!isFindShortcut) {
        return;
      }

      event.preventDefault();
      handleOpenCardSearch();
    };

    document.addEventListener("keydown", handleGlobalKeyDown);

    return () => {
      document.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, [anyModalOpen, handleCloseCardSearch, handleOpenCardSearch, isCardSearchOpen]);

  return {
    isCardSearchOpen,
    cardSearchQuery,
    setCardSearchQuery,
    normalizedCardSearchQuery,
    activeCardSearchMatchIndex,
    cardSearchMatches,
    cardSearchInputRef,
    handleOpenCardSearch,
    handleCloseCardSearch,
    handleToggleCardSearch,
    handleNavigateCardSearch,
    handleCardSearchKeyDown,
  };
}

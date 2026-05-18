import { useCallback, useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import type { SentenceCard } from "../types";
import type { AddToast } from "./useToasts";

const CARD_JUMP_HIGHLIGHT_TIMEOUT_MS = 1800;
const CARD_JUMP_ANIMATION_TIMEOUT_MS = 1100;
const CARD_JUMP_RETRY_INTERVAL_MS = 24;
const CARD_JUMP_MAX_ATTEMPTS = 48;
const CARD_JUMP_VIEWPORT_CENTER_RATIO = 0.45;
const CARD_JUMP_SCROLL_STEP_MIN = 240;
const CARD_JUMP_SCROLL_STEP_FACTOR = 0.7;

const clampCardJumpScrollTop = (container: HTMLDivElement, top: number): number => {
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  return Math.max(0, Math.min(maxScrollTop, Math.round(top)));
};

const estimateCardJumpScrollTop = (
  container: HTMLDivElement,
  targetIndex: number,
  totalCards: number,
): number => {
  if (totalCards <= 1) return 0;
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const ratio = targetIndex / Math.max(1, totalCards - 1);
  return clampCardJumpScrollTop(
    container,
    maxScrollTop * ratio - container.clientHeight * CARD_JUMP_VIEWPORT_CENTER_RATIO,
  );
};

const collectRenderedCardEntries = (
  container: HTMLDivElement,
): Array<{ number: number; element: HTMLElement }> => {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-card-number]"))
    .map(element => ({
      number: Number.parseInt(element.dataset.cardNumber ?? "", 10),
      element,
    }))
    .filter(item => Number.isFinite(item.number) && item.number > 0)
    .sort((a, b) => a.number - b.number);
};

const triggerCardJumpAnimation = (node: HTMLElement) => {
  node.classList.remove("chat-card-jump-anim");
  // Force a reflow so re-adding the class actually replays the animation.
  void node.offsetWidth;
  node.classList.add("chat-card-jump-anim");
  window.setTimeout(() => {
    node.classList.remove("chat-card-jump-anim");
  }, CARD_JUMP_ANIMATION_TIMEOUT_MS);
};

export type UseCardJumpOptions = {
  /** Container that hosts the card list (from useAutoFollowScroll). */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** Live ref to the rendered cards array (1-based "card number" = index+1). */
  cardsRef: React.MutableRefObject<SentenceCard[]>;
  /** Disable auto-follow so the jump-scroll isn't fought by the snap loop. */
  disableAutoFollow: () => void;
  addToast: AddToast;
  t: TFunction;
};

export type UseCardJumpResult = {
  highlightedCardId: string | null;
  /** Clear any active jump highlight immediately. */
  clearHighlightedCard: () => void;
  /**
   * Highlight a card and auto-clear after
   * {@link CARD_JUMP_HIGHLIGHT_TIMEOUT_MS} ms. Used by both the
   * jump-to-card flow and direct callers (e.g. double-clicking the
   * header to scroll-to-top).
   */
  setJumpHighlightedCard: (cardId: string) => void;
  /**
   * Scroll to a 1-based card number, play the jump animation, and
   * highlight it. Returns `false` if the card doesn't exist or no
   * scroll container is attached yet.
   */
  jumpToCardByNumber: (cardNumber: number) => boolean;
};

/**
 * Owns the "jump to card N" UX: a transient highlight on the target
 * card, a one-shot CSS animation, and the iterative scroll loop that
 * homes in on virtualised cards which may not be rendered yet.
 *
 * Two timers are managed under the hood:
 *  - `jumpTimerRef`: schedules the next attempt of the scroll loop.
 *  - `highlightClearTimerRef`: clears the highlight after the timeout.
 *
 * Both are cleared on unmount.
 */
export function useCardJump({
  scrollContainerRef,
  cardsRef,
  disableAutoFollow,
  addToast,
  t,
}: UseCardJumpOptions): UseCardJumpResult {
  const [highlightedCardId, setHighlightedCardId] = useState<string | null>(null);
  const jumpTimerRef = useRef<number | null>(null);
  const highlightClearTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (jumpTimerRef.current !== null) {
        window.clearTimeout(jumpTimerRef.current);
      }
      if (highlightClearTimerRef.current !== null) {
        window.clearTimeout(highlightClearTimerRef.current);
      }
    };
  }, []);

  const clearHighlightedCard = useCallback(() => {
    setHighlightedCardId(null);
  }, []);

  const setJumpHighlightedCard = useCallback((cardId: string) => {
    setHighlightedCardId(cardId);
    if (highlightClearTimerRef.current !== null) {
      window.clearTimeout(highlightClearTimerRef.current);
    }
    highlightClearTimerRef.current = window.setTimeout(() => {
      setHighlightedCardId(prev => (prev === cardId ? null : prev));
      highlightClearTimerRef.current = null;
    }, CARD_JUMP_HIGHLIGHT_TIMEOUT_MS);
  }, []);

  const jumpToCardByNumber = useCallback(
    (cardNumber: number): boolean => {
      if (!Number.isInteger(cardNumber) || cardNumber <= 0) {
        return false;
      }

      const targetIndex = cardNumber - 1;
      const targetCard = cardsRef.current[targetIndex];
      if (!targetCard) {
        addToast("error", t("chat.cardNotFound", { number: cardNumber }));
        return false;
      }

      const container = scrollContainerRef.current;
      if (!container) {
        return false;
      }

      if (jumpTimerRef.current !== null) {
        window.clearTimeout(jumpTimerRef.current);
        jumpTimerRef.current = null;
      }

      disableAutoFollow();

      const totalCards = cardsRef.current.length;
      const targetScrollTop = estimateCardJumpScrollTop(container, targetIndex, totalCards);
      container.scrollTo({ top: targetScrollTop, behavior: "auto" });

      const locateAndScroll = (attempt: number) => {
        const node = container.querySelector<HTMLElement>(
          `[data-card-number="${cardNumber}"]`,
        );
        if (node) {
          node.scrollIntoView({ behavior: "smooth", block: "center" });
          triggerCardJumpAnimation(node);
          setJumpHighlightedCard(targetCard.id);
          return;
        }

        if (attempt >= CARD_JUMP_MAX_ATTEMPTS) {
          addToast("error", t("chat.cardJumpFailed", { number: cardNumber }));
          return;
        }

        const renderedEntries = collectRenderedCardEntries(container);

        if (renderedEntries.length === 0) {
          container.scrollTo({
            top: estimateCardJumpScrollTop(container, targetIndex, totalCards),
            behavior: "auto",
          });
        } else {
          const firstVisible = renderedEntries[0];
          const lastVisible = renderedEntries[renderedEntries.length - 1];
          const minVisible = firstVisible.number;
          const maxVisible = lastVisible.number;

          if (cardNumber < minVisible) {
            const estimated = estimateCardJumpScrollTop(container, targetIndex, totalCards);
            const nextTop =
              container.scrollTop -
              Math.max(
                CARD_JUMP_SCROLL_STEP_MIN,
                Math.abs(container.scrollTop - estimated) * CARD_JUMP_SCROLL_STEP_FACTOR,
              );
            container.scrollTo({
              top: clampCardJumpScrollTop(container, nextTop),
              behavior: "auto",
            });
          } else if (cardNumber > maxVisible) {
            const estimated = estimateCardJumpScrollTop(container, targetIndex, totalCards);
            const nextTop =
              container.scrollTop +
              Math.max(
                CARD_JUMP_SCROLL_STEP_MIN,
                Math.abs(estimated - container.scrollTop) * CARD_JUMP_SCROLL_STEP_FACTOR,
              );
            container.scrollTo({
              top: clampCardJumpScrollTop(container, nextTop),
              behavior: "auto",
            });
          } else {
            const cardSpan = Math.max(1, lastVisible.number - firstVisible.number);
            const pixelSpan = Math.max(
              1,
              lastVisible.element.offsetTop - firstVisible.element.offsetTop,
            );
            const pixelsPerCard = pixelSpan / cardSpan;
            const estimatedOffsetTop =
              firstVisible.element.offsetTop +
              (cardNumber - firstVisible.number) * pixelsPerCard;
            const desiredTop =
              estimatedOffsetTop - container.clientHeight * CARD_JUMP_VIEWPORT_CENTER_RATIO;
            container.scrollTo({
              top: clampCardJumpScrollTop(container, desiredTop),
              behavior: "auto",
            });
          }
        }

        jumpTimerRef.current = window.setTimeout(() => {
          jumpTimerRef.current = null;
          locateAndScroll(attempt + 1);
        }, CARD_JUMP_RETRY_INTERVAL_MS);
      };

      locateAndScroll(0);
      return true;
    },
    [addToast, cardsRef, disableAutoFollow, scrollContainerRef, setJumpHighlightedCard, t],
  );

  return {
    highlightedCardId,
    clearHighlightedCard,
    setJumpHighlightedCard,
    jumpToCardByNumber,
  };
}

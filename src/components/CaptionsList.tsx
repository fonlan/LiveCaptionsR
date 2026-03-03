import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconCopy, IconRetry, IconUser } from "./Icons";
import { SentenceCard, TranslationStatus } from "../types";

type TempTranslation = { translated: string; status: TranslationStatus };
const ITEM_ESTIMATED_HEIGHT = 110;
const CARD_VERTICAL_GAP = 12;
const OVERSCAN_ITEMS = 6;
const STABLE_RENDER_THRESHOLD = 700;

function lowerBound(offsets: number[], target: number): number {
  let low = 0;
  let high = offsets.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (offsets[mid] < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function upperBound(offsets: number[], target: number): number {
  let low = 0;
  let high = offsets.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (offsets[mid] <= target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

interface CaptionsListProps {
  addToast: (type: "success" | "error", message: string) => void;
  cards: SentenceCard[];
  hasActiveSession: boolean;
  onRetryTranslation: (cardId: string, originalText: string) => void;
  partialText: string;
  scrollTop: number;
  viewportHeight: number;
  tempTranslations: Record<string, TempTranslation>;
  highlightedCardId?: string | null;
}

interface CaptionCardItemProps {
  addToast: (type: "success" | "error", message: string) => void;
  card: SentenceCard;
  cardNumber: number;
  isVirtualized?: boolean;
  isHighlighted?: boolean;
  onRetryTranslation: (cardId: string, originalText: string) => void;
  onMeasuredHeight?: (cardId: string, height: number) => void;
  tempTranslation?: TempTranslation;
}

function areCaptionCardItemPropsEqual(
  prev: Readonly<CaptionCardItemProps>,
  next: Readonly<CaptionCardItemProps>
): boolean {
  return (
    prev.addToast === next.addToast
    && prev.card === next.card
    && prev.cardNumber === next.cardNumber
    && prev.isHighlighted === next.isHighlighted
    && prev.isVirtualized === next.isVirtualized
    && prev.onMeasuredHeight === next.onMeasuredHeight
    && prev.tempTranslation === next.tempTranslation
  );
}

const CaptionCardItem = memo(function CaptionCardItem({
  addToast,
  card,
  cardNumber,
  isVirtualized,
  isHighlighted,
  onRetryTranslation,
  onMeasuredHeight,
  tempTranslation,
}: CaptionCardItemProps) {
  const { t } = useTranslation();
  const itemRef = useRef<HTMLDivElement>(null);

  const displayTranslated = tempTranslation?.translated ?? card.translated;
  const displayStatus = tempTranslation?.status ?? card.status;
  const shouldShowTranslation =
    !!tempTranslation
    || (!!card.translated && card.translated.trim().length > 0)
    || displayStatus === "translating"
    || displayStatus === "error";

  const motionClass = isVirtualized
    ? "transition-colors duration-150"
    : "transition-colors duration-200 animate-slide-in";

  const handleCopyCard = useCallback(async () => {
    const originalText = card.original.trim();
    let translatedText = (displayTranslated ?? "").trim();

    if (!translatedText) {
      if (displayStatus === "translating") {
        translatedText = "...";
      } else if (displayStatus === "error") {
        translatedText = t("translation.failed");
      }
    }

    const content = translatedText
      ? `${originalText}\n\n**${translatedText}**`
      : originalText;

    if (!content.trim()) {
      return;
    }

    try {
      await navigator.clipboard.writeText(content);
      addToast("success", t("toast.copySuccess"));
    } catch (err) {
      console.error("Failed to copy caption card:", err);
      addToast("error", t("toast.copyFailed"));
    }
  }, [addToast, card.original, displayStatus, displayTranslated, t]);

  useLayoutEffect(() => {
    if (!onMeasuredHeight) return;

    const node = itemRef.current;
    if (!node) return;

    const reportHeight = () => {
      const nextHeight = node.offsetHeight;
      if (nextHeight > 0) {
        onMeasuredHeight(card.id, nextHeight);
      }
    };

    reportHeight();
  }, [card.id, card.original, card.retrying, displayStatus, displayTranslated, onMeasuredHeight]);

  return (
    <div
      ref={itemRef}
      data-card-number={cardNumber}
      className={`${isVirtualized ? 'caption-virtual-item ' : ''}bg-card rounded-lg p-3 pr-11 border border-transparent ${motionClass} relative hover:bg-card-hover hover:border-border mb-3 ${displayStatus === 'error' || (!displayStatus && displayTranslated === null) ? 'border-l-[3px] border-l-error' : ''} ${isHighlighted ? 'chat-card-jump-highlight bg-card-hover border-primary/80 shadow-[0_0_0_1px_rgba(59,130,246,0.35)]' : ''}`}
    >
      <button
        type="button"
        className="absolute right-2 top-2 h-7 w-7 rounded-full border-none flex items-center justify-center text-text-secondary cursor-pointer transition-all hover:bg-card-hover hover:text-text-primary"
        onClick={() => void handleCopyCard()}
        title={t("copy.cardTooltip")}
      >
        <IconCopy size={14} />
      </button>
      {card.user && (
        <div className="flex items-center gap-1.5 text-[11px] font-bold text-primary mb-1.5 uppercase tracking-[0.5px] opacity-90">
          <IconUser />
          <span>{card.user}</span>
        </div>
      )}
      <div className="text-[13px] text-text-secondary mb-1.5 leading-[1.4] select-text">{card.original}</div>
      {shouldShowTranslation && (
        <>
          {displayStatus === "translating" ? (
            <div className="flex gap-1 py-2 text-primary text-2xl leading-[12px] items-center">
              <span className="inline-block w-1.5 h-1.5 bg-current rounded-full animate-[typing_1.4s_infinite_ease-in-out_both_-0.32s]"></span>
              <span className="inline-block w-1.5 h-1.5 bg-current rounded-full animate-[typing_1.4s_infinite_ease-in-out_both_-0.16s]"></span>
              <span className="inline-block w-1.5 h-1.5 bg-current rounded-full animate-[typing_1.4s_infinite_ease-in-out_both]"></span>
            </div>
          ) : displayTranslated ? (
            <div className="text-base text-text-primary font-medium leading-normal select-text">{displayTranslated}</div>
          ) : (
            <div className="flex items-center justify-between mt-1">
              <span className="text-[13px] text-error select-text">{t("translation.failed")}</span>
              <button
                className="bg-transparent border-none text-text-secondary cursor-pointer p-1 hover:text-primary disabled:opacity-50"
                onClick={() => onRetryTranslation(card.id, card.original)}
                disabled={card.retrying}
                title={t("translation.retry")}
              >
                {card.retrying ? <span className="block w-4 h-4 border-2 border-white/10 border-t-current rounded-full animate-spin" /> : <IconRetry />}
              </button>
            </div>
          )}
        </>
      )}
      {card.timestamp && (
        <div className="absolute bottom-1 right-2 text-[10px] text-text-muted opacity-70">
          {new Date(card.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </div>
      )}
    </div>
  );
}, areCaptionCardItemPropsEqual);

function areCaptionsListPropsEqual(
  prev: Readonly<CaptionsListProps>,
  next: Readonly<CaptionsListProps>
): boolean {
  if (prev.addToast !== next.addToast) return false;
  if (prev.cards !== next.cards) return false;
  if (prev.hasActiveSession !== next.hasActiveSession) return false;
  if (prev.partialText !== next.partialText) return false;
  if (prev.tempTranslations !== next.tempTranslations) return false;
  if (prev.highlightedCardId !== next.highlightedCardId) return false;

  const prevVirtualized = prev.cards.length > STABLE_RENDER_THRESHOLD && prev.viewportHeight > 0;
  const nextVirtualized = next.cards.length > STABLE_RENDER_THRESHOLD && next.viewportHeight > 0;

  if (prevVirtualized || nextVirtualized) {
    return prev.scrollTop === next.scrollTop && prev.viewportHeight === next.viewportHeight;
  }

  return true;
}

export const CaptionsList = memo(function CaptionsList({
  addToast,
  cards,
  hasActiveSession,
  onRetryTranslation,
  partialText,
  scrollTop,
  viewportHeight,
  tempTranslations,
  highlightedCardId,
}: CaptionsListProps) {
  const { t } = useTranslation();
  const measuredHeightsRef = useRef<Record<string, number>>({});
  const avgMeasuredHeightRef = useRef<number>(ITEM_ESTIMATED_HEIGHT);
  const [heightVersion, setHeightVersion] = useState(0);
  const shouldVirtualize = cards.length > STABLE_RENDER_THRESHOLD && viewportHeight > 0;
  const totalItems = cards.length;

  const handleMeasuredHeight = useCallback((cardId: string, height: number) => {
    const previous = measuredHeightsRef.current[cardId];
    if (previous === height) {
      return;
    }

    measuredHeightsRef.current[cardId] = height;

    const measuredValues = Object.values(measuredHeightsRef.current);
    if (measuredValues.length > 0) {
      const sum = measuredValues.reduce((acc, value) => acc + value, 0);
      const avg = Math.round(sum / measuredValues.length);
      avgMeasuredHeightRef.current = Math.max(72, Math.min(220, avg));
    }

    setHeightVersion(prev => prev + 1);
  }, []);

  useEffect(() => {
    const validIds = new Set(cards.map(card => card.id));
    let changed = false;

    for (const id of Object.keys(measuredHeightsRef.current)) {
      if (!validIds.has(id)) {
        delete measuredHeightsRef.current[id];
        changed = true;
      }
    }

    if (changed) {
      setHeightVersion(prev => prev + 1);
    }
  }, [cards]);

  const prefixHeights = useMemo(() => {
    const offsets = new Array(cards.length + 1);
    offsets[0] = 0;

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const measured = measuredHeightsRef.current[card.id];
      const itemHeight = (measured ?? avgMeasuredHeightRef.current) + CARD_VERTICAL_GAP;
      offsets[i + 1] = offsets[i] + itemHeight;
    }

    return offsets;
  }, [cards, heightVersion]);

  const viewportBottom = scrollTop + viewportHeight;
  const startBaseIndex = shouldVirtualize
    ? Math.max(0, upperBound(prefixHeights, scrollTop) - 1)
    : 0;
  const endBaseIndex = shouldVirtualize
    ? Math.min(totalItems, lowerBound(prefixHeights, viewportBottom))
    : totalItems;

  const startIndex = shouldVirtualize
    ? Math.max(0, startBaseIndex - OVERSCAN_ITEMS)
    : 0;
  const endIndex = shouldVirtualize
    ? Math.min(totalItems, Math.max(endBaseIndex + OVERSCAN_ITEMS, startIndex + 1))
    : totalItems;

  const visibleCards = shouldVirtualize ? cards.slice(startIndex, endIndex) : cards;
  const topSpacerHeight = shouldVirtualize ? prefixHeights[startIndex] : 0;
  const bottomSpacerHeight = shouldVirtualize
    ? prefixHeights[totalItems] - prefixHeights[endIndex]
    : 0;

  if (cards.length === 0 && !partialText) {
    return (
      <div className="text-center mt-10 text-text-muted italic">
        {hasActiveSession ? t("session.waitingForSpeech") : t("session.selectOrStart")}
      </div>
    );
  }

  return (
    <>
      {topSpacerHeight > 0 && <div aria-hidden="true" style={{ height: `${topSpacerHeight}px` }} />}
      {visibleCards.map((item, visibleIndex) => {
        const cardNumber = (shouldVirtualize ? startIndex : 0) + visibleIndex + 1;
        return (
          <CaptionCardItem
            addToast={addToast}
            key={item.id}
            card={item}
            cardNumber={cardNumber}
            isVirtualized={shouldVirtualize}
            isHighlighted={item.id === highlightedCardId}
            onMeasuredHeight={shouldVirtualize ? handleMeasuredHeight : undefined}
            tempTranslation={tempTranslations[item.id]}
            onRetryTranslation={onRetryTranslation}
          />
        );
      })}
      {bottomSpacerHeight > 0 && <div aria-hidden="true" style={{ height: `${bottomSpacerHeight}px` }} />}
      {partialText && (!cards.length || cards[cards.length - 1].original !== partialText) && (
        <div className="bg-primary-dim rounded-lg p-3 border-l-[3px] border-primary transition-colors duration-200 animate-slide-in relative mb-3">
          <div className="text-[13px] text-text-secondary mb-1.5 leading-[1.4] select-text">{partialText}</div>
          <div className="text-base text-primary animate-pulse">...</div>
        </div>
      )}
    </>
  );
}, areCaptionsListPropsEqual);

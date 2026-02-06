import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { IconCopy, IconChevronDown } from "./Icons";
import { SentenceCard } from "../types";

interface CopyButtonProps {
  cards: SentenceCard[];
  addToast: (type: 'success' | 'error', msg: string) => void;
}

export function CopyButton({ cards, addToast }: CopyButtonProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const handleCopy = async (mode: 'all' | 'original' | 'translated') => {
    if (cards.length === 0) return;

    let text = "";
    cards.forEach(card => {
      const original = card.original?.trim() || "";
      const translated = card.translated?.trim() || "";
      
      if (mode === 'all') {
        // Format: Original\n**Translated**
        text += `${original}\n**${translated}**\n\n`;
      } else if (mode === 'original') {
        text += `${original}\n\n`;
      } else if (mode === 'translated') {
         if (translated) text += `${translated}\n\n`;
      }
    });

    try {
      await navigator.clipboard.writeText(text.trim());
      addToast('success', t("toast.copySuccess"));
    } catch (err) {
      console.error('Failed to copy:', err);
      addToast('error', t("toast.copyFailed"));
    }
    setIsOpen(false);
  };

  return (
    <div className="copy-split-btn" ref={menuRef}>
      <button 
        className="copy-main-btn"
        onClick={() => handleCopy('all')}
        title={t("copy.tooltip")}
        disabled={cards.length === 0}
      >
        <IconCopy />
      </button>
      <button 
        className="copy-dropdown-trigger"
        onClick={() => setIsOpen(!isOpen)}
        disabled={cards.length === 0}
        title={t("copy.moreOptions")}
      >
        <IconChevronDown />
      </button>
      
      {isOpen && (
        <div className="copy-dropdown-menu">
          <button className="copy-dropdown-item" onClick={() => handleCopy('original')}>
            {t("copy.originalOnly")}
          </button>
          <button className="copy-dropdown-item" onClick={() => handleCopy('translated')}>
             {t("copy.translationOnly")}
          </button>
        </div>
      )}
    </div>
  );
}

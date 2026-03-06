import React, { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SessionMetadata } from '../types';
import { IconTrash, IconClock, IconX } from './Icons';

export const SESSION_SIDEBAR_DEFAULT_WIDTH = 260;
export const SESSION_SIDEBAR_MIN_WIDTH = 220;
export const SESSION_SIDEBAR_MAX_WIDTH = 420;

const DAY_IN_MS = 24 * 60 * 60 * 1000;

const parseLocalDateStart = (value: string): number | null => {
  if (!value) {
    return null;
  }

  const [year, month, day] = value.split('-').map(Number);
  if ([year, month, day].some(Number.isNaN)) {
    return null;
  }

  return new Date(year, month - 1, day).getTime();
};

const parseLocalDateEnd = (value: string): number | null => {
  const startOfDay = parseLocalDateStart(value);
  if (startOfDay === null) {
    return null;
  }

  return startOfDay + DAY_IN_MS - 1;
};

const matchesSessionDateRange = (createdAtMs: number, startDate: string, endDate: string): boolean => {
  const startMs = parseLocalDateStart(startDate);
  const endMs = parseLocalDateEnd(endDate);

  if (startMs !== null && endMs !== null && startMs > endMs) {
    return false;
  }

  if (startMs !== null && createdAtMs < startMs) {
    return false;
  }

  if (endMs !== null && createdAtMs > endMs) {
    return false;
  }

  return true;
};

interface SidebarProps {
  sessions: SessionMetadata[];
  currentId: string | null;
  width: number;
  onSelect: (id: string) => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
  onResizeStart: React.MouseEventHandler<HTMLDivElement>;
  isOpen: boolean;
  isResizing: boolean;
}

export const Sidebar = memo(function Sidebar({
  sessions,
  currentId,
  width,
  onSelect,
  onDelete,
  onResizeStart,
  isOpen,
  isResizing,
}: SidebarProps) {
  const { t } = useTranslation();
  const [keyword, setKeyword] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const normalizedKeyword = keyword.trim().toLocaleLowerCase();
  const hasActiveFilters = normalizedKeyword.length > 0 || startDate.length > 0 || endDate.length > 0;

  const filteredSessions = useMemo(() => {
    return sessions.filter(session => {
      const createdAtMs = session.created_at * 1000;
      if (!matchesSessionDateRange(createdAtMs, startDate, endDate)) {
        return false;
      }

      if (normalizedKeyword.length === 0) {
        return true;
      }

      const haystack = `${session.name}\n${session.preview}`.toLocaleLowerCase();
      return haystack.includes(normalizedKeyword);
    });
  }, [endDate, normalizedKeyword, sessions, startDate]);

  const clearFilters = () => {
    setKeyword('');
    setStartDate('');
    setEndDate('');
  };

  return (
    <div
      className={`${isOpen ? 'opacity-100' : 'opacity-0 border-r-0'} relative bg-panel border-r border-border flex flex-col shrink-0 ${isResizing ? 'transition-none' : 'transition-[width,opacity,border-color] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]'} z-20 overflow-hidden whitespace-nowrap`}
      style={{ width: isOpen ? `${width}px` : '0px' }}
    >
      <div
        className={`absolute right-0 top-0 h-full w-2 cursor-col-resize select-none ${isOpen ? '' : 'pointer-events-none'}`}
        onMouseDown={onResizeStart}
        title={t('sidebar.resize')}
        aria-label={t('sidebar.resize')}
      />

      <div className="border-b border-border px-3 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="m-0 shrink-0 text-sm font-semibold text-text-primary uppercase tracking-[0.5px]">{t('sidebar.title')}</h3>
          {sessions.length > 0 && (
            <input
              type="text"
              className="min-w-0 flex-1 h-9 rounded-lg border border-border bg-input px-3 text-sm text-text-primary outline-none focus:border-primary placeholder:text-text-muted"
              value={keyword}
              onChange={event => setKeyword(event.target.value)}
              placeholder={t('sidebar.searchPlaceholder')}
              aria-label={t('sidebar.searchPlaceholder')}
            />
          )}
        </div>
      </div>
      {sessions.length > 0 && (
        <div className="border-b border-border px-2.5 py-2 space-y-2">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
              <input
                type="date"
                className="min-w-0 h-9 rounded-lg border border-border bg-input px-3 text-sm text-text-primary outline-none focus:border-primary"
                value={startDate}
                max={endDate || undefined}
                onChange={event => setStartDate(event.target.value)}
                aria-label={t('sidebar.startDateLabel')}
              />
              <span className="text-xs text-text-muted select-none" aria-hidden="true">→</span>
              <input
                type="date"
                className="min-w-0 h-9 rounded-lg border border-border bg-input px-3 text-sm text-text-primary outline-none focus:border-primary"
                value={endDate}
                min={startDate || undefined}
                onChange={event => setEndDate(event.target.value)}
                aria-label={t('sidebar.endDateLabel')}
              />
            </div>
            <button
              type="button"
              className={`h-8 w-8 shrink-0 rounded-lg border border-border bg-card transition-all flex items-center justify-center ${hasActiveFilters ? 'text-text-secondary cursor-pointer hover:bg-card-hover hover:text-text-primary' : 'text-text-muted cursor-not-allowed opacity-70'}`}
              onClick={clearFilters}
              title={t('sidebar.clearFiltersTooltip')}
              aria-label={t('sidebar.clearFiltersTooltip')}
              disabled={!hasActiveFilters}
            >
              <IconX size={14} />
            </button>
          </div>
          <div className="text-[10px] text-text-muted px-0.5">
            {t('sidebar.filteredCount', { filtered: filteredSessions.length, total: sessions.length })}
          </div>
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
        {filteredSessions.map(session => (
          <div
            key={session.id}
            className={`group p-2.5 rounded-md cursor-pointer flex justify-between items-start transition-all border border-transparent hover:bg-card-hover ${session.id === currentId ? 'bg-input border-primary-dim' : ''}`}
            onClick={() => onSelect(session.id)}
          >
            <div className="flex-1 overflow-hidden flex flex-col gap-1">
              <span className="text-[13px] font-medium text-text-primary whitespace-nowrap overflow-hidden text-ellipsis">{session.name}</span>
              <div className="flex items-center gap-1.5 text-[11px] text-text-muted opacity-80 mt-0.5">
                <div className="opacity-70"><IconClock size={10} /></div>
                <span className="font-medium tracking-[0.2px]">
                  {new Date(session.created_at * 1000).toLocaleString(undefined, {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                  })}
                </span>
              </div>
              <span className="text-[11px] text-text-secondary whitespace-nowrap overflow-hidden text-ellipsis opacity-70">
                {session.preview ? session.preview.slice(0, 30) : t('sidebar.emptyPreview')}
                {session.preview && session.preview.length > 30 ? '...' : ''}
              </span>
            </div>
            <button
              type="button"
              className="bg-transparent border-none text-text-muted opacity-0 cursor-pointer p-1 transition-all group-hover:opacity-100 hover:text-error"
              onClick={event => {
                event.stopPropagation();
                onDelete(session.id, event);
              }}
              title={t('sidebar.deleteTooltip')}
            >
              <IconTrash />
            </button>
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="text-center mt-10 text-text-muted text-[13px] flex flex-col gap-3 items-center">
            <span>{t('sidebar.emptyState')}</span>
          </div>
        )}
        {sessions.length > 0 && filteredSessions.length === 0 && (
          <div className="text-center mt-10 text-text-muted text-[13px] flex flex-col gap-3 items-center px-4 whitespace-normal">
            <span>{t('sidebar.noResults')}</span>
          </div>
        )}
      </div>
    </div>
  );
});

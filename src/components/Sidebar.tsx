import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { SessionMetadata } from '../types';
import { IconTrash, IconClock } from './Icons';

export const SESSION_SIDEBAR_DEFAULT_WIDTH = 260;

interface SidebarProps {
  sessions: SessionMetadata[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
  onClearAll: () => void;
  isOpen: boolean;
}

export const Sidebar = memo(function Sidebar({ sessions, currentId, onSelect, onDelete, onClearAll, isOpen }: SidebarProps) {
  const { t } = useTranslation();
  return (
    <div
      className={`${isOpen ? 'opacity-100' : 'opacity-0 border-r-0'} bg-panel border-r border-border flex flex-col shrink-0 transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] z-20 overflow-hidden whitespace-nowrap`}
      style={{ width: isOpen ? `${SESSION_SIDEBAR_DEFAULT_WIDTH}px` : '0px' }}
    >
      <div className="h-[60px] flex items-center justify-between px-4 border-b border-border">
        <h3 className="m-0 text-sm font-semibold text-text-primary uppercase tracking-[0.5px]">{t("sidebar.title")}</h3>
        {sessions.length > 0 && (
          <button 
            type="button"
            className="bg-transparent border-none text-text-secondary cursor-pointer p-2 rounded-full transition-all flex items-center justify-center hover:bg-card-hover hover:text-text-primary" 
            onClick={onClearAll} 
            title={t("sidebar.clearAllTooltip")}
          >
            <IconTrash />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
        {sessions.map(session => (
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
                {session.preview ? session.preview.slice(0, 30) : "Empty"}
                {session.preview && session.preview.length > 30 ? "..." : ""}
              </span>
            </div>
            <button
              type="button"
              className="bg-transparent border-none text-text-muted opacity-0 cursor-pointer p-1 transition-all group-hover:opacity-100 hover:text-error"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(session.id, e);
              }}
              title={t("sidebar.deleteTooltip")}
            >
              <IconTrash />
            </button>
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="text-center mt-10 text-text-muted text-[13px] flex flex-col gap-3 items-center">
            <span>{t("sidebar.emptyState")}</span>
          </div>
        )}
      </div>
    </div>
  );
});

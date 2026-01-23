import React from 'react';
import { useTranslation } from 'react-i18next';
import { SessionMetadata } from '../types';
import { IconTrash, IconClock } from './Icons';

interface SidebarProps {
  sessions: SessionMetadata[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
  isOpen: boolean;
}

export function Sidebar({ sessions, currentId, onSelect, onDelete, isOpen }: SidebarProps) {
  const { t } = useTranslation();
  return (
    <div className={`sidebar ${isOpen ? 'open' : 'closed'}`}>
      <div className="sidebar-header">
        <h3>{t("sidebar.title")}</h3>
      </div>
      <div className="session-list">
        {sessions.map(session => (
          <div 
            key={session.id} 
            className={`session-item ${session.id === currentId ? 'active' : ''}`}
            onClick={() => onSelect(session.id)}
          >
            <div className="session-info">
              <span className="session-name">{session.name}</span>
              <div className="session-meta">
                <IconClock size={10} />
                <span className="session-date">
                   {new Date(session.created_at * 1000).toLocaleString(undefined, {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                   })}
                </span>
              </div>
              <span className="session-preview">
                {session.preview ? session.preview.slice(0, 30) : "Empty"}
                {session.preview && session.preview.length > 30 ? "..." : ""}
              </span>
            </div>
            <button
              className="btn-delete-session"
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
          <div className="empty-sessions">
            <span>{t("sidebar.emptyState")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

import React from 'react';
import { SessionMetadata } from '../types';
import { IconPlus, IconTrash } from './Icons';

interface SidebarProps {
  sessions: SessionMetadata[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
  isOpen: boolean;
}

export function Sidebar({ sessions, currentId, onSelect, onCreate, onDelete, isOpen }: SidebarProps) {
  if (!isOpen) return null;

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h3>Sessions</h3>
        <button className="btn-icon-new" onClick={onCreate} title="New Session">
          <IconPlus />
        </button>
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
              title="Delete Session"
            >
              <IconTrash />
            </button>
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="empty-sessions">
            <span>No saved sessions</span>
            <button className="btn-create-first" onClick={onCreate}>Start New</button>
          </div>
        )}
      </div>
    </div>
  );
}

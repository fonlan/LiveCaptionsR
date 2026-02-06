import { useTranslation } from "react-i18next";
import { IconX, IconRetry } from "../Icons";
import { TeamsWindowInfo } from "../../types";

interface TeamsSelectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (hwnd: number) => void;
  windows: TeamsWindowInfo[];
  onRefresh: () => void;
  isScanning: boolean;
}

export function TeamsSelectionModal({
  isOpen,
  onClose,
  onSelect,
  windows,
  onRefresh,
  isScanning
}: TeamsSelectionModalProps) {
  const { t } = useTranslation();
  
  if (!isOpen) return null;

  return (
    <div className="settings-overlay open" onClick={onClose}>
      <div className="settings-drawer" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px', width: '90%' }}>
        <header className="settings-header">
          <h2>{t("teams.selectWindow")}</h2>
          <button className="btn-icon" onClick={onClose}>
            <IconX />
          </button>
        </header>
        <div className="settings-content" style={{ padding: '20px' }}>
          <p style={{ marginBottom: '16px', color: 'var(--text-primary)', fontSize: '14px' }}>
            {t("teams.description")}
          </p>

          <div style={{
            marginBottom: '16px',
            padding: '12px',
            background: 'rgba(255, 165, 0, 0.15)',
            border: '1px solid rgba(255, 165, 0, 0.3)',
            borderRadius: '6px',
            color: '#ffa500',
            fontSize: '13px',
            lineHeight: '1.5'
          }}>
            <strong>{t("teams.instructionTitle")}</strong>
            <div style={{ marginTop: '4px' }}>
              {t("teams.instructionStep")}
            </div>
          </div>

          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <label style={{ display: 'block', color: 'var(--text-primary)', fontWeight: 500 }}>
                {t("teams.availableWindows")}
              </label>
              <button 
                type="button" 
                onClick={onRefresh} 
                disabled={isScanning}
                style={{ 
                  padding: '2px 8px', 
                  fontSize: '11px', 
                  background: 'transparent', 
                  border: '1px solid var(--border-color)',
                  borderRadius: '4px',
                  cursor: isScanning ? 'default' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  color: 'var(--text-primary)'
                }}
              >
                {isScanning ? <IconRetry className="spin" size={12} /> : <IconRetry size={12} />}
                <span style={{ marginLeft: '4px' }}>{t("teams.refresh")}</span>
              </button>
            </div>

            {windows.length === 0 ? (
              <div style={{ 
                padding: '12px', 
                background: 'var(--bg-input)', 
                border: '1px dashed var(--border-color)', 
                borderRadius: '6px',
                color: 'var(--text-muted)',
                fontSize: '13px',
                textAlign: 'center'
              }}>
                {isScanning ? t("teams.scanning") : t("teams.noWindows")}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {windows.map(win => (
                  <button
                    key={win.hwnd}
                    onClick={() => onSelect(win.hwnd)}
                    style={{
                      padding: '10px',
                      background: 'var(--bg-input)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '6px',
                      textAlign: 'left',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      color: 'var(--text-primary)'
                    }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--primary)'}
                    onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-color)'}
                  >
                    <div style={{ fontWeight: 500, fontSize: '14px' }}>{win.title}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>PID: {win.pid}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'flex-end' }}>
             <button
              onClick={onClose}
              style={{
                padding: '8px 16px',
                background: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer'
              }}
            >
              {t("teams.cancel")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

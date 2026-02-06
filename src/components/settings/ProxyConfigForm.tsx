import { useTranslation } from "react-i18next";
import { ProxyConfig } from "../../types";

interface ProxyConfigFormProps {
  proxy: ProxyConfig;
  onChange: (p: ProxyConfig) => void;
  label: string;
}

export function ProxyConfigForm({ proxy, onChange, label }: ProxyConfigFormProps) {
  const { t } = useTranslation();
  return (
    <div className="proxy-config">
      <div className="form-group checkbox-group">
        <label className="switch">
          <input type="checkbox" checked={proxy.enabled} onChange={e => onChange({ ...proxy, enabled: e.target.checked })} />
          <span className="slider round"></span>
        </label>
        <span>{label}</span>
      </div>
      {proxy.enabled && (
        <div className="form-group">
          <label>{t("settings.translation.proxyUrl")}</label>
          <input
            type="text"
            value={proxy.url || ''}
            onChange={e => onChange({ ...proxy, url: e.target.value })}
            placeholder={t("settings.translation.proxyUrlPlaceholder")}
          />
        </div>
      )}
    </div>
  );
}

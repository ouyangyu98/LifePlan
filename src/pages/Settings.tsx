import { useState } from "react";
import { Alert, Switch, Typography, message } from "antd";
import { CalendarDays, FileText, Gift, NotebookPen, Timer } from "lucide-react";
import { optionalFeatures, useFeaturePreferences, type FeatureKey } from "@/lib/featurePreferences";
import { pomodoroApi } from "@/lib/api";

const icons = { workLog: FileText, templates: CalendarDays, rewards: Gift, pomodoro: Timer, insights: NotebookPen };

export default function Settings() {
  const { features, setFeature } = useFeaturePreferences();
  const [saving, setSaving] = useState<FeatureKey | null>(null);
  const [error, setError] = useState("");
  const toggle = async (key: FeatureKey, enabled: boolean) => {
    if (saving) return;
    setSaving(key);
    setError("");
    try {
      if (key === "pomodoro" && !enabled) {
        const status = await pomodoroApi.status();
        if (status.active) {
          message.warning("番茄钟正在计时，请先完成或结束本次专注");
          return;
        }
      }
      setFeature(key, enabled);
    } catch {
      setError("设置未保存，请稍后重试");
    } finally {
      setSaving(null);
    }
  };

  return <div className="page settings-page">
    <header className="page-header"><Typography.Title level={2} className="page-title">设置</Typography.Title></header>
    {error && <Alert type="error" showIcon message={error} className="page-alert" />}
    <section className="feature-settings" aria-labelledby="optional-features-heading">
      <Typography.Title level={4} id="optional-features-heading">可选功能</Typography.Title>
      {optionalFeatures.map(({ key, label }) => {
        const Icon = icons[key];
        return <div className="feature-setting-row" key={key}>
          <label htmlFor={`feature-${key}`}><Icon size={18} aria-hidden="true" /><span>{label}</span></label>
          <Switch id={`feature-${key}`} aria-label={label} checked={features[key]} loading={saving === key} disabled={saving !== null} onChange={(enabled) => void toggle(key, enabled)} />
        </div>;
      })}
    </section>
  </div>;
}

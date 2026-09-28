import { createContext, useContext, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";

export const optionalFeatures = [
  { key: "workLog", label: "工作日志" },
  { key: "templates", label: "日程模板" },
  { key: "rewards", label: "奖励池" },
  { key: "pomodoro", label: "番茄钟" },
  { key: "insights", label: "心得" },
  { key: "dailyStatistics", label: "数据统计" },
] as const;

export type FeatureKey = typeof optionalFeatures[number]["key"];
type Features = Record<FeatureKey, boolean>;
const storageKey = "lifeplan-optional-features-v1";
const defaults: Features = { workLog: true, templates: true, rewards: true, pomodoro: true, insights: true, dailyStatistics: true };

const FeatureContext = createContext<{
  features: Features;
  setFeature: (key: FeatureKey, enabled: boolean) => void;
} | null>(null);

export function FeaturePreferencesProvider({ children }: { children: ReactNode }) {
  const [features, setFeatures] = useState<Features>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
      return Object.fromEntries(optionalFeatures.map(({ key }) => [
        key, typeof saved?.[key] === "boolean" ? saved[key] : defaults[key],
      ])) as Features;
    } catch {
      return defaults;
    }
  });
  const setFeature = (key: FeatureKey, enabled: boolean) => {
    const next = { ...features, [key]: enabled };
    // Keep the visible state unchanged if saving fails.
    localStorage.setItem(storageKey, JSON.stringify(next));
    setFeatures(next);
  };
  return <FeatureContext.Provider value={{ features, setFeature }}>{children}</FeatureContext.Provider>;
}

export function useFeaturePreferences() {
  const value = useContext(FeatureContext);
  if (!value) throw new Error("Feature preferences provider is missing");
  return value;
}

export function OptionalFeature({ feature, children }: { feature: FeatureKey; children: ReactNode }) {
  const { features } = useFeaturePreferences();
  return features[feature] ? children : <Navigate to="/daily-list" replace />;
}

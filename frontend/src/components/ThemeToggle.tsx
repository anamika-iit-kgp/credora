import { useEffect, useState } from "react";
import { Moon, MonitorSmartphone, Sun } from "lucide-react";

type Theme = "system" | "light" | "dark";
const KEY = "credora.theme";

function apply(t: Theme) {
  const root = document.documentElement;
  if (t === "system") delete root.dataset.theme;
  else root.dataset.theme = t;
}

export function ThemeToggle({ className = "nav-theme" }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem(KEY) as Theme) || "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    apply(theme);
    try {
      if (theme === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  const next: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
  const label: Record<Theme, string> = { system: "Auto", light: "Light", dark: "Dark" };
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : MonitorSmartphone;
  return (
    <button className={className} onClick={() => setTheme(next[theme])} aria-label={`Colour theme is ${theme}. Switch to ${next[theme]}.`}>
      <Icon aria-hidden="true" />
      {label[theme]}
    </button>
  );
}

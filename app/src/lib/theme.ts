export type ThemePreference = "light" | "dark" | "system";
export const THEME_STORAGE_KEY = "open-chat:theme:v1";
export const THEME_CHANGE_EVENT = "open-chat:theme-change";

export function themePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

// Runs in the document head before paint; only fixed application code is embedded.
export const THEME_BOOTSTRAP = `(() => {
  let preference = "system";
  try { const saved = localStorage.getItem("open-chat:theme:v1"); if (saved === "light" || saved === "dark") preference = saved; } catch {}
  const dark = preference === "dark" || (preference === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themePreference = preference;
})();`;

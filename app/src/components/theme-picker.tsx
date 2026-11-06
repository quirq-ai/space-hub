
import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { THEME_CHANGE_EVENT, THEME_STORAGE_KEY, themePreference, type ThemePreference } from "@/lib/theme";

function currentPreference(): ThemePreference {
  return themePreference(document.documentElement.dataset.themePreference);
}

function applyTheme(preference: ThemePreference) {
  const dark = preference === "dark" || (preference === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themePreference = preference;
}

function subscribe(onChange: () => void) {
  const media = matchMedia("(prefers-color-scheme: dark)");
  const refresh = () => { applyTheme(currentPreference()); onChange(); };
  const storage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    applyTheme(themePreference(event.newValue));
    onChange();
  };
  refresh();
  media.addEventListener("change", refresh);
  window.addEventListener("storage", storage);
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  return () => {
    media.removeEventListener("change", refresh);
    window.removeEventListener("storage", storage);
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
  };
}

const serverPreference = (): ThemePreference => "system";
const choices = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor }
] as const;

export function selectTheme(value: ThemePreference) {
  applyTheme(value);
  try { localStorage.setItem(THEME_STORAGE_KEY, value); } catch { /* The in-memory choice still works when browser storage is unavailable. */ }
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

/** Light, dark or system, as one segmented row: it sits inside the sidebar's account menu. */
export function ThemeChoices() {
  const preference = useSyncExternalStore(subscribe, currentPreference, serverPreference);
  return <div className="theme-choices" role="radiogroup" aria-label="Appearance">
    <span className="theme-choices-label">Appearance</span>
    <span className="theme-choices-row">
      {choices.map(({ value, label, Icon }) => <button key={value} type="button" role="radio" aria-checked={preference === value} aria-label={label} title={value === "system" ? "System: follows your device" : label} className={preference === value ? "on" : undefined} onClick={() => selectTheme(value)}>
        <Icon size={14} strokeWidth={1.9} />
      </button>)}
    </span>
  </div>;
}

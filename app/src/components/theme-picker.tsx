
import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
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

export function ThemePicker() {
  const preference = useSyncExternalStore(subscribe, currentPreference, serverPreference);
  const picker = useRef<HTMLDetailsElement>(null);
  const group = useId();
  const Icon = preference === "dark" ? Moon : preference === "light" ? Sun : Monitor;

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && picker.current?.open && !picker.current.contains(event.target)) picker.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && picker.current?.open) {
        picker.current.open = false;
        picker.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, []);

  function selectTheme(value: ThemePreference) {
    applyTheme(value);
    try { localStorage.setItem(THEME_STORAGE_KEY, value); } catch { /* The in-memory choice still works when browser storage is unavailable. */ }
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }

  return <details className="theme-picker" ref={picker}>
    <summary className="round-button" aria-label={`Appearance: ${preference}`} title="Appearance"><Icon size={20} strokeWidth={1.8} /></summary>
    <fieldset className="theme-menu">
      <legend>Appearance</legend>
      {choices.map(({ value, label, Icon: OptionIcon }) => <label className="theme-option" key={value}>
        <input type="radio" name={group} value={value} checked={preference === value} onChange={() => selectTheme(value)} />
        <OptionIcon size={17} strokeWidth={1.8} /><span>{label}</span>{preference === value && <Check size={15} className="theme-check" />}
      </label>)}
      <p className="theme-hint">Saved in this browser. System follows your device.</p>
    </fieldset>
  </details>;
}

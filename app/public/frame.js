// The frame's behaviour on the server-rendered pages (the guide, sign-in, new
// project), as the app's shell does it: fold to icons with the app's own saved
// choice, the drawer on phones, ⌘B, menus that close on a click outside, and
// the appearance choice. Loaded as the first thing in <body>, so the folded
// state is there before the first paint.
(() => {
  const RAIL = "spacehub:rail:v1";
  const THEME = "open-chat:theme:v1";
  const body = document.body;
  try { if (localStorage.getItem(RAIL) === "on") body.classList.add("rail"); } catch { /* Storage may be blocked. */ }
  const narrow = () => matchMedia("(max-width: 760px)").matches;
  let scrim = null;
  const drawer = open => {
    const side = document.querySelector(".sidebar");
    if (!side) return;
    side.classList.toggle("open", open);
    if (open && !scrim) {
      scrim = document.createElement("button");
      scrim.type = "button";
      scrim.className = "scrim only-narrow";
      scrim.setAttribute("aria-label", "Close navigation");
      side.after(scrim);
    } else if (!open && scrim) { scrim.remove(); scrim = null; }
  };
  const rail = () => {
    const on = !body.classList.contains("rail");
    body.classList.toggle("rail", on);
    try { localStorage.setItem(RAIL, on ? "on" : "off"); } catch { /* Storage may be blocked. */ }
  };
  const toggle = () => narrow() ? drawer(!document.querySelector(".sidebar.open")) : rail();
  const mark = preference => document.querySelectorAll("[data-theme-choice]").forEach(button => {
    const on = button.dataset.themeChoice === preference;
    button.classList.toggle("on", on);
    button.setAttribute("aria-checked", String(on));
  });
  const theme = preference => {
    const dark = preference === "dark" || (preference === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.dataset.themePreference = preference;
    try { localStorage.setItem(THEME, preference); } catch { /* The choice still holds on this page. */ }
    mark(preference);
  };
  const closeMenus = except => document.querySelectorAll(".sidebar details[open]").forEach(menu => { if (!except || !menu.contains(except)) menu.open = false; });
  addEventListener("DOMContentLoaded", () => mark(document.documentElement.dataset.themePreference || "system"));
  addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null;
    const control = target?.closest("[data-frame],[data-theme-choice]");
    if (control?.dataset.themeChoice) theme(control.dataset.themeChoice);
    else if (control?.dataset.frame === "toggle") toggle();
    else if (control?.dataset.frame === "rail") rail();
    else if (target === scrim) drawer(false);
    closeMenus(target);
  });
  addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") { event.preventDefault(); toggle(); }
    if (event.key === "Escape") { closeMenus(null); drawer(false); }
  });
})();

// Runs in the page head before paint: the saved theme (or the system's), shared with open-chat's key.
(() => {
  let preference = "system";
  try { const saved = localStorage.getItem("open-chat:theme:v1"); if (saved === "light" || saved === "dark") preference = saved; } catch {}
  const dark = preference === "dark" || (preference === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themePreference = preference;
})();

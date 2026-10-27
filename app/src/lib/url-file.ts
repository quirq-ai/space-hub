/** Read a plain web URL or a Windows Internet Shortcut without executing its contents. */
export function parseUrlFile(content: string): string | undefined {
  const text = content.replace(/^\uFEFF/, "").trim();
  let candidate = text;
  if (text.startsWith("[")) {
    let shortcut = false;
    const urls: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const value = line.trim();
      if (value.startsWith("[") && value.endsWith("]")) { shortcut = value.toLowerCase() === "[internetshortcut]"; continue; }
      if (shortcut && /^url\s*=/i.test(value)) urls.push(value.slice(value.indexOf("=") + 1).trim());
    }
    if (urls.length !== 1) return;
    candidate = urls[0];
  }
  if (!/^https?:\/\//i.test(candidate) || /[\s\u0000-\u001f\u007f\\]/.test(candidate)) return;
  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
    return url.href;
  } catch { return; }
}

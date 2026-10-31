/** Files the browser shows itself: images in an <img>, video in a <video>. */
export const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
export const VIDEO = /\.(mp4|m4v|webm|mov|ogv)$/i;

export function mediaOf(path: string): "image" | "video" | undefined {
  return IMAGE.test(path) ? "image" : VIDEO.test(path) ? "video" : undefined;
}

/** A link in a file at `filePath` as a path in the same project; none for web links or one that climbs out. */
export function localLink(href: string, filePath: string): string | undefined {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//") || href.includes("\\")) return;
  let decoded: string;
  try { decoded = decodeURIComponent(href.split("#")[0].split("?")[0]); } catch { return; }
  const parts = href.startsWith("/") ? [] : filePath.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) return; parts.pop(); }
    else parts.push(part);
  }
  return parts.join("/");
}

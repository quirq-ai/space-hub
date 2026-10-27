export type JsonlRecord = { line: number; value: unknown; error?: never } | { line: number; error: string; raw: string; value?: never };

/** Keep physical line numbers and valid neighbours when one record is incomplete. */
export function parseJsonl(content: string): JsonlRecord[] {
  const records: JsonlRecord[] = [];
  content.split(/\r?\n/).forEach((raw, index) => {
    if (!raw.trim()) return;
    try { records.push({ line: index + 1, value: JSON.parse(raw) as unknown }); }
    catch { records.push({ line: index + 1, error: "This line is not valid JSON yet.", raw }); }
  });
  return records;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(item => typeof item === "string" ? item : object(item) && typeof item.text === "string" ? item.text : "").filter(Boolean).join("\n\n");
  return "";
}
function label(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (object(value)) return label(value.name ?? value.displayName ?? value.id);
  return "";
}

/** Common log/message fields become a post; arbitrary records retain their full JSON. */
export function jsonlPost(value: unknown) {
  const data = object(value) ? value : {};
  const message = object(data.message) ? data.message : data;
  return {
    author: label(data.author ?? data.sender ?? message.role ?? data.role ?? data.source) || "Record",
    title: label(data.title ?? data.subject),
    body: text(message.content) || text(data.text) || text(data.body) || text(data.message) || text(data.content) || text(value),
    time: label(data.timestamp ?? data.created_at ?? data.createdAt ?? data.time ?? data.date),
    kind: label(data.type ?? data.event ?? data.level),
  };
}

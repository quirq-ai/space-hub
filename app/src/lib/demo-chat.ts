export type DemoMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  links?: { label: string; path: string }[];
};
export type DemoReply = { content: string; links?: { label: string; path: string }[] };
export type DemoReplies = {
  type: "demo-replies";
  suggestions: { label: string; prompt: string }[];
  rules: (DemoReply & { keywords: string[] })[];
  fallback: DemoReply;
};
export const DEMO_STORAGE_PREFIX = "open-chat:demo:v1:";
export const MAX_DEMO_MESSAGES = 100;
export const MAX_MESSAGE_LENGTH = 4000;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function reply(value: unknown): value is DemoReply {
  return object(value) && typeof value.content === "string" && (value.links === undefined || (Array.isArray(value.links) && value.links.every(link => object(link) && typeof link.label === "string" && typeof link.path === "string")));
}
export function parseDemoReplies(value: unknown): DemoReplies | undefined {
  if (!object(value) || value.type !== "demo-replies" || !reply(value.fallback) || !Array.isArray(value.rules)) return;
  if (!value.rules.every(rule => object(rule) && Array.isArray(rule.keywords) && rule.keywords.length > 0 && rule.keywords.every((word: unknown) => typeof word === "string" && word.trim()) && reply(rule))) return;
  const suggestions = Array.isArray(value.suggestions) ? value.suggestions.filter(item => object(item) && typeof item.label === "string" && typeof item.prompt === "string").slice(0, 4) as DemoReplies["suggestions"] : [];
  return { type: "demo-replies", rules: value.rules as DemoReplies["rules"], fallback: value.fallback, suggestions };
}
function words(value: string): string {
  return " " + value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() + " ";
}
export function sampleReply(prompt: string, config: DemoReplies): DemoReply {
  const normalized = words(prompt);
  return config.rules.find(rule => rule.keywords.some(keyword => normalized.includes(words(keyword)))) || config.fallback;
}
export function restoreDemoSession(value: unknown): { messages: DemoMessage[]; draft: string } {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.messages)) return { messages: [], draft: "" };
  const messages = value.messages.filter(message => object(message) && typeof message.id === "string" && (message.role === "user" || message.role === "assistant") && reply(message)).slice(-MAX_DEMO_MESSAGES).map(message => ({ ...message, content: message.content.slice(0, MAX_MESSAGE_LENGTH) })) as DemoMessage[];
  return { messages, draft: typeof value.draft === "string" ? value.draft.slice(0, MAX_MESSAGE_LENGTH) : "" };
}

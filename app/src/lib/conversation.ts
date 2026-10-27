type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);

export function isConversation(data: unknown): data is ObjectValue & { messages: ObjectValue[] } {
  return object(data) && data.type === "conversation" && Array.isArray(data.messages) && data.messages.every(message => object(message) && typeof message.content === "string" && ["user", "assistant", "system"].includes(typeof message.role === "string" ? message.role : ""));
}

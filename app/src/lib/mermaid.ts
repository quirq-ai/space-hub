/** A Mermaid diagram file: .mmd or .mermaid, shown as the diagram it draws. */
export const isMermaid = (path: string) => /\.(mmd|mermaid)$/i.test(path);

/** Whether a Markdown code block's class (from ```mermaid) marks a Mermaid diagram. */
export const isMermaidFence = (className: unknown) => typeof className === "string" && /(^|\s)language-mermaid(\s|$)/.test(className);

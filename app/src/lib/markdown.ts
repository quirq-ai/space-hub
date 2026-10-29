/**
 * Raw HTML in Markdown, shown as the text it is instead of dropped. Without
 * it, `skipHtml` turns "Chat/<login>/tasks/" into "Chat//tasks/": the
 * placeholder parses as a tag and disappears. Nothing is rendered as HTML.
 */
type Node = { type: string; value?: string; children?: Node[] };

// Where a block of HTML sits directly; text there needs a paragraph around it.
const BLOCKS = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);

export function remarkHtmlAsText() {
  return (tree: Node) => {
    const walk = (node: Node) => {
      if (!node.children) return;
      node.children = node.children.map(child => {
        if (child.type !== "html") { walk(child); return child; }
        const text = { type: "text", value: child.value ?? "" };
        return BLOCKS.has(node.type) ? { type: "paragraph", children: [text] } : text;
      });
    };
    walk(tree);
  };
}

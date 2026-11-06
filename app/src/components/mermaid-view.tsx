import { useEffect, useId, useState } from "react";
import { Workflow } from "lucide-react";

type MermaidApi = typeof import("mermaid").default;

// Mermaid is large, so it loads (from the app's own files, never a CDN) only
// when a diagram is first shown, and once for the page.
let loading: Promise<MermaidApi> | undefined;
const loadMermaid = () => loading ??= import("mermaid").then(module => module.default);

const currentTheme = (): "light" | "dark" => document.documentElement.dataset.theme === "dark" ? "dark" : "light";

/** The page's theme, followed as it changes, so a diagram redraws in the right colors. */
function useTheme() {
  const [theme, setTheme] = useState(currentTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

// Mermaid renders one diagram at a time; its settings are global, so each
// render sets them first and they never leak between themes.
let queue: Promise<unknown> = Promise.resolve();
function render(id: string, source: string, theme: "light" | "dark") {
  const job = queue.then(async () => {
    const mermaid = await loadMermaid();
    // strict: labels are sanitized text, links and click handlers are off.
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: theme === "dark" ? "dark" : "default", fontFamily: "inherit" });
    return (await mermaid.render(id, source)).svg;
  });
  queue = job.catch(() => undefined);
  return job;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).trim().split("\n").slice(0, 6).join("\n");

/** A Mermaid diagram, drawn in the browser; when it does not parse, the reason and the source show instead. */
export function MermaidDiagram({ source, name, inline = false }: { source: string; name: string; inline?: boolean }) {
  const theme = useTheme();
  const id = "mermaid-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [state, setState] = useState<{ svg?: string; error?: string }>({});
  useEffect(() => {
    let live = true;
    setState(previous => ({ svg: previous.svg }));
    if (!source.trim()) { setState({ error: "This diagram is empty." }); return; }
    render(id, source, theme).then(svg => { if (live) setState({ svg }); }, error => {
      // A failed render leaves its scratch element behind.
      document.getElementById("d" + id)?.remove();
      if (live) setState({ error: errorText(error) });
    });
    return () => { live = false; };
  }, [id, source, theme]);
  const body = state.error
    ? <div className="mermaid-error" role="status"><strong>This diagram could not be drawn.</strong><pre>{state.error}</pre>{inline && <pre className="source-code"><code>{source}</code></pre>}</div>
    : state.svg
      // The SVG comes from Mermaid with securityLevel strict (DOMPurify-sanitized labels, no scripts or click handlers).
      ? <div className="mermaid-diagram" role="img" aria-label={"Diagram: " + name} dangerouslySetInnerHTML={{ __html: state.svg }} />
      : <div className="mermaid-loading" aria-busy="true">Drawing the diagram…</div>;
  if (inline) return <figure className="mermaid-inline">{body}</figure>;
  return <section className="mermaid-preview" aria-label="Diagram preview">
    <div className="url-preview-bar"><span title={name}><Workflow size={13} />Mermaid diagram</span></div>
    <div className="mermaid-canvas">{body}</div>
  </section>;
}

export interface Entry {
  name: string;
  /** A slash-separated path relative to the configured workspace. */
  path: string;
  kind: "directory" | "file";
  /** A lowercase file extension without its leading dot; empty for folders. */
  extension: string;
  size: number;
  modifiedAt: string;
  /** A short line shown instead of "Folder": for spaces and projects, and for folders with a README. */
  detail?: string;
  /** From a folder's README, its "## Status", "## Owner" and "## Output format" sections. */
  status?: string;
  owner?: string;
  outputFormat?: string;
}

/** A Markdown document of a folder, shown under its listing. */
export interface Doc {
  name: string;
  path: string;
  content: string;
}

export interface FileView extends Entry {
  kind: "file";
  format: "url" | "jsonl" | "json" | "markdown" | "text" | "image" | "pdf" | "unsupported";
  content?: string;
  data?: unknown;
  error?: string;
}

export interface WorkspaceSnapshot {
  rootName: string;
  rootId: string;
  roots: Entry[];
  directory: {
    path: string;
    name: string;
    entries: Entry[];
    /** The folder's README; at a project's root also AGENTS, PROJECT, CONTRIBUTING and WORK_ITEMS. */
    docs?: Doc[];
  };
  file?: FileView;
  revision: string;
}

export interface PreviewResult {
  bytes: Uint8Array;
  contentType: string;
  name: string;
}

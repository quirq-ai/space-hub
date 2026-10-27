export interface Entry {
  name: string;
  /** A slash-separated path relative to the configured workspace. */
  path: string;
  kind: "directory" | "file";
  /** A lowercase file extension without its leading dot; empty for folders. */
  extension: string;
  size: number;
  modifiedAt: string;
  /** A short line shown instead of "Folder" for spaces and projects. */
  detail?: string;
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
  };
  file?: FileView;
  revision: string;
}

export interface PreviewResult {
  bytes: Uint8Array;
  contentType: string;
  name: string;
}

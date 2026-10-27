import { useEffect, useRef } from "react";
import { ArrowLeft, ArrowUpRight, FileText, RefreshCw, X } from "lucide-react";
import { useView } from "@/hooks/use-view";
import type { Place } from "@/api";
import { FileContent } from "./content-view";

export function FileOverlay({ place, path, fileSrc, canGoBack, onBack, onClose, onOpen, onNavigate }: {
  place: Place; path: string; fileSrc: (path: string) => string; canGoBack: boolean; onBack: () => void; onClose: () => void; onOpen: (path: string) => void; onNavigate: (path: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { view, error, refresh } = useView(place, path);
  const snapshot = view?.snapshot;
  const file = snapshot?.file;
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);
  useEffect(() => { if (snapshot && !snapshot.file) onNavigate(path); }, [snapshot, path, onNavigate]);
  return <dialog ref={dialog} className="sheet file-overlay" aria-labelledby="file-preview-title" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="sheet-inner"><header className="sheet-header preview-header">
      {canGoBack && <button className="round-button" aria-label="Previous file" onClick={onBack}><ArrowLeft size={18} /></button>}
      <span className="icon-box tint-0 preview-icon"><FileText size={22} /></span>
      <div className="preview-heading"><span className="eyebrow">FILE PREVIEW</span><h2 id="file-preview-title">{file?.name || path.split("/").at(-1)}</h2><p title={path}>{path}</p></div>
      <button className="round-button preview-expand" aria-label="Open file as full page" title="Open as full page" onClick={() => onNavigate(path)}><ArrowUpRight size={19} /></button>
      <button className="round-button" aria-label="Close file preview" onClick={onClose}><X size={20} /></button>
    </header>
    <div className="sheet-body preview-body" key={path}>
      {error && <div className="notice warning" role="alert"><strong>{file ? "Showing the last saved preview." : "This file is unavailable."}</strong><p>{error}</p><button onClick={refresh}><RefreshCw size={13} />Try again</button></div>}
      {!snapshot && !error && <div className="loading-state"><RefreshCw size={20} className="spin" /><p>Opening file…</p></div>}
      {file && snapshot && <FileContent key={file.path} file={file} revision={snapshot.revision} navigate={onOpen} src={fileSrc(file.path)} />}
    </div>
    <footer className="preview-footer"><span>Read from {place.space}/{place.project} on the hub</span><kbd>Esc</kbd><span>to close</span></footer>
    </div>
  </dialog>;
}

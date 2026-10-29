import { useEffect, useRef } from "react";
import { ArrowLeft, Maximize2, X } from "lucide-react";
import { rawUrl, viewUrl, type Place, type View } from "@/api";
import { useLive } from "@/hooks/use-live";
import { ErrorNote, SkeletonText } from "@/ui/primitives";
import { FileContent } from "./content-view";

/**
 * A file opened from a conversation, shown over it as open-chat does, so the
 * thread, the draft and the scroll stay where they were. Links inside it
 * stack up (Back returns), Escape or the backdrop closes it, and the expand
 * button opens the file as a page. A folder opens as a page.
 */
export function FilePreview({ place, paths, branch, onOpen, onBack, onClose, onPage }: {
  place: Place; paths: string[]; branch: string; onOpen: (path: string) => void; onBack: () => void; onClose: () => void; onPage: (path: string) => void;
}) {
  const path = paths[paths.length - 1];
  const dialog = useRef<HTMLDialogElement>(null);
  const live = useLive<View>(viewUrl(place, path));
  const file = live.data?.snapshot.file;
  useEffect(() => { const box = dialog.current; if (box && !box.open) box.showModal(); return () => box?.close(); }, []);
  // A folder is a place, not a preview.
  useEffect(() => { if (live.data && !live.data.snapshot.file) onPage(path); }, [live.data, path, onPage]);
  return <dialog ref={dialog} className="preview" aria-label={path} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="preview-inner">
      <header className="preview-head">
        {paths.length > 1 && <button type="button" className="icon-button" aria-label="Back" title="Back" onClick={onBack}><ArrowLeft size={16} /></button>}
        <div className="preview-title"><strong>{path.split("/").pop()}</strong><span>{path}</span></div>
        <button type="button" className="icon-button" aria-label="Open as a page" title="Open as a page" onClick={() => onPage(path)}><Maximize2 size={15} /></button>
        <button type="button" className="icon-button" aria-label="Close" title="Close" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="preview-body">
        {file ? <FileContent key={file.path} file={file} revision={live.data!.snapshot.revision} navigate={onOpen} src={rawUrl(place, branch, file.path)} />
          : live.error ? <ErrorNote message={live.error} retry={live.refresh} /> : <SkeletonText lines={8} />}
      </div>
    </div>
  </dialog>;
}

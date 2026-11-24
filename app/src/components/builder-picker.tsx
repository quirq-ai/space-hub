import { useId, useState, type KeyboardEvent } from "react";
import { UserPlus } from "lucide-react";
import { chosenOf, matchCandidates, moveActive, pickerNote, type Candidate } from "@/lib/collaborators";
import { Avatar } from "@/ui/primitives";

/**
 * Pick a builder to add as a collaborator: a combobox (the WAI-ARIA pattern: an input with role="combobox" that owns
 * a listbox, the highlighted option named by aria-activedescendant so focus stays in the input). Typing filters;
 * ArrowDown/ArrowUp/Home/End move, Enter picks the highlighted one (or, with the list closed, adds the one picked),
 * Escape closes the list, then clears. Add adds the picked candidate, and the box empties once the hub took it.
 * Options are the rows of the search palette.
 */
export function BuilderPicker({ candidates, loading, space, busy, adding, onAdd }: { candidates: Candidate[]; loading: boolean; space: string; busy: boolean; adding: boolean; onAdd: (name: string) => Promise<boolean> }) {
  const id = useId();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const matches = matchCandidates(candidates, text);
  const chosen = chosenOf(candidates, text);
  const note = loading ? "Loading the hub's builders…" : pickerNote(candidates.length, matches.length, text, space);
  const optionId = (name: string) => `${id}-option-${name}`;
  const pick = (c: Candidate) => { setText(c.name); setOpen(false); setActive(-1); };
  const add = async () => { if (!chosen || busy) return; if (await onAdd(chosen.name)) { setText(""); setActive(-1); } };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || (open && (event.key === "Home" || event.key === "End"))) {
      event.preventDefault();
      setOpen(true);
      setActive(moveActive(open ? active : -1, event.key, matches.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (open && active >= 0 && matches[active]) pick(matches[active]);
      else void add();
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (open) { setOpen(false); setActive(-1); } else setText("");
    }
  };
  const shown = open && (matches.length > 0 || !!note);
  return <form className="runner-form" onSubmit={event => { event.preventDefault(); void add(); }}>
    <div className="builder-picker">
      <input
        role="combobox" aria-expanded={shown} aria-controls={`${id}-list`} aria-autocomplete="list" aria-label="Builder to add"
        aria-activedescendant={open && active >= 0 && matches[active] ? optionId(matches[active].name) : undefined}
        value={text} placeholder="Find a builder" spellCheck={false} autoCapitalize="off" autoComplete="off"
        onChange={event => { setText(event.target.value); setOpen(true); setActive(event.target.value.trim() ? 0 : -1); }}
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKeyDown} />
      {shown && <ul id={`${id}-list`} className="builder-picker-list" role="listbox" aria-label="Builders">
        {note && matches.length === 0
          ? <li className="palette-note" role="presentation">{note}</li>
          : matches.map((c, i) => <li key={c.name} id={optionId(c.name)} role="option" aria-selected={i === active} className={`palette-row${i === active ? " selected" : ""}`}
            onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => pick(c)}>
            <Avatar name={c.name} size={22} kind={c.kind === "agent" ? "agent" : undefined} />
            <span className="palette-label">{c.name}</span>
            {c.kind === "agent" && <span className="label">your agent</span>}
          </li>)}
      </ul>}
    </div>
    <button type="submit" className="button primary small" disabled={busy || !chosen}><UserPlus size={14} />{adding ? "Adding…" : "Add"}</button>
  </form>;
}

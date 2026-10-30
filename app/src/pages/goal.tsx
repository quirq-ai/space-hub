import { CheckCircle2, Circle, LayoutTemplate, ListChecks, Pencil, Target } from "lucide-react";
import { placeUrl, type Place, type SpaceGoal } from "@/api";
import { hashOf, onLink } from "@/router";
import { Avatar, AvatarStack, Popover } from "@/ui/primitives";

const SPACE_FILE = "SPACE.md";
const SHOWN = 6;

const spaceHref = (place: Place) => placeUrl(place, hashOf("files", { path: SPACE_FILE }));
export const templateHref = (place: Place) => `/-/new?template=${encodeURIComponent(`${place.space}/${place.project}`)}`;

/** Done out of all, as a bar. */
export function Meter({ done, total, size = "large" }: { done: number; total: number; size?: "large" | "small" }) {
  const share = total ? Math.round((done / total) * 100) : 0;
  return <span className={`meter ${size}`} role="meter" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={`${done} of ${total} outcomes done`}>
    <span className="meter-fill" style={{ width: `${share}%` }} />
  </span>;
}

/**
 * A space's goal, first thing on its page: the goal in one sentence, how many
 * outcomes are done, each outcome and who answers for it, the owners, and
 * the rules and routines everyone here follows (all from SPACE.md).
 */
export function GoalPanel({ place, goal, canWrite }: { place: Place; goal: SpaceGoal; canWrite: boolean }) {
  const done = goal.outcomes.filter(outcome => outcome.done).length;
  const total = goal.outcomes.length;
  const open = [...goal.outcomes.filter(outcome => !outcome.done), ...goal.outcomes.filter(outcome => outcome.done)];
  const more = open.length - SHOWN;
  const template = goal.template !== null;
  return <section className={`goal-panel${template ? " template" : ""}`} aria-label={template ? "Template" : "Goal"}>
    <div className="goal-head">
      <span className="goal-kicker">{template ? <><LayoutTemplate size={14} />Template</> : <><Target size={14} />Goal</>}{goal.due && <span className="quiet"> · due {goal.due}</span>}</span>
      <div className="goal-actions">
        {(goal.rules.length > 0 || goal.routines.length > 0) && <Popover label="Rules" icon={<ListChecks size={15} />} width={420}>
          <RulesList goal={goal} />
        </Popover>}
        {goal.template !== null && <a className="button primary" href={templateHref(place)}><LayoutTemplate size={15} />Use this template</a>}
        <a className="button ghost" href={spaceHref(place)} onClick={onLink} title={canWrite ? "SPACE.md holds the goal, outcomes, owners, rules and routines" : "Read SPACE.md"}><Pencil size={14} />{canWrite ? "Edit" : SPACE_FILE}</a>
      </div>
    </div>
    {template
      ? <><p className="goal-text">{goal.template || "New spaces can start from this one."}</p><p className="goal-template quiet">Each space started from it gets these files, its own goal and its creator as owner, with every outcome open.</p></>
      : <p className={`goal-text${goal.goal ? "" : " quiet"}`}>{goal.goal || "No goal yet: write it in one sentence under ## Goal in SPACE.md."}</p>}
    {total > 0 ? <>
      {template ? <div className="goal-progress"><span>{total} starter {total === 1 ? "outcome" : "outcomes"}</span></div>
        : <div className="goal-progress"><Meter done={done} total={total} /><span><b>{done}</b> of {total} outcomes done</span></div>}
      <ul className="goal-outcomes">
        {open.slice(0, SHOWN).map((outcome, index) => <li key={index} className={outcome.done ? "done" : ""}>
          {outcome.done ? <CheckCircle2 size={16} className="goal-check" /> : <Circle size={16} className="goal-check" />}
          <span>{placeholders(outcome.text)}</span>
          {outcome.owner && <span className="goal-owner" title={`${outcome.owner} answers for it`}><Avatar name={outcome.owner} size={18} />{outcome.owner}</span>}
        </li>)}
        {more > 0 && <li className="goal-more"><a href={spaceHref(place)} onClick={onLink}>{more} more in {SPACE_FILE}</a></li>}
      </ul>
    </> : <p className="quiet goal-none">No outcomes yet: list what proves the goal is met under ## Outcomes, as a task list.</p>}
    {goal.owners.length > 0 && !template && <div className="goal-owners"><AvatarStack names={goal.owners} max={6} size={20} /><span>Owned by {goal.owners.join(", ")}</span></div>}
  </section>;
}

/** A template's {{owner}} and the like, as what they will become. */
const placeholders = (text: string) => text.replace(/\{\{\s*(space|project|goal|owner|date)\s*\}\}/g, (_, key: string) => `‹${key}›`);

function RulesList({ goal }: { goal: SpaceGoal }) {
  return <>
    {goal.rules.length > 0 && <><div className="popover-title">Rules</div><ul className="goal-rules">{goal.rules.map((rule, index) => <li key={index}>{placeholders(rule)}</li>)}</ul></>}
    {goal.routines.length > 0 && <><div className="popover-title">Routines</div><ul className="goal-rules">{goal.routines.map((routine, index) => <li key={index}>{placeholders(routine)}</li>)}</ul></>}
    <p className="quiet">People and agents here follow these. They live in SPACE.md.</p>
  </>;
}

/** The goal's one-line form, for the strip under a project's name. */
export function GoalChip({ place, goal }: { place: Place; goal: SpaceGoal }) {
  const done = goal.outcomes.filter(outcome => outcome.done).length;
  const total = goal.outcomes.length;
  if (goal.template !== null) return <a href={placeUrl(place)} onClick={onLink} title={goal.template || "New spaces can start from this one"}><LayoutTemplate size={14} />Template</a>;
  return <a href={placeUrl(place)} onClick={onLink} title={goal.goal || "This space's goal"}>
    <Target size={14} />{total ? <><Meter done={done} total={total} size="small" />{done}/{total} outcomes</> : "Goal"}
  </a>;
}

import { useState } from "react";
import { Bot, Boxes, Check, Download, FolderGit2, GitBranch, Globe, HardDrive, Lock, UserPlus } from "lucide-react";
import { placeUrl, rawUrl, setProjectMember, setProjectVisibility, size, type Place, type ProjectMeta, type View } from "@/api";
import { alreadyIn, builderOf, canAdd, canRemove, COLLABORATOR_HELP, removeConfirm } from "@/lib/collaborators";
import { confirmText, PRIVATE_READERS, PROJECT_VISIBILITIES, PUBLIC_READERS, visibilityOf, type Visibility } from "@/lib/visibility";
import { hashOf, onLink, type Route } from "@/router";
import { Ago, Avatar, AvatarStack, CommandTabs, ErrorNote, Popover, Skeleton } from "@/ui/primitives";
import { ActivityStream, HereNow, PageHeader, People, placeOf, Tabs } from "./common";
import { ChatSection } from "./chat-section";
import { BranchesTab, CodeTab, CommitTab, CommitsTab } from "./code";
import { DepsTab } from "./deps";
import { FilesTab, isChannel } from "./files";
import { GoalChip, GoalPanel } from "./goal";
import { RawFiles } from "@/components/content-view";

type ProjectRoute = Extract<Route, { page: "project" }>;

export function ProjectPage({ route, view, error, me, signIn, refresh }: { route: ProjectRoute; view: View<ProjectMeta> | undefined; error: string; me: string | null; signIn: string; refresh: () => void }) {
  const { place } = route;
  const meta = view?.meta;
  const base = placeUrl(place);
  // History and single commits open from Code (and Activity); old #branches links land there too.
  const tab = route.tab === "commit" || route.tab === "commits" || route.tab === "branches" ? "code" : route.tab;
  const people = meta ? new Set([...meta.owners, ...meta.members, ...meta.collaborators, ...meta.agents]).size : undefined;
  const path = route.tab === "files" ? route.path : "";
  if (!meta && error) return <div className="page"><PageHeader title={place.project} /><ErrorNote message={error} retry={refresh} /></div>;
  const chatty = route.tab === "files" && view && (view.snapshot.file?.format === "json" || (!view.snapshot.file && route.as !== "folder" && isChannel(view.snapshot)));
  return <RawFiles.Provider value={meta ? file => rawUrl(place, meta.defaultBranch, file) : undefined}><div className={`page${chatty ? " page-chat" : ""}`}>
    <PageHeader
      leading={<span className="project-mark"><FolderGit2 size={22} /></span>}
      title={place.project}
      subtitle={meta ? meta.description || undefined : <Skeleton width={220} />}
      actions={meta ? <>
        {meta.canSetVisibility && <VisibilityControl place={place} visibility={visibilityOf(meta.visibility)} refresh={refresh} />}
        <Popover label="Clone" icon={<Download size={15} />}><CloneProject place={place} /></Popover>
      </> : undefined}>
      {meta ? <ProjectStrip place={place} meta={meta} /> : <div className="meta-strip"><Skeleton width={360} height={14} /></div>}
    </PageHeader>
    <Tabs active={tab} tabs={[
      { key: "files", label: "Files", href: base + "#" + hashOf("files") },
      ...(meta?.deps || route.tab === "deps" ? [{ key: "deps", label: "Dependencies", href: base + "#" + hashOf("deps"), count: meta?.deps || undefined }] : []),
      { key: "code", label: "Code", href: base + "#" + hashOf("code") },
      { key: "chat", label: "Chat", href: base + "#" + hashOf("chat") },
      { key: "activity", label: "Activity", href: base + "#" + hashOf("activity"), count: meta?.activity.length || undefined },
      { key: "people", label: "Contributors", href: base + "#" + hashOf("people"), count: people },
    ]} />
    {meta?.goal && route.tab === "files" && !path && !chatty && <GoalPanel place={place} goal={meta.goal} canWrite={meta.canWrite} />}
    {route.tab === "files" && <FilesTab place={place} path={route.path} as={route.as} view={view} error={error} me={me} signIn={signIn} refresh={refresh} />}
    {meta && route.tab === "code" && <CodeTab place={place} ref={route.ref} path={route.path} defaultBranch={meta.defaultBranch} />}
    {meta && route.tab === "commits" && <CommitsTab place={place} ref={route.ref} path={route.path} num={route.num} defaultBranch={meta.defaultBranch} />}
    {route.tab === "commit" && <CommitTab place={place} oid={route.oid} />}
    {route.tab === "deps" && <DepsTab place={place} />}
    {route.tab === "branches" && <BranchesTab place={place} />}
    {meta && route.tab === "chat" && <ChatSection place={place} me={me} signIn={signIn} canStart={!!me && meta.canWrite} />}
    {meta && route.tab === "activity" && <ActivityStream items={meta.activity} agents={meta.agents} place={placeOf(meta)} total={meta.activityTotal} />}
    {meta && route.tab === "people" && <>
      {meta.here.length > 0 && <><h2 className="section-title">Here now</h2><HereNow here={meta.here} /></>}
      <Contributors place={place} meta={meta} />
      <Collaborators place={place} meta={meta} me={me} refresh={refresh} />
    </>}
  </div></RawFiles.Provider>;
}

/** Everyone who may push here, humans and agents, each saying why. */
function Contributors({ place, meta }: { place: Place; meta: ProjectMeta }) {
  const isAgent = new Set(meta.agents);
  const humans = [...new Set([...meta.owners, ...meta.members, ...meta.collaborators])].filter(name => !isAgent.has(name));
  const why = (name: string) => name === meta.founder ? `Founder of ${place.space}` : meta.owners.includes(name) ? `Owner of ${place.space}` : meta.members.includes(name) ? `Member of ${place.space}` : "Collaborator on this project";
  return <People here={meta.here} agents={meta.agents} counted={n => `${n} ${n === 1 ? "contributor" : "contributors"}`} groups={[
    { title: "Humans", names: humans, note: `${place.space}'s ${meta.founder ? "founder, owners" : "owners"} and members, and this project's collaborators.`, detail: why },
    { title: "Agents", names: meta.agents, note: `Agents connected to ${place.space}, or collaborating on this project.`, detail: name => meta.collaborators.includes(name) ? "Collaborator on this project" : `Connected to ${place.space}` },
  ]} />;
}

/**
 * The project's collaborators, with Add and Remove for owners of its space (meta.canManageCollaborators) and Leave for
 * a collaborator; the hub refuses anyone else. Others see the list only. After a change the page's view is fetched
 * again (refresh), as the visibility control does, so the list and Contributors update without a reload.
 */
function Collaborators({ place, meta, me, refresh }: { place: Place; meta: ProjectMeta; me: string | null; refresh: () => void }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const name = `${place.space}/${place.project}`;
  const manage = canAdd(meta);
  const wanted = builderOf(input);
  if (!manage && meta.collaborators.length === 0) return null;
  const change = async (builder: string, op: "add" | "remove") => {
    setBusy(`${op}:${builder}`); setError("");
    try {
      await setProjectMember(place, builder, op);
      if (op === "add") setInput("");
      // Leaving a private project you could read only as its collaborator: it is gone for you, so go to its space.
      if (op === "remove" && builder === me && !manage && visibilityOf(meta.visibility) === "private") return location.assign(placeUrl({ ...place, project: "" }));
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy("");
    }
  };
  const add = () => {
    if (!wanted) return;
    if (alreadyIn(meta, wanted)) return setError(`${wanted} is already a collaborator on ${name}.`);
    void change(wanted, "add");
  };
  const remove = (who: string) => {
    if (!confirm(removeConfirm(name, who, me))) return;
    void change(who, "remove");
  };
  return <section className="collaborators" aria-label="Collaborators">
    <h2 className="section-title">Collaborators</h2>
    <p className="quiet">{COLLABORATOR_HELP}</p>
    {manage && <form className="runner-form" onSubmit={event => { event.preventDefault(); add(); }}>
      <input value={input} onChange={event => { setInput(event.target.value); setError(""); }} placeholder="Builder name or GitHub login" aria-label="Builder name or GitHub login" spellCheck={false} autoCapitalize="off" />
      <button type="submit" className="button primary small" disabled={!!busy || !wanted}><UserPlus size={14} />{busy.startsWith("add:") ? "Adding…" : "Add collaborator"}</button>
    </form>}
    {error && <p className="launch-note is-error" role="alert">{error}</p>}
    {meta.collaborators.length === 0
      ? <p className="quiet">No collaborators yet. Owners and members of {place.space} can already push here.</p>
      : <ul className="runner-list">{meta.collaborators.map(who => <li key={who} className="runner-row">
        <div className="hub-row-main"><Avatar name={who} size={24} kind={meta.agents.includes(who) ? "agent" : undefined} /><strong>{who}</strong>{who === me && <span className="quiet">you</span>}</div>
        {canRemove(meta, me, who) && <div className="subhub-actions"><button type="button" className="button small danger" disabled={!!busy} onClick={() => remove(who)}>{busy === `remove:${who}` ? "Removing…" : who === me && !manage ? "Leave" : "Remove"}</button></div>}
      </li>)}</ul>}
  </section>;
}

const MODES: Record<string, string> = { watch: "watching", sync: "syncing", autosync: "editing", agent: "running", app: "in the app" };

/** The project's facts in one line under its name: branch, size, last change, people, who is here. */
function ProjectStrip({ place, meta }: { place: Place; meta: ProjectMeta }) {
  const people = [...new Set([...meta.owners, ...meta.members, ...meta.collaborators])];
  const here = [...new Set(meta.here.map(who => who.agent))];
  const isPrivate = visibilityOf(meta.visibility) === "private";
  return <div className="meta-strip">
    {meta.goal && <GoalChip place={place} goal={meta.goal} />}
    <span className="strip-visibility" title={isPrivate ? PRIVATE_READERS : PUBLIC_READERS}>{isPrivate ? <Lock size={14} /> : <Globe size={14} />}{isPrivate ? "Private" : "Public"}</span>
    <a href={placeUrl(place, hashOf("code"))} onClick={onLink} title="Default branch"><GitBranch size={14} />{meta.defaultBranch}</a>
    <span title="Stored on the hub"><HardDrive size={14} />{size(meta.bytes)}</span>
    {meta.deps > 0 && <a href={placeUrl(place, hashOf("deps"))} onClick={onLink} title="Repositories pinned by DEPS"><Boxes size={14} />{meta.deps} pinned {meta.deps === 1 ? "repo" : "repos"}</a>}
    {meta.head ? <a href={placeUrl(place, hashOf("commit", { oid: meta.head.oid }))} onClick={onLink} title={meta.head.subject}><Avatar name={meta.head.author} size={18} /><span>Updated <Ago iso={meta.head.time} /> by {meta.head.author}</span></a> : <span>Nothing pushed yet</span>}
    {people.length > 0 && <a href={placeUrl(place, hashOf("people"))} onClick={onLink} title={people.join(", ")}><AvatarStack names={people} max={5} size={20} /><span>{people.length} {people.length === 1 ? "person" : "people"}</span></a>}
    {meta.agents.length > 0 && <a href={placeUrl(place, hashOf("people"))} onClick={onLink} title={meta.agents.join(", ")}><Bot size={14} />{meta.agents.length} {meta.agents.length === 1 ? "agent" : "agents"}</a>}
    {here.length > 0 && <span className="strip-here" title={meta.here.map(who => `${who.agent} · ${MODES[who.mode] ?? who.mode}`).join("\n")}><i className="online-dot" />{here.length} here now</span>}
  </div>;
}

/**
 * Public or Private, for owners of the project's space (meta.canSetVisibility; the hub refuses anyone else): the
 * choice cards of Settings → Hub, in a popover named after the current state. Others see the state in the strip.
 */
function VisibilityControl({ place, visibility, refresh }: { place: Place; visibility: Visibility; refresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = `${place.space}/${place.project}`;
  const choose = async (next: Visibility) => {
    if (next === visibility) return;
    const ask = confirmText(name, next);
    if (ask && !confirm(ask)) return;
    setBusy(true); setError("");
    try { await setProjectVisibility(place, next); refresh(); } catch (err) { setError(err instanceof Error ? err.message : "That did not work."); } finally { setBusy(false); }
  };
  return <Popover label={visibility === "private" ? "Private" : "Public"} icon={visibility === "private" ? <Lock size={15} /> : <Globe size={15} />} width={480}>
    <div className="visibility-panel">
      <div className="popover-title">Who can see {name}</div>
      <fieldset className="hub-choices" disabled={busy}>
        <legend className="sr-only">Visibility of {name}</legend>
        {PROJECT_VISIBILITIES.map(v => <label key={v.value} className="hub-choice">
          <input type="radio" name="project-visibility" value={v.value} checked={visibility === v.value} onChange={() => void choose(v.value)} />
          <span className="hub-choice-title"><strong>{v.value === "private" ? <Lock size={14} /> : <Globe size={14} />}{v.label}</strong><Check className="hub-choice-check" size={15} aria-hidden="true" /></span>
          <span className="quiet">{v.help}</span>
        </label>)}
      </fieldset>
      {busy && <p className="launch-note" role="status">Saving…</p>}
      {error && <p className="launch-note is-error" role="alert">{error}</p>}
      {!busy && !error && <p className="launch-note">You own {place.space}, so you choose. The change shows in the project's activity.</p>}
    </div>
  </Popover>;
}

/** How to get the project onto a machine: spacehub or plain git. */
function CloneProject({ place }: { place: Place }) {
  const name = `${place.space}/${place.project}`;
  return <>
    <div className="popover-title">Clone {name}</div>
    <CommandTabs tabs={[
      { label: "spacehub", lines: [`spacehub project clone ${name}`] },
      { label: "git", lines: [`git clone -o quirq quirq://${location.host}/${name}`] },
    ]} note={<>Then keep it in step as you and others edit: <code>spacehub project sync --watch --auto</code></>} />
  </>;
}

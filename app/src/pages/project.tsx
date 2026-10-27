import { FolderGit2, Github } from "lucide-react";
import { placeUrl, size, type HubMeta, type Place, type ProjectMeta, type SpaceMeta, type View } from "@/api";
import { hashOf, onLink, type Route } from "@/router";
import { InspectorSection } from "@/shell/shell";
import { Ago, Avatar, AvatarStack, CopyButton, ErrorNote, PersonLink, Skeleton } from "@/ui/primitives";
import { ActivityList, HereNow, PageHeader, People, Tabs } from "./common";
import { BranchesTab, CodeTab, CommitTab, CommitsTab } from "./code";
import { FilesTab } from "./files";

type ProjectRoute = Extract<Route, { page: "project" }>;

export function ProjectPage({ route, view, error, me, signIn, refresh }: { route: ProjectRoute; view: View<ProjectMeta> | undefined; error: string; me: string | null; signIn: string; refresh: () => void }) {
  const { place } = route;
  const meta = view?.meta;
  const base = placeUrl(place);
  const tab = route.tab === "commit" ? "commits" : route.tab;
  const people = meta ? new Set([...meta.owners, ...meta.members, ...meta.collaborators]).size : undefined;
  if (!meta && error) return <div className="page"><PageHeader crumbs={[{ label: place.space, href: placeUrl({ space: place.space, project: "" }) }]} title={place.project} /><ErrorNote message={error} retry={refresh} /></div>;
  return <div className={`page${route.tab === "files" && view?.snapshot.file?.format === "json" ? " page-chat" : ""}`}>
    <PageHeader
      crumbs={[{ label: place.space, href: placeUrl({ space: place.space, project: "" }) }]}
      leading={<span className="project-mark"><FolderGit2 size={22} /></span>}
      title={place.project}
      subtitle={meta ? meta.description || (meta.head ? <>Updated <Ago iso={meta.head.time} /> by {meta.head.author}</> : "Nothing pushed yet") : <Skeleton width={220} />}
      actions={meta && meta.here.length > 0 ? <span className="here-badge" title="Connected now"><AvatarStack names={[...new Set(meta.here.map(who => who.agent))]} /><span>{meta.here.length} here</span></span> : undefined} />
    <Tabs active={tab} tabs={[
      { key: "files", label: "Files", href: base + "#" + hashOf("files") },
      { key: "code", label: "Code", href: base + "#" + hashOf("code") },
      { key: "commits", label: "Commits", href: base + "#" + hashOf("commits") },
      { key: "branches", label: "Branches", href: base + "#" + hashOf("branches") },
      { key: "activity", label: "Activity", href: base + "#" + hashOf("activity") },
      { key: "people", label: "People", href: base + "#" + hashOf("people"), count: people },
    ]} />
    {route.tab === "files" && <FilesTab place={place} path={route.path} view={view} error={error} me={me} signIn={signIn} refresh={refresh} />}
    {meta && route.tab === "code" && <CodeTab place={place} ref={route.ref} path={route.path} defaultBranch={meta.defaultBranch} />}
    {meta && route.tab === "commits" && <CommitsTab place={place} ref={route.ref} path={route.path} num={route.num} defaultBranch={meta.defaultBranch} />}
    {route.tab === "commit" && <CommitTab place={place} oid={route.oid} />}
    {route.tab === "branches" && <BranchesTab place={place} />}
    {meta && route.tab === "activity" && <ActivityList items={meta.activity} />}
    {meta && route.tab === "people" && <>
      <h2 className="section-title">Here now</h2><HereNow here={meta.here} />
      <People groups={[
        { title: "Owners", names: meta.owners, note: `They manage ${place.space}.` },
        { title: "Members", names: meta.members, note: `They push to every project of ${place.space}.` },
        { title: "Collaborators", names: meta.collaborators, note: "They push to this project." },
      ]} />
    </>}
  </div>;
}

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return <dl className="facts">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function Clone({ lines }: { lines: string[] }) {
  return <div className="clone">{lines.map(line => <div className="clone-line" key={line}><code>{line}</code><CopyButton text={line} label="Copy command" /></div>)}</div>;
}

export function ProjectInspector({ place, meta }: { place: Place; meta: ProjectMeta }) {
  const host = location.host;
  return <>
    <InspectorSection title="About"><p className="inspector-text">{meta.description || "No description."}</p>
      <Facts rows={[["Branch", meta.defaultBranch], ["Stored", size(meta.bytes)], ["Space", <a href={placeUrl({ space: place.space, project: "" })} onClick={onLink}>{place.space}</a>]]} /></InspectorSection>
    {meta.head && <InspectorSection title="Last change"><a className="last-change" href={placeUrl(place, hashOf("commit", { oid: meta.head.oid }))} onClick={onLink}>
      <Avatar name={meta.head.author} size={22} /><span><strong>{meta.head.subject}</strong><span className="quiet">{meta.head.author} · <Ago iso={meta.head.time} /></span></span></a></InspectorSection>}
    <InspectorSection title={`Here now${meta.here.length ? ` · ${meta.here.length}` : ""}`}><HereNow here={meta.here} /></InspectorSection>
    <InspectorSection title="People">{[...meta.owners, ...meta.members, ...meta.collaborators].length ? <AvatarStack names={[...new Set([...meta.owners, ...meta.members, ...meta.collaborators])]} max={8} size={26} /> : <p className="quiet">Nobody yet.</p>}</InspectorSection>
    <InspectorSection title="Work on it"><Clone lines={[`spacehub project clone ${place.space}/${place.project}`, `git clone -o quirq quirq://${host}/${place.space}/${place.project}`]} />
      <p className="quiet small">Keep a clone in step with <code>spacehub project sync --watch --auto</code>.</p></InspectorSection>
  </>;
}

export function SpaceInspector({ name, meta }: { name: string; meta: SpaceMeta }) {
  return <>
    <InspectorSection title="About"><Facts rows={[
      ["Kind", meta.kind === "personal" ? "Builder" : meta.kind === "org" ? "Org" : `Agent of ${meta.parent}`],
      ["Projects", String(meta.projects)], ["Stored", size(meta.bytes)], ["Joined", <Ago iso={meta.createdAt} />],
      ...(meta.githubLogin ? [["GitHub", <a href={`https://github.com/${meta.githubLogin}`} target="_blank" rel="noreferrer"><Github size={13} /> {meta.githubLogin}</a>] as [string, React.ReactNode]] : []),
    ]} /></InspectorSection>
    <InspectorSection title={`Here now${meta.here.length ? ` · ${meta.here.length}` : ""}`}><HereNow here={meta.here} /></InspectorSection>
    {meta.kind !== "personal" && <InspectorSection title="Owners"><ul className="people-list">{meta.owners.map(owner => <li key={owner}><PersonLink name={owner} /></li>)}</ul></InspectorSection>}
    {meta.members.length > 0 && <InspectorSection title="Members"><AvatarStack names={meta.members} max={10} size={26} /></InspectorSection>}
    <InspectorSection title="Work on it"><Clone lines={[`spacehub space clone ${name}`]} /></InspectorSection>
  </>;
}

export function HubInspector({ meta }: { meta: HubMeta }) {
  return <>
    <InspectorSection title="This hub"><Facts rows={[["Address", location.host], ["Spaces", String(meta.spaces)], ["Projects", String(meta.projects)], ["Stored", size(meta.bytes)]]} /></InspectorSection>
    <InspectorSection title={`Here now${meta.here.length ? ` · ${meta.here.length}` : ""}`}><HereNow here={meta.here} /></InspectorSection>
    <InspectorSection title="Get started"><Clone lines={["spacehub auth login", "spacehub project create notes --source . --push"]} /><p className="quiet small"><a href="/-/guide">Read the guide</a> for everything else.</p></InspectorSection>
  </>;
}

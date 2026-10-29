import { ArrowUpRight, Boxes, FolderGit2, Globe } from "lucide-react";
import { codeUrl, placeUrl, type Dep, type Deps, type Place } from "@/api";
import { useLive } from "@/hooks/use-live";
import { hashOf, onLink } from "@/router";
import { Ago, Empty, ErrorNote, SkeletonRows } from "@/ui/primitives";

const placeOf = (fullName: string): Place => { const [space, project] = fullName.split("/"); return { space, project }; };
const shortUrl = (url: string) => url.replace(/^[a-z+]+:\/\//i, "").replace(/^git@([^:]+):/, "$1/").replace(/\.git\/?$/, "");

/** How far a pin is from its project's newest commit, in a word or two. */
function PinStatus({ dep }: { dep: Dep }) {
  const branch = dep.defaultBranch || "the default branch";
  switch (dep.status) {
    case "current": return <span className="label done" title={`The newest commit on ${branch}`}>Current</span>;
    case "behind": return <a className="label open" href={placeUrl(placeOf(dep.project), hashOf("commits"))} onClick={onLink} title={`${dep.behind} newer ${dep.behind === 1 ? "commit" : "commits"} on ${branch}`}>{dep.behind} behind</a>;
    case "elsewhere": return <span className="label open" title={`The hub has this commit, but not in the recent history of ${branch}`}>Not on {branch}</span>;
    case "missing": return <span className="label warn" title={`${dep.project} on the hub does not have this commit`}>Pin not on the hub</span>;
    case "invalid": return <span className="label warn" title="A pin is a full 40-character commit id">Not a commit id</span>;
    default: return <span className="label quiet-label" title="No project on this hub holds this repository">Not on the hub</span>;
  }
}

function PinLink({ dep }: { dep: Dep }) {
  const short = dep.pin.slice(0, 7) || "no pin";
  if (dep.project && dep.pinned) return <a className="mono" href={placeUrl(placeOf(dep.project), hashOf("commit", { oid: dep.pin }))} onClick={onLink} title={dep.pinned.subject}>{short}</a>;
  if (dep.github && dep.status !== "invalid") return <a className="mono" href={`${dep.github}/commit/${dep.pin}`} target="_blank" rel="noreferrer noopener">{short}</a>;
  return <span className="mono">{short}</span>;
}

/** The repositories a DEPS file pins: each linked to its hub project, with its pin and whether it is current. */
export function DepsTab({ place }: { place: Place }) {
  const live = useLive<Deps>(codeUrl(place, "deps"), 15_000);
  const data = live.data;
  if (!data) return live.error ? <ErrorNote message={live.error} retry={live.refresh} /> : <SkeletonRows rows={6} />;
  const depsHref = placeUrl(place, hashOf("files", { path: data.path }));
  if (!data.found) return <Empty icon={<Boxes size={20} />} title="No DEPS file"><p>A DEPS file at the root pins other repositories, each to a commit.</p></Empty>;
  if (!data.valid) return <Empty icon={<Boxes size={20} />} title="DEPS is not a list of pins"><p>The hub reads a JSON object of <code>path: {"{"} url, commit-hash {"}"}</code>. <a href={depsHref} onClick={onLink}>Open DEPS</a></p></Empty>;
  const onHub = data.deps.filter(dep => dep.project).length;
  const behind = data.deps.filter(dep => dep.status === "behind").length;
  return <div className="deps">
    <p className="deps-summary quiet">
      {data.deps.length} {data.deps.length === 1 ? "repository" : "repositories"} pinned in <a href={depsHref} onClick={onLink}>DEPS</a> on {data.ref}
      {" · "}{onHub} on the hub{behind > 0 && <> · {behind} behind</>}
    </p>
    {data.deps.length ? <ul className="rows">{data.deps.map(dep => {
      const Icon = dep.project ? FolderGit2 : Globe;
      const outside = dep.github || (/^https?:\/\//i.test(dep.url) ? dep.url : "");
      return <li key={dep.path}><div className="row dep-row">
        <Icon size={18} className="row-icon" />
        <span className="row-main">
          <div className="row-title"><strong>{dep.path}</strong><PinStatus dep={dep} /></div>
          <span>
            {dep.project ? <a href={placeUrl(placeOf(dep.project))} onClick={onLink}>{dep.project}</a>
              : outside ? <a href={outside} target="_blank" rel="noreferrer noopener">{shortUrl(dep.url)}<ArrowUpRight size={11} /></a> : shortUrl(dep.url)}
            {" · "}<PinLink dep={dep} />{dep.pinned && <> {dep.pinned.subject}</>}
          </span>
        </span>
        <span className="row-meta">{dep.pinned && <Ago iso={dep.pinned.time} />}</span>
      </div></li>;
    })}</ul> : <Empty icon={<Boxes size={20} />} title="DEPS pins nothing yet" />}
  </div>;
}

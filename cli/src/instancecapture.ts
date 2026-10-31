// Capture the explicitly selected Docker deployment while every selected
// container is stopped. Private inspect configuration belongs only in the
// snapshot, never in its public summary. No restore starts a container here.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { InstanceVault, DEFAULT_INSTANCE_VAULT_BYTES, type Snapshot } from './instancevault.ts';

interface DockerMount { Type: string; Source?: string; Destination: string; [key: string]: unknown }
interface ContainerInspect {
  Id: string;
  Name?: string;
  Image: string;
  Config: { Env?: string[]; Entrypoint?: string[] | null; [key: string]: unknown };
  State: { Running: boolean; Paused?: boolean; Restarting?: boolean; Dead?: boolean; ExitCode?: number; OOMKilled?: boolean; Error?: string; [key: string]: unknown };
  Mounts: DockerMount[];
  [key: string]: unknown;
}
export interface CaptureDeploymentOptions { containers: string[]; storage: string; allowStop: boolean; maxBytes?: number }
export interface CaptureDeploymentDeps {
  runDocker?: (args: string[]) => Promise<string>;
  /** Write Docker's binary stdout verbatim; never decode or extract a mount archive. */
  runDockerArchive?: (args: string[], output: string) => Promise<void>;
}
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function inside(root: string, filename: string) {
  const relative = path.relative(root, filename);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function noLinks(filename: string) {
  for (let current = path.resolve(filename); ; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Capture paths must not contain symlinks or junctions'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (current === path.dirname(current)) return;
  }
}
function treeBytes(filename: string): number {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink()) throw new Error('Persistent mounts and capture output must not contain symlinks');
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) throw new Error('Persistent mounts contain unsupported filesystem entries');
  const bytes = fs.readdirSync(filename).reduce((sum, name) => sum + treeBytes(path.join(filename, name)), 0);
  if (!Number.isSafeInteger(bytes)) throw new Error('Capture size exceeds the supported range');
  return bytes;
}
function containerPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(value)) throw new Error('Persistent mounts need absolute Linux container paths');
  const normalized = value.length > 1 ? value.replace(/\/+$/, '') : value;
  if (normalized.split('/').some((part, index) => index > 0 && (!part || part === '.' || part === '..'))) throw new Error('Persistent mount paths must not contain traversal');
  return normalized;
}

function inspectResult(text: string): ContainerInspect {
  let values: unknown;
  try { values = JSON.parse(text); } catch { throw new Error('Docker returned invalid container metadata'); }
  const value = Array.isArray(values) && values.length === 1 ? values[0] : null;
  if (!object(value) || typeof value.Id !== 'string' || !CONTAINER_ID.test(value.Id) || typeof value.Image !== 'string' || !IMAGE_ID.test(value.Image) || !object(value.Config) || !object(value.State) || typeof value.State.Running !== 'boolean' || !Array.isArray(value.Mounts)) throw new Error('Docker returned incomplete container metadata');
  if ((value.Config.Env !== undefined && (!Array.isArray(value.Config.Env) || value.Config.Env.some(entry => typeof entry !== 'string'))) || (value.Config.Entrypoint !== undefined && value.Config.Entrypoint !== null && (!Array.isArray(value.Config.Entrypoint) || value.Config.Entrypoint.some(entry => typeof entry !== 'string')))) throw new Error('Docker returned invalid runtime configuration');
  if (value.State.Paused || value.State.Restarting || value.State.Dead) throw new Error('Paused, restarting or dead containers must be stabilized before capture');
  for (const mount of value.Mounts) {
    if (!object(mount) || typeof mount.Type !== 'string') throw new Error('Docker returned invalid persistent mount metadata');
    containerPath(mount.Destination);
    if (!['bind', 'volume', 'tmpfs'].includes(mount.Type)) throw new Error('This deployment uses an unsupported mount type');
    if (mount.Type !== 'tmpfs' && (typeof mount.Source !== 'string' || !mount.Source)) throw new Error('Persistent mounts need a recorded source');
  }
  return value as unknown as ContainerInspect;
}

function rootCoverage(containers: ContainerInspect[]) {
  let foundHub = false;
  for (const container of containers) {
    const environment = new Map((container.Config.Env ?? []).map(entry => { const at = entry.indexOf('='); return at < 0 ? [entry, ''] : [entry.slice(0, at), entry.slice(at + 1)]; }));
    const isHub = environment.has('SPACETIME_ROOT') || environment.has('SPACEHUB_DB') || container.Config.Entrypoint?.some(value => value.includes('spacehub-server'));
    if (!isHub) continue;
    foundHub = true;
    const root = containerPath(environment.get('SPACETIME_ROOT') || '/data');
    if (!container.Mounts.some(mount => mount.Type !== 'tmpfs' && (containerPath(mount.Destination) === root || root.startsWith(containerPath(mount.Destination).replace(/\/$/, '') + '/')))) throw new Error('The hub data root must be backed by a persistent bind or volume mount');
  }
  if (!foundHub) throw new Error('Select a hub container with a persistent /data or SPACETIME_ROOT mount');
}

/** Docker writes archives directly to disk; stdout is only small control JSON. */
async function runDocker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    let failed: Error | undefined;
    const timer = setTimeout(() => { failed = new Error('Docker capture command timed out'); child.kill('SIGKILL'); }, 30 * 60_000);
    child.stdout.on('data', (part: Buffer) => { bytes += part.length; if (bytes > 16 * 1024 * 1024) { failed = new Error('Docker control output exceeded its limit'); child.kill('SIGKILL'); } else output.push(part); });
    child.stderr.on('data', part => { stderr = (stderr + String(part)).slice(-64 * 1024); });
    child.once('error', error => { failed = error; });
    child.once('close', code => {
      clearTimeout(timer);
      if (failed) reject(failed);
      else if (code !== 0) reject(new Error(`Docker ${args[0]} failed: ${stderr.trim().slice(-2000) || code}`));
      else resolve(Buffer.concat(output).toString('utf8'));
    });
  });
}

/** Give Docker an exclusive private file descriptor for its binary TAR stdout. */
async function runDockerArchive(args: string[], output: string): Promise<void> {
  const fd = fs.openSync(output, 'wx', 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('docker', args, { windowsHide: true, stdio: ['ignore', fd, 'pipe'] });
      let stderr = '';
      let failed: Error | undefined;
      const timer = setTimeout(() => { failed = new Error('Docker archive command timed out'); child.kill('SIGKILL'); }, 30 * 60_000);
      child.stderr!.on('data', part => { stderr = (stderr + String(part)).slice(-64 * 1024); });
      child.once('error', error => { failed = error; });
      child.once('close', code => {
        clearTimeout(timer);
        if (failed) reject(failed);
        else if (code !== 0) reject(new Error(`Docker ${args[0]} archive failed: ${stderr.trim().slice(-2000) || code}`));
        else resolve();
      });
    });
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

export async function captureDeployment(options: CaptureDeploymentOptions, deps: CaptureDeploymentDeps = {}): Promise<Snapshot> {
  if (!Array.isArray(options.containers) || !options.containers.length || options.containers.length > 64 || options.containers.some(name => typeof name !== 'string' || !CONTAINER.test(name)) || new Set(options.containers).size !== options.containers.length) throw new Error('Select 1 to 64 distinct Docker container names or IDs');
  const maxBytes = options.maxBytes ?? DEFAULT_INSTANCE_VAULT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Capture maxBytes must be a positive safe integer');
  const storage = path.resolve(options.storage);
  noLinks(storage);
  const docker = deps.runDocker ?? runDocker;
  const archive = deps.runDockerArchive ?? runDockerArchive;
  const initial: ContainerInspect[] = [];
  for (const name of options.containers) initial.push(inspectResult(await docker(['inspect', '--type', 'container', name])));
  if (new Set(initial.map(container => container.Id)).size !== initial.length) throw new Error('Container aliases must not select the same deployment service twice');
  rootCoverage(initial);
  const parent = path.dirname(storage);
  for (const container of initial) for (const mount of container.Mounts) {
    if (mount.Type === 'tmpfs' || typeof mount.Source !== 'string') continue;
    // Native absolute host paths can be checked locally. Linux daemon paths
    // reported to a Windows client are not paths on this machine.
    const native = process.platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(mount.Source) : path.isAbsolute(mount.Source);
    if (native) {
      const source = path.resolve(mount.Source);
      if (inside(source, storage) || inside(storage, source) || inside(source, parent)) throw new Error('Vault storage and staging must be outside captured persistent mount sources');
    }
  }
  const running = initial.filter(container => container.State.Running);
  if (running.length && options.allowStop !== true) throw new Error('Capture requires explicit allowStop permission to stop running containers');
  const vault = new InstanceVault(storage, { maxBytes });
  vault.initialize();
  noLinks(parent);
  const stage = fs.mkdtempSync(path.join(parent, '.instance-capture-'));
  const notes = ['Only explicitly selected containers are captured. External databases, object stores, DNS and other external services are not included.', 'Each container rootfs archive preserves its merged base and writable filesystem. Docker export excludes mounted volume contents; those are captured separately under volumes/.', 'Persistent mount TAR archives retain Docker archive ownership, modes and link metadata without extraction. Restore materializes these archives only; host-side volume restoration must apply their metadata. ACLs and extended attributes depend on Docker archive support.'];
  const secrets = initial.flatMap(container => (container.Config.Env ?? []).filter(value => /(?:TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|AUTHORIZATION)=/i.test(value)).map(value => value.slice(value.indexOf('=') + 1)).filter(value => value.length >= 4));
  const safeError = (error: unknown) => secrets.reduce((message, secret) => message.split(secret).join('[redacted]'), error instanceof Error ? error.message : String(error));
  let snapshot: Snapshot | undefined;
  let failure: string | undefined;
  const restartFailed: string[] = [];
  try {
    fs.chmodSync(stage, 0o700);
    fs.mkdirSync(path.join(stage, 'images'), { mode: 0o700 });
    fs.mkdirSync(path.join(stage, 'containers'), { mode: 0o700 });
    fs.mkdirSync(path.join(stage, 'volumes'), { mode: 0o700 });
    for (const container of running) await docker(['stop', '--time', '60', container.Id]);
    const stopped: ContainerInspect[] = [];
    for (const container of initial) {
      const current = inspectResult(await docker(['inspect', '--type', 'container', container.Id]));
      if (current.Id !== container.Id || current.Image !== container.Image || current.State.Running) throw new Error('A selected container did not remain stopped for capture');
      if (container.State.Running && (current.State.ExitCode === 137 || current.State.OOMKilled || current.State.Error)) throw new Error('A running container did not stop gracefully; capture was refused');
      stopped.push(current);
    }
    const images: { id: string; file: string }[] = [];
    for (const id of new Set(initial.map(container => container.Image))) {
      const filename = `images/${id.slice('sha256:'.length)}.tar`;
      await docker(['image', 'save', '--output', path.join(stage, ...filename.split('/')), id]);
      const output = path.join(stage, ...filename.split('/'));
      if (!fs.lstatSync(output).isFile() || fs.lstatSync(output).isSymbolicLink() || fs.lstatSync(output).size === 0) throw new Error('Docker did not produce a regular saved image archive');
      if (treeBytes(stage) > maxBytes) throw new Error('The deployment exceeds the capture size limit');
      images.push({ id, file: filename });
    }
    const rootfs: { containerId: string; file: string }[] = [];
    for (const container of initial) {
      const filename = `containers/${container.Id}.tar`;
      const output = path.join(stage, ...filename.split('/'));
      await docker(['export', '--output', output, container.Id]);
      const stat = fs.lstatSync(output);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error('Docker did not produce a regular container filesystem archive');
      if (treeBytes(stage) > maxBytes) throw new Error('The deployment exceeds the capture size limit');
      rootfs.push({ containerId: container.Id, file: filename });
    }
    const mounts: { containerId: string; mount: DockerMount; file: string; kind: 'archive' }[] = [];
    for (const container of initial) for (let index = 0; index < container.Mounts.length; index++) {
      const mount = container.Mounts[index];
      if (mount.Type === 'tmpfs') { notes.push(`Excluded nonpersistent tmpfs mount ${container.Id}:${mount.Destination}`); continue; }
      const filename = `volumes/${container.Id}-${index}.tar`;
      const output = path.join(stage, ...filename.split('/'));
      await archive(['cp', `${container.Id}:${containerPath(mount.Destination)}`, '-'], output);
      const stat = fs.lstatSync(output);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error('Docker did not produce a regular persistent mount archive');
      if (treeBytes(stage) > maxBytes) throw new Error('The deployment exceeds the capture size limit');
      mounts.push({ containerId: container.Id, mount, file: filename, kind: 'archive' });
    }
    for (const container of initial) {
      const current = inspectResult(await docker(['inspect', '--type', 'container', container.Id]));
      if (current.Id !== container.Id || current.Image !== container.Image || current.State.Running) throw new Error('A selected container restarted while its persistent data was being copied');
    }
    const metadata = { version: 1, createdAt: Date.now(), consistency: 'stopped-containers', containers: initial, stoppedContainers: stopped, images, rootfs, mounts, notes };
    fs.writeFileSync(path.join(stage, 'deployment.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (treeBytes(stage) > maxBytes) throw new Error('The deployment exceeds the capture size limit');
    snapshot = await vault.capture(stage, { source: options.containers.join(','), services: options.containers.slice(), consistency: 'stopped-containers', coverage: { data: true, runtime: true, configuration: true } });
  } catch (error) { failure = safeError(error); }
  finally {
    for (const container of running.slice().reverse()) {
      try {
        await docker(['start', container.Id]);
        const restored = inspectResult(await docker(['inspect', '--type', 'container', container.Id]));
        if (restored.Id !== container.Id || !restored.State.Running) throw new Error('The container did not remain running after restart');
      } catch { restartFailed.push(container.Id); }
    }
    try {
      const checked = path.resolve(stage);
      noLinks(parent);
      const stat = fs.lstatSync(checked);
      if (path.dirname(checked) !== parent || !path.basename(checked).startsWith('.instance-capture-') || stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe capture staging cleanup path');
      fs.rmSync(checked, { recursive: true, force: true });
    } catch (error) { failure = [failure, safeError(error)].filter(Boolean).join('; '); }
  }
  if (restartFailed.length) throw new Error(`${failure ?? (snapshot ? `Capture ${snapshot.id} was saved` : 'Capture failed')}; could not restart originally running containers: ${restartFailed.join(', ')}`);
  if (failure) throw new Error(failure);
  if (!snapshot) throw new Error('The deployment capture did not produce a snapshot');
  return snapshot;
}

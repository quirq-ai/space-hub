import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureDeployment } from '../src/instancecapture.ts';
import { InstanceVault } from '../src/instancevault.ts';

const MAIN = 'a'.repeat(64), TLS = 'b'.repeat(64), STOPPED = 'c'.repeat(64);
const MAIN_IMAGE = 'sha256:' + '1'.repeat(64), TLS_IMAGE = 'sha256:' + '2'.repeat(64);
const PRIVATE_KEY = 'private-hub-signing-key';
const OAUTH = 'oauth-secret-kept-private';
const SERVICES = ['main', 'tls', 'stopped'];

interface TarEntry { name: string; mode?: number; uid?: number; gid?: number; type?: string; link?: string; bytes?: Buffer }
function tar(entries: TarEntry[]) {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512), bytes = entry.bytes ?? Buffer.alloc(0);
    const octal = (value: number, offset: number, length: number) => header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
    header.write(entry.name, 0, 100, 'utf8');
    octal(entry.mode ?? 0o640, 100, 8); octal(entry.uid ?? 0, 108, 8); octal(entry.gid ?? 0, 116, 8);
    octal(bytes.length, 124, 12); octal(1_700_000_000, 136, 12);
    header.fill(0x20, 148, 156); header.write(entry.type ?? '0', 156, 1, 'ascii');
    header.write(entry.link ?? '', 157, 100, 'utf8'); header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
function tarEntries(bytes: Buffer) {
  const entries: (TarEntry & { mode: number; uid: number; gid: number; type: string; link: string; bytes: Buffer })[] = [];
  const string = (header: Buffer, at: number, length: number) => header.subarray(at, at + length).toString('utf8').replace(/\0.*$/s, '');
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break;
    const size = parseInt(string(header, 124, 12), 8);
    entries.push({ name: string(header, 0, 100), mode: parseInt(string(header, 100, 8), 8), uid: parseInt(string(header, 108, 8), 8), gid: parseInt(string(header, 116, 8), 8), type: string(header, 156, 1), link: string(header, 157, 100), bytes: bytes.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'instance-capture-'));
  t.after(() => {
    const checked = path.resolve(root);
    if (path.dirname(checked) !== path.resolve(fs.realpathSync(os.tmpdir())) || !path.basename(checked).startsWith('instance-capture-')) throw new Error('Unsafe capture-test cleanup path');
    fs.rmSync(checked, { recursive: true, force: true });
  });
  const hubData = path.join(root, 'input-hub');
  const tlsData = path.join(root, 'input-tls');
  const configFile = path.join(root, 'Caddyfile');
  fs.mkdirSync(path.join(hubData, 'keys'), { recursive: true });
  fs.mkdirSync(path.join(hubData, 'databases', 'private'), { recursive: true });
  fs.mkdirSync(path.join(tlsData, 'certificates'), { recursive: true });
  fs.writeFileSync(path.join(hubData, 'keys', 'signing.pem'), PRIVATE_KEY);
  fs.writeFileSync(path.join(hubData, 'databases', 'private', 'accounts.json'), JSON.stringify({ token: 'private-agent-token', permissions: ['all-orgs'] }));
  fs.writeFileSync(path.join(tlsData, 'certificates', 'private.key'), 'tls-private-key');
  fs.writeFileSync(configFile, 'hub.example { reverse_proxy main:3000 }');
  const binary = Buffer.from([0, 255, 254, 128, 10, 13, 0, 240, 159]);
  const archives = new Map([
    [hubData, tar([
      { name: 'data/', type: '5', mode: 0o2750, uid: 1000, gid: 1001 },
      { name: 'data/keys/signing.pem', mode: 0o600, uid: 1002, gid: 1003, bytes: Buffer.from(PRIVATE_KEY) },
      { name: 'data/databases/private/accounts.json', bytes: fs.readFileSync(path.join(hubData, 'databases', 'private', 'accounts.json')) },
      { name: 'data/binary', mode: 0o4750, uid: 1234, gid: 2345, bytes: binary },
      { name: 'data/key-link', type: '2', link: 'keys/signing.pem', mode: 0o777, uid: 1002, gid: 1003 },
      { name: 'data/key-hardlink', type: '1', link: 'data/keys/signing.pem', mode: 0o600, uid: 1002, gid: 1003 },
      { name: 'data/worker-fifo', type: '6', mode: 0o620, uid: 1000, gid: 1001 },
    ])],
    [tlsData, tar([{ name: 'data/certificates/private.key', mode: 0o600, uid: 1000, gid: 1000, bytes: Buffer.from('tls-private-key') }])],
    [configFile, tar([{ name: 'Caddyfile', bytes: fs.readFileSync(configFile) }])],
  ]);
  const containers = new Map<string, any>([
    [MAIN, { Id: MAIN, Name: '/main', Image: MAIN_IMAGE, Config: { Env: ['SPACETIME_ROOT=/data', 'SPACEHUB_DB=spacehub', `SPACEHUB_GITHUB_CLIENT_SECRET=${OAUTH}`, 'SPACEHUB_XO_KEY=private-xo-key'], Entrypoint: ['spacehub-server'], Labels: { 'com.docker.compose.service': 'spacehub' } }, State: { Running: true, ExitCode: 0 }, HostConfig: { RestartPolicy: { Name: 'unless-stopped' } }, Mounts: [{ Type: 'volume', Name: 'private-hub-data', Source: hubData, Destination: '/data', RW: true }, { Type: 'tmpfs', Source: '', Destination: '/tmp' }] }],
    [TLS, { Id: TLS, Name: '/tls', Image: TLS_IMAGE, Config: { Env: ['TLS_SECRET=certificate-account-secret'], Entrypoint: ['caddy'] }, State: { Running: true, ExitCode: 0 }, Mounts: [{ Type: 'volume', Name: 'tls-state', Source: tlsData, Destination: '/data', RW: true }, { Type: 'bind', Source: configFile, Destination: '/etc/caddy/Caddyfile', RW: false }] }],
    [STOPPED, { Id: STOPPED, Name: '/stopped', Image: MAIN_IMAGE, Config: { Env: ['WORKER_KEY=private-worker-key'], Entrypoint: ['worker'] }, State: { Running: false, ExitCode: 137 }, Mounts: [] }],
  ]);
  const aliases = new Map([['main', MAIN], ['tls', TLS], ['stopped', STOPPED]]);
  const calls: string[][] = [];
  let failCopy = false;
  let hardStop = false;
  let restartDuringCopy = false;
  let symlinkArchive = false;
  let imageBytes = 128;
  let exportBytes = 0;
  let failExport = false;
  let failStart: string | undefined;
  const docker = async (args: string[]) => {
    calls.push(args.slice());
    if (args[0] === 'inspect') return JSON.stringify([containers.get(aliases.get(args[3]) ?? args[3])]);
    if (args[0] === 'stop') { const item = containers.get(args[3]); item.State.Running = false; item.State.ExitCode = hardStop ? 137 : 0; return args[3]; }
    if (args[0] === 'start') {
      if (args[1] === failStart) throw new Error('start failed');
      containers.get(args[1]).State.Running = true; return args[1];
    }
    if (args[0] === 'image' || !restartDuringCopy) assert.ok([...containers.values()].every(item => !item.State.Running), 'capture commands ran while a selected container was running');
    if (args[0] === 'image' && args[1] === 'save') { fs.writeFileSync(args[3], Buffer.alloc(imageBytes, args[4] === MAIN_IMAGE ? 1 : 2)); return ''; }
    if (args[0] === 'export') {
      if (failExport) throw new Error('container filesystem export failed');
      const content = JSON.stringify({ containerId: args[3], files: args[3] === MAIN ? { '/opt/custom/start.sh': 'echo private custom startup', '/etc/private-config.json': '{"apiKey":"writable-layer-private-key"}' } : { '/etc/service-overrides.conf': 'custom-service-state' } });
      fs.writeFileSync(args[2], exportBytes ? Buffer.alloc(exportBytes, 3) : content);
      return '';
    }
    throw new Error('Unexpected Docker command');
  };
  const dockerArchive = async (args: string[], output: string) => {
    calls.push(args.slice());
    assert.equal(args[0], 'cp'); assert.equal(args[2], '-'); assert.equal(args.length, 3);
    if (!restartDuringCopy) assert.ok([...containers.values()].every(item => !item.State.Running), 'mount capture ran before all selected containers stopped');
    if (failCopy) throw new Error(`copy failed ${OAUTH}`);
    const split = args[1].indexOf(':');
    const container = containers.get(args[1].slice(0, split));
    const mount = container.Mounts.find((item: any) => item.Destination === args[1].slice(split + 1));
    assert.ok(mount && mount.Type !== 'tmpfs');
    if (symlinkArchive) fs.symlinkSync(hubData, output, process.platform === 'win32' ? 'junction' : 'dir');
    else fs.writeFileSync(output, archives.get(mount.Source)!, { flag: 'wx', mode: 0o600 });
    if (restartDuringCopy) containers.get(MAIN).State.Running = true;
  };
  const storage = path.join(root, 'vault');
  const capture = (extra: Partial<Parameters<typeof captureDeployment>[0]> = {}) => captureDeployment({ containers: SERVICES, storage, allowStop: true, ...extra }, { runDocker: docker, runDockerArchive: dockerArchive });
  const noStages = () => assert.equal(fs.readdirSync(root).some(name => name.startsWith('.instance-capture-')), false);
  return { root, storage, hubData, tlsData, configFile, archives, binary, containers, calls, capture, docker, noStages,
    setFailCopy: () => { failCopy = true; }, setHardStop: () => { hardStop = true; }, setRestartDuringCopy: () => { restartDuringCopy = true; }, setSymlinkArchive: () => { symlinkArchive = true; },
    setImageBytes: (value: number) => { imageBytes = value; }, setExportBytes: (value: number) => { exportBytes = value; }, setFailExport: () => { failExport = true; }, setFailStart: (id: string) => { failStart = id; } };
}

test('cold capture preserves complete private data, all service configuration, TLS state and exact deduplicated images', async t => {
  const f = fixture(t);
  const snapshot = await f.capture();
  assert.equal(snapshot.scope, 'instance');
  assert.equal(snapshot.consistency, 'stopped-containers');
  assert.deepEqual(snapshot.coverage, { data: true, runtime: true, configuration: true });
  assert.deepEqual(snapshot.services.slice().sort(), SERVICES.slice().sort());
  assert.ok(!JSON.stringify(snapshot).includes(OAUTH));
  assert.ok(!JSON.stringify(snapshot).includes(PRIVATE_KEY));
  assert.equal(f.calls.filter(args => args[0] === 'image').length, 2);
  assert.deepEqual(f.calls.filter(args => args[0] === 'image').map(args => args[4]).sort(), [MAIN_IMAGE, TLS_IMAGE]);
  assert.equal(f.calls.filter(args => args[0] === 'cp').length, 3);
  assert.deepEqual(f.calls.filter(args => args[0] === 'export').map(args => args[3]).sort(), [MAIN, TLS, STOPPED]);
  assert.ok(f.calls.every(args => !['run', 'exec', 'rm', 'kill'].includes(args[0])));
  assert.deepEqual(f.calls.filter(args => args[0] === 'stop').map(args => args.slice(1)), [['--time', '60', MAIN], ['--time', '60', TLS]]);
  assert.deepEqual(f.calls.filter(args => args[0] === 'start').map(args => args[1]).sort(), [MAIN, TLS]);
  assert.equal(f.containers.get(STOPPED).State.Running, false);
  const vault = new InstanceVault(f.storage);
  const restored = path.join(f.root, 'restored');
  await vault.restore(snapshot.id, restored);
  const deployment = JSON.parse(fs.readFileSync(path.join(restored, 'deployment.json'), 'utf8'));
  assert.ok(deployment.containers[0].Config.Env.includes(`SPACEHUB_GITHUB_CLIENT_SECRET=${OAUTH}`));
  assert.deepEqual(deployment.containers[0].HostConfig.RestartPolicy, { Name: 'unless-stopped' });
  const rootfs = deployment.rootfs.find((item: any) => item.containerId === MAIN);
  const savedRootfs = JSON.parse(fs.readFileSync(path.join(restored, rootfs.file), 'utf8'));
  assert.equal(savedRootfs.files['/opt/custom/start.sh'], 'echo private custom startup');
  assert.equal(JSON.parse(savedRootfs.files['/etc/private-config.json']).apiKey, 'writable-layer-private-key');
  assert.ok(!JSON.stringify(snapshot).includes('writable-layer-private-key'));
  const hub = deployment.mounts.find((mount: any) => mount.containerId === MAIN);
  assert.equal(hub.kind, 'archive');
  assert.match(hub.file, /^volumes\/[a-f0-9]{64}-0\.tar$/);
  const hubArchive = fs.readFileSync(path.join(restored, hub.file));
  assert.deepEqual(hubArchive, f.archives.get(f.hubData));
  const entries = tarEntries(hubArchive);
  assert.equal(entries.find(entry => entry.name === 'data/keys/signing.pem')!.bytes.toString('utf8'), PRIVATE_KEY);
  assert.equal(JSON.parse(entries.find(entry => entry.name === 'data/databases/private/accounts.json')!.bytes.toString('utf8')).token, 'private-agent-token');
  const tls = deployment.mounts.find((mount: any) => mount.containerId === TLS && mount.mount.Destination === '/data');
  assert.deepEqual(fs.readFileSync(path.join(restored, tls.file)), f.archives.get(f.tlsData));
  const bind = deployment.mounts.find((mount: any) => mount.mount.Destination === '/etc/caddy/Caddyfile');
  assert.equal(bind.kind, 'archive');
  assert.deepEqual(fs.readFileSync(path.join(restored, bind.file)), f.archives.get(f.configFile));
  assert.ok(deployment.notes.some((note: string) => note.includes('tmpfs')));
  assert.ok(deployment.notes.some((note: string) => note.includes('External databases')));
  assert.ok(deployment.notes.some((note: string) => note.includes('mounted volume contents')));
  assert.equal(deployment.notes.some((note: string) => note.includes('writable layers outside persistent mounts are not included')), false);
  f.noStages();
});

test('mount archives preserve binary bytes, ownership, special modes and links without extracting on the capture host', async t => {
  const f = fixture(t);
  // Shell punctuation is a literal container path argument, never a command.
  f.containers.get(TLS).Mounts[1].Destination = '/etc/caddy/config with spaces;$(never-run)';
  const snapshot = await f.capture();
  const restored = path.join(f.root, 'metadata-restored');
  await new InstanceVault(f.storage).restore(snapshot.id, restored);
  const deployment = JSON.parse(fs.readFileSync(path.join(restored, 'deployment.json'), 'utf8'));
  const mount = deployment.mounts.find((item: any) => item.containerId === MAIN);
  const bytes = fs.readFileSync(path.join(restored, mount.file));
  assert.deepEqual(bytes, f.archives.get(f.hubData));
  const entries = tarEntries(bytes);
  assert.deepEqual(entries.find(entry => entry.name === 'data/')!, { name: 'data/', mode: 0o2750, uid: 1000, gid: 1001, type: '5', link: '', bytes: Buffer.alloc(0) });
  const binary = entries.find(entry => entry.name === 'data/binary')!;
  assert.deepEqual(binary.bytes, f.binary);
  assert.equal(binary.mode, 0o4750); assert.equal(binary.uid, 1234); assert.equal(binary.gid, 2345);
  assert.equal(entries.find(entry => entry.name === 'data/key-link')!.type, '2');
  assert.equal(entries.find(entry => entry.name === 'data/key-link')!.link, 'keys/signing.pem');
  assert.equal(entries.find(entry => entry.name === 'data/key-hardlink')!.type, '1');
  assert.equal(entries.find(entry => entry.name === 'data/worker-fifo')!.type, '6');
  assert.ok(fs.readdirSync(path.join(restored, 'volumes')).every(name => name.endsWith('.tar')));
  assert.equal(fs.existsSync(path.join(restored, 'volumes', 'data')), false);
  assert.ok(f.calls.some(args => args[0] === 'cp' && args[1] === `${TLS}:/etc/caddy/config with spaces;$(never-run)` && args[2] === '-'));
  f.noStages();
});

test('empty or oversized mount archive output fails closed and restarts originally running services', async t => {
  const empty = fixture(t); empty.archives.set(empty.hubData, Buffer.alloc(0));
  await assert.rejects(empty.capture(), /regular persistent mount archive/);
  assert.deepEqual(new InstanceVault(empty.storage).list(), []);
  assert.equal(empty.containers.get(MAIN).State.Running, true);
  assert.equal(empty.containers.get(TLS).State.Running, true);
  empty.noStages();
  const oversized = fixture(t); oversized.archives.set(oversized.hubData, Buffer.alloc(32 * 1024));
  await assert.rejects(oversized.capture({ maxBytes: 16 * 1024 }), /size limit|quota/);
  assert.deepEqual(new InstanceVault(oversized.storage).list(), []);
  assert.equal(oversized.containers.get(MAIN).State.Running, true);
  assert.equal(oversized.containers.get(TLS).State.Running, true);
  oversized.noStages();
});

test('running containers are never stopped or copied without explicit permission', async t => {
  const f = fixture(t);
  await assert.rejects(f.capture({ allowStop: false }), /explicit allowStop/);
  assert.ok(f.calls.every(args => args[0] === 'inspect'));
  assert.equal(fs.existsSync(f.storage), false);
  assert.equal(f.containers.get(MAIN).State.Running, true);
  f.noStages();
});

test('copy failures restore original running state, redact secrets and publish no partial snapshot', async t => {
  const f = fixture(t); f.setFailCopy();
  await assert.rejects(f.capture(), error => error instanceof Error && /copy failed/.test(error.message) && !error.message.includes(OAUTH));
  assert.equal(f.containers.get(MAIN).State.Running, true);
  assert.equal(f.containers.get(TLS).State.Running, true);
  assert.equal(f.containers.get(STOPPED).State.Running, false);
  assert.deepEqual(new InstanceVault(f.storage).list(), []);
  assert.equal(fs.readFileSync(path.join(f.hubData, 'keys', 'signing.pem'), 'utf8'), PRIVATE_KEY);
  f.noStages();
});

test('a forced stop is refused and originally running containers are restarted', async t => {
  const f = fixture(t); f.setHardStop();
  await assert.rejects(f.capture(), /did not stop gracefully/);
  assert.equal(f.calls.some(args => args[0] === 'image' || args[0] === 'cp'), false);
  assert.equal(f.containers.get(MAIN).State.Running, true);
  assert.equal(f.containers.get(TLS).State.Running, true);
  assert.deepEqual(new InstanceVault(f.storage).list(), []);
  f.noStages();
});

test('already stopped deployments can be captured without permission and remain stopped', async t => {
  const f = fixture(t);
  for (const container of f.containers.values()) container.State.Running = false;
  await f.capture({ allowStop: false });
  assert.equal(f.calls.some(args => args[0] === 'stop' || args[0] === 'start'), false);
  assert.ok([...f.containers.values()].every(container => !container.State.Running));
});

test('restarted containers during copying prevent publication of a cold-consistent snapshot', async t => {
  const f = fixture(t); f.setRestartDuringCopy();
  await assert.rejects(f.capture(), /restarted while its persistent data was being copied/);
  assert.deepEqual(new InstanceVault(f.storage).list(), []);
  assert.equal(f.containers.get(MAIN).State.Running, true);
  assert.equal(f.containers.get(TLS).State.Running, true);
  f.noStages();
});

test('unsafe vault overlap, unsupported mount types and missing hub-root coverage fail before stopping anything', async t => {
  const overlap = fixture(t);
  await assert.rejects(overlap.capture({ storage: path.join(overlap.hubData, 'vault') }), /outside captured persistent/);
  assert.equal(fs.existsSync(path.join(overlap.hubData, 'vault')), false);
  assert.ok(overlap.calls.every(args => args[0] === 'inspect'));
  const unsupported = fixture(t);
  unsupported.containers.get(MAIN).Mounts[0].Type = 'npipe';
  await assert.rejects(unsupported.capture(), /unsupported mount type/);
  assert.ok(unsupported.calls.every(args => args[0] === 'inspect'));
  const missing = fixture(t);
  missing.containers.get(MAIN).Mounts = [];
  await assert.rejects(missing.capture(), /hub data root/);
  assert.ok(missing.calls.every(args => args[0] === 'inspect'));
  // The proxy's /data mount cannot stand in for a missing hub database mount.
  await assert.rejects(missing.capture({ containers: ['tls'] }), /Select a hub container/);
});

test('symlinked archive output and oversized exports are rejected without following links or losing source data', async t => {
  const links = fixture(t); links.setSymlinkArchive();
  await assert.rejects(links.capture(), /regular persistent mount archive|symlinks/);
  assert.equal(fs.readFileSync(path.join(links.hubData, 'keys', 'signing.pem'), 'utf8'), PRIVATE_KEY);
  assert.deepEqual(new InstanceVault(links.storage).list(), []);
  links.noStages();
  const large = fixture(t); large.setImageBytes(32 * 1024);
  await assert.rejects(large.capture({ maxBytes: 16 * 1024 }), /size limit|quota/);
  assert.equal(large.containers.get(MAIN).State.Running, true);
  assert.equal(large.containers.get(TLS).State.Running, true);
  assert.deepEqual(new InstanceVault(large.storage).list(), []);
  large.noStages();
});

test('a restart failure reports the preserved snapshot while attempting to restart every original running service', async t => {
  const f = fixture(t); f.setFailStart(TLS);
  await assert.rejects(f.capture(), /Capture [a-f0-9]{32} was saved; could not restart/);
  assert.equal(new InstanceVault(f.storage).list().length, 1);
  assert.equal(f.containers.get(MAIN).State.Running, true);
  assert.equal(f.containers.get(STOPPED).State.Running, false);
  assert.deepEqual(f.calls.filter(args => args[0] === 'start').map(args => args[1]), [TLS, MAIN]);
  f.noStages();
});

test('failed or oversized rootfs exports prevent publication and restart the deployment', async t => {
  const failed = fixture(t); failed.setFailExport();
  await assert.rejects(failed.capture(), /filesystem export failed/);
  assert.equal(failed.containers.get(MAIN).State.Running, true);
  assert.equal(failed.containers.get(TLS).State.Running, true);
  assert.equal(failed.calls.some(args => args[0] === 'cp'), false);
  assert.deepEqual(new InstanceVault(failed.storage).list(), []);
  failed.noStages();
  const oversized = fixture(t); oversized.setExportBytes(32 * 1024);
  await assert.rejects(oversized.capture({ maxBytes: 16 * 1024 }), /size limit|quota/);
  assert.equal(oversized.containers.get(MAIN).State.Running, true);
  assert.equal(oversized.containers.get(TLS).State.Running, true);
  assert.deepEqual(new InstanceVault(oversized.storage).list(), []);
  oversized.noStages();
});

// Where spacehub lives and who you are there. Stored in ~/.spacehub/config.json
// (override the folder with SPACEHUB_HOME). Tokens are kept per server because
// each SpacetimeDB server issues its own identities.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Config {
  server: string;
  database: string;
  token?: string;
}

interface ConfigFile {
  server?: string;
  database?: string;
  tokens?: Record<string, string>;
}

export const DEFAULT_SERVER = 'ws://127.0.0.1:3000';
export const DEFAULT_DATABASE = 'spacehub';

function home() {
  return process.env.SPACEHUB_HOME ?? path.join(os.homedir(), '.spacehub');
}

export function configFile() {
  return path.join(home(), 'config.json');
}

function readFile(): ConfigFile {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeFile(data: ConfigFile) {
  fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configFile(), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

// http(s) URLs are accepted for convenience; the SDK speaks websockets.
export function normalizeServer(url: string) {
  return url.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/+$/, '');
}

export function loadConfig(): Config {
  const data = readFile();
  const server = normalizeServer(process.env.SPACEHUB_SERVER ?? data.server ?? DEFAULT_SERVER);
  return {
    server,
    database: process.env.SPACEHUB_DB ?? data.database ?? DEFAULT_DATABASE,
    token: process.env.SPACEHUB_TOKEN ?? data.tokens?.[server],
  };
}

export function saveSettings(settings: { server?: string; database?: string }) {
  const data = readFile();
  if (settings.server) data.server = normalizeServer(settings.server);
  if (settings.database) data.database = settings.database;
  writeFile(data);
}

export function saveToken(server: string, token: string) {
  const data = readFile();
  data.tokens = { ...data.tokens, [server]: token };
  writeFile(data);
}

export function removeToken(server: string) {
  const data = readFile();
  if (data.tokens) delete data.tokens[server];
  writeFile(data);
}

// A builder's grouping key from a display name or a GitHub profile URL.
export function builderFrom(input: string): { handle: string; name: string; url: string } {
  const gh = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/?$/.exec(input.trim());
  if (gh) return { handle: gh[1].toLowerCase(), name: gh[1], url: `https://github.com/${gh[1]}` };
  const name = input.trim();
  const handle = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|-+$/g, '').slice(0, 100);
  return { handle, name, url: '' };
}

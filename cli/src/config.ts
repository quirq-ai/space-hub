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

export const DEFAULT_SERVER = 'wss://hub.quirq.dev';
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

// `server` (from a remote's quirq URL) wins over the configured one. A URL
// can name any host, so SPACEHUB_TOKEN goes only to the configured server;
// another host gets only the token saved for it.
export function loadConfig(server?: string): Config {
  const data = readFile();
  const configured = normalizeServer(process.env.SPACEHUB_SERVER ?? data.server ?? DEFAULT_SERVER);
  const target = server ? normalizeServer(server) : configured;
  const envToken = target === configured ? process.env.SPACEHUB_TOKEN : undefined;
  return {
    server: target,
    database: process.env.SPACEHUB_DB ?? data.database ?? DEFAULT_DATABASE,
    token: envToken ?? data.tokens?.[target],
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

// A GitHub login from "anthropics", "@anthropics" or a github.com profile URL.
export function githubLogin(input: string): string | null {
  const s = input.trim().replace(/\/+$/, '');
  const m =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})$/.exec(s) ??
    /^@?([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})$/.exec(s);
  return m ? m[1] : null;
}

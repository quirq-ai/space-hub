import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Exercise the actual shell components without browser effects or production data.
const appDirectory = fileURLToPath(new URL("..", import.meta.url));
const built = await build({ absWorkingDir: appDirectory, stdin: { contents: 'export { TopBar, Sidebar } from "./src/shell/shell"; export { SettingsPage } from "./src/pages/settings"; export { SubhubConnectionCard, RemoteBackupCatalog } from "./src/pages/instance-recovery";', resolveDir: appDirectory, loader: "tsx" }, bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/jsx-runtime", "react-dom", "react-dom/server"], logLevel: "silent" });
const compiled: { exports: Record<string, ComponentType<any>> } = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const { TopBar, Sidebar, SettingsPage, SubhubConnectionCard, RemoteBackupCatalog } = compiled.exports;
const nothing = () => {};

test("standalone recovery shell offers its own home without hub search or sign-in", () => {
  const props = { me: { checked: true, name: null }, signIn: "/-/login", live: "live", onSearch: nothing, onMenu: nothing };
  const standalone = renderToStaticMarkup(createElement(TopBar, { ...props, recoveryOnly: true }));
  assert.match(standalone, /href="\/#\/settings"/);
  assert.match(standalone, /Local recovery/);
  assert.doesNotMatch(standalone, /Sign in|Search spaces|\/-\/login/);
  const normal = renderToStaticMarkup(createElement(TopBar, props));
  assert.match(normal, /Search spaces/);
  assert.match(normal, /Sign in/);
});

test("Settings sits below Guide, while standalone recovery hides nonfunctional hub links", () => {
  const props = {
    switcher: { current: null, options: [] }, primary: [],
    sections: [{ key: "recent", title: "Recent", limit: 4, items: [{ key: "project", label: "org/project", href: "/org/project", icon: null }] }],
    footer: [{ key: "guide", label: "Guide", href: "/-/guide", icon: null }, { key: "settings", label: "Settings", href: "/#/settings", icon: null, active: true }, { key: "builders", label: "Builders", href: "/-/builders", icon: null }], open: false, onClose: nothing, rail: false, onRail: nothing, onSearch: nothing,
  };
  const standalone = renderToStaticMarkup(createElement(Sidebar, { ...props, recoveryOnly: true }));
  assert.match(standalone, /Settings/);
  assert.doesNotMatch(standalone, /All spaces|Search|Recent|org\/project|Guide|Builders|Sub-hubs/);
  const normal = renderToStaticMarkup(createElement(Sidebar, props));
  assert.match(normal, /All spaces/);
  assert.match(normal, /Search/);
  assert.match(normal, /org\/project/);
  assert.match(normal, /Guide/);
  assert.ok(normal.indexOf(">Guide<") < normal.indexOf(">Settings<"));
  assert.ok(normal.indexOf(">Settings<") < normal.indexOf(">Builders<"));
});

test("Settings embeds full-instance Sub-hubs as a section with the three recovery views", () => {
  const markup = renderToStaticMarkup(createElement(SettingsPage));
  assert.match(markup, /<h1>Settings<\/h1>/);
  assert.match(markup, /<h2>[\s\S]*?Sub-hubs<\/h2>/);
  assert.match(markup, /Automatic backups of this entire Spacehub instance/);
  assert.match(markup, /spacehub subhub run --storage &lt;folder&gt;/);
  for (const label of ["Overview", "Backups", "Restore"]) assert.match(markup, new RegExp(`>${label}<`));
  assert.doesNotMatch(markup, /Work queue|Sessions|Active drive|Docker|containers|allow-stop|Back up instance/);
});

test("reported connections display heartbeat and source backup time while remote copies have no local restore action", () => {
  const snapshot = { id: "ab".repeat(16), createdAt: 1_700_000_000_000, source: "hub.example", bytes: 1024, files: 4 };
  const connection = { id: "backup-laptop", name: "Backup laptop", connectedAt: 1_700_000_100_000, lastSeen: 1_700_000_200_000, online: true, state: "waiting", snapshots: [snapshot] };
  const card = renderToStaticMarkup(createElement(SubhubConnectionCard, { connection }));
  assert.match(card, /Waiting for source/);
  assert.ok(card.includes(new Date(snapshot.createdAt).toISOString()));
  assert.ok(card.includes(new Date(connection.lastSeen).toISOString()));
  assert.match(card, /hub.example/);
  assert.match(card, /1.0 KB/);
  const remote = renderToStaticMarkup(createElement(RemoteBackupCatalog, { connection }));
  assert.match(remote, /Restore on Backup laptop/);
  assert.match(remote, /--storage &lt;folder&gt;/);
  assert.doesNotMatch(remote, /<form|<button[^>]*>Restore|\/restore/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Exercise the actual shell components without browser effects or production data.
const appDirectory = fileURLToPath(new URL("..", import.meta.url));
const built = await build({ absWorkingDir: appDirectory, stdin: { contents: 'export { Dock, InsetHeader, Sidebar } from "./src/shell/shell"; export { SettingsPage } from "./src/pages/settings"; export { SubhubConnectionCard, RemoteBackupCatalog } from "./src/pages/instance-recovery";', resolveDir: appDirectory, loader: "tsx" }, bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/jsx-runtime", "react-dom", "react-dom/server"], logLevel: "silent" });
const compiled: { exports: Record<string, ComponentType<any>> } = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const { Dock, InsetHeader, Sidebar, SettingsPage, SubhubConnectionCard, RemoteBackupCatalog } = compiled.exports;
const nothing = () => {};

test("the page header replaces the top bar: sidebar trigger, where you are, live state and Activity", () => {
  const props = { crumbs: createElement("span", null, "quirq / quirq"), live: "live", rail: false, onToggleSidebar: nothing };
  const header = renderToStaticMarkup(createElement(InsetHeader, { ...props, activity: { open: false, onToggle: nothing } }));
  assert.match(header, /Toggle the sidebar/);
  assert.match(header, /quirq \/ quirq/);
  assert.match(header, /Live/);
  assert.match(header, /aria-label="Activity"/);
  assert.doesNotMatch(header, /Search spaces|Sign in/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(InsetHeader, props)), /aria-label="Activity"/);
});

test("standalone recovery offers its own home and no hub search or sign-in; the account is the dock's last entry", () => {
  const props = { primary: [], sections: [], footer: [], open: false, onClose: nothing, rail: false, onRail: nothing, onSearch: nothing };
  const standalone = renderToStaticMarkup(createElement(Sidebar, { ...props, recoveryOnly: true }));
  assert.match(standalone, /href="\/#\/settings"/);
  assert.doesNotMatch(standalone, /Sign in|Search|\/-\/login|Guest/);
  assert.match(renderToStaticMarkup(createElement(Sidebar, props)), /Search/);
  const recoveryDock = renderToStaticMarkup(createElement(Dock, { places: [], account: { me: { checked: true, name: null }, signIn: "/-/login", recoveryOnly: true } }));
  assert.match(recoveryDock, /Local recovery/);
  assert.doesNotMatch(recoveryDock, /Sign in|\/-\/login|Guest/);
  assert.match(renderToStaticMarkup(createElement(Dock, { places: [], account: { me: { checked: true, name: null }, signIn: "/-/login" } })), /Account: Guest/);
  const places = [{ key: "chat", label: "Chat", href: "/org/project#files?path=Chat", icon: null }];
  const switcher = { current: null, options: [], signedIn: true };
  const dock = renderToStaticMarkup(createElement(Dock, { places, switcher, account: { me: { checked: true, name: "suraj" }, signIn: "/-/login" } }));
  assert.ok(dock.indexOf("Switch space") < dock.indexOf(">Chat<"));
  assert.ok(dock.indexOf(">Chat<") < dock.indexOf("Account: suraj"));
});

test("Settings sits below Guide, while standalone recovery hides nonfunctional hub links", () => {
  const props = {
    primary: [],
    sections: [{ key: "recent", title: "Recent", limit: 4, items: [{ key: "project", label: "org/project", href: "/org/project", icon: null }] }],
    footer: [{ key: "guide", label: "Guide", href: "/-/guide", icon: null }, { key: "settings", label: "Settings", href: "/#/settings", icon: null, active: true }, { key: "builders", label: "Builders", href: "/-/builders", icon: null }], open: false, onClose: nothing, rail: false, onRail: nothing, onSearch: nothing,
  };
  const standalone = renderToStaticMarkup(createElement(Sidebar, { ...props, recoveryOnly: true }));
  assert.match(standalone, /Settings/);
  assert.doesNotMatch(standalone, /All spaces|Search|Recent|org\/project|Guide|Builders|Sub-hubs/);
  const normal = renderToStaticMarkup(createElement(Sidebar, props));
  assert.match(normal, /spacehub home/);
  assert.doesNotMatch(normal, /Switch space/);
  assert.match(normal, /Search/);
  assert.match(normal, /org\/project/);
  assert.match(normal, /Guide/);
  assert.ok(normal.indexOf(">Guide<") < normal.indexOf(">Settings<"));
  assert.ok(normal.indexOf(">Settings<") < normal.indexOf(">Builders<"));
});

test("the space switcher leads the dock, before the places inside where you are", () => {
  const places = [{ key: "chat", label: "Chat", href: "/org/project#files?path=Chat", icon: null, active: true }];
  const switcher = { current: { name: "quirq", kind: "org", href: "/quirq" }, options: [], signedIn: true };
  const dock = renderToStaticMarkup(createElement(Dock, { places, switcher }));
  assert.match(dock, /Space: quirq\. Switch space/);
  assert.ok(dock.indexOf("Switch space") < dock.indexOf(">Chat<"));
  assert.match(renderToStaticMarkup(createElement(Dock, { places: [], switcher: { ...switcher, current: null } })), /All spaces/);
  assert.equal(renderToStaticMarkup(createElement(Dock, { places: [] })), "");
});

test("Settings hides Sub-hubs and backups from everyone but hub operators", () => {
  for (const props of [{}, { signedIn: true }]) {
    const markup = renderToStaticMarkup(createElement(SettingsPage, props));
    assert.match(markup, /<h1>Settings<\/h1>/);
    assert.doesNotMatch(markup, /Sub-hubs|[Bb]ackup|spacehub subhub/);
  }
});

test("Settings embeds full-instance Sub-hubs for operators as a section with the three recovery views", () => {
  const markup = renderToStaticMarkup(createElement(SettingsPage, { operator: true }));
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

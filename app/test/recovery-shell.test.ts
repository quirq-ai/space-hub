import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Exercise the actual shell components without browser effects or production data.
const appDirectory = fileURLToPath(new URL("..", import.meta.url));
const built = await build({ absWorkingDir: appDirectory, stdin: { contents: 'export { TopBar, Sidebar } from "./src/shell/shell"; export { SettingsPage } from "./src/pages/settings";', resolveDir: appDirectory, loader: "tsx" }, bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/jsx-runtime", "react-dom", "react-dom/server"], logLevel: "silent" });
const compiled: { exports: Record<string, ComponentType<any>> } = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const { TopBar, Sidebar, SettingsPage } = compiled.exports;
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
  assert.match(markup, /Backup and restore this entire Spacehub instance/);
  for (const label of ["Overview", "Backups", "Restore"]) assert.match(markup, new RegExp(`>${label}<`));
  assert.doesNotMatch(markup, /Work queue|Sessions|Active drive/);
});

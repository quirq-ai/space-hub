// The client protocol: what a spacehub CLI and the hub it talks to must agree
// on. The CLI asks for it (the client_protocol procedure) whenever it
// connects, and stops with an "update it" message on a mismatch instead of
// failing on a table it cannot read.
//
// Bump PROTOCOL when a change breaks clients built before it: a table, column,
// reducer or procedure they use is renamed, removed or changes type, or a
// table gains a column. Adding a table, reducer or procedure breaks no one.
// OLDEST_PROTOCOL is the oldest client protocol this hub still serves; raise
// it with PROTOCOL unless the hub keeps the old names working.
// 2: every table went private; clients read the visible_<table> views.
export const PROTOCOL = 2;
export const OLDEST_PROTOCOL = 2;

// The generated client bindings this protocol was decided for. The CLI tests
// fail when the bindings change (npm run generate) and this does not, so each
// schema change decides on a bump: then set this to the hash the test prints.
// No bump for project_visibility / project_access (private tables), the
// setProjectVisibility and rebuildAccess reducers and the checkAccess
// procedure: all additions, which break no client. Nor for setDefaultVisibility,
// createProjectWithVisibility and createProjectFromTemplateWithVisibility:
// new reducers beside createProject / createProjectFromTemplate, whose
// arguments stay as they were.
export const BINDINGS_HASH = '1d24be3e12e37d39';

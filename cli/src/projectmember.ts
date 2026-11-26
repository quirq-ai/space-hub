// The app's collaborator action (cli/src/app.ts ACTIONS, POST /-/api/project-member): a project's
// collaborators added or removed through the module's own reducers, run as the signed-in viewer. Owners of
// the project's space add and remove them, a collaborator may leave, and an agent only its own owners add;
// the module refuses anyone else (addProjectMember, removeProjectMember), so nothing is decided here.
// Kept apart from app.ts so its tests load it without the connection code (test/projectmember.test.ts).
import type { Conn } from './conn';

type Reducers = Pick<Conn['reducers'], 'addProjectMember' | 'removeProjectMember'>;

export const projectMemberAction = {
  what: "change the project's collaborators",
  usage: 'Send a project (space/name), a builder, and op "add" or "remove".',
  call: ({ project, builder, op }: Record<string, unknown>): ((conn: { reducers: Reducers }) => Promise<unknown>) | null => {
    if (typeof project !== 'string' || typeof builder !== 'string' || !builder.trim()) return null;
    // A GitHub login as typed, with or without @: the module lowercases it and follows a second name.
    const agent = builder.trim().replace(/^@/, '').toLowerCase();
    if (op === 'add') return conn => conn.reducers.addProjectMember({ project, agent });
    if (op === 'remove') return conn => conn.reducers.removeProjectMember({ project, agent });
    return null;
  },
};

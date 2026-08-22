/**
 * The route manifest, and the shared state the route modules expect somebody to have wired.
 *
 * `app.ts` deliberately does not import a single route module — it owns the order plugins are
 * registered in and nothing else — and `server.ts` is a boot sequence. This file is the seam
 * between them: it names every route module once, in one order, and it does the two pieces of
 * process-wide wiring that no individual module can do for itself.
 *
 * ## Why the session plugin is registered here and not by each module
 *
 * `registerRoutes` gives every module its own encapsulated child instance, and Fastify's
 * `decorateRequest` is scoped to the instance it is called on. So `sessionPlugin` registered
 * inside `routes/auth.ts` decorates the *auth* child and nothing else, and every other module
 * that reads `request.session` sees a property that was never defined:
 *
 * - `routes/hands.ts` answers `internal_error` (it checks `hasRequestDecorator` and says so).
 * - `routes/progress.ts` answers `not_authenticated` to everybody, forever.
 * - `routes/content.ts` degrades to the anonymous view, so no lesson ever shows as completed.
 *
 * None of those failures is visible in a module's own tests, because each test harness registers
 * a session layer at the root before registering the module — which is exactly what this does
 * with the real plugin. `sessionPlugin` is marked `skip-override` and guards on
 * `hasRequestDecorator('session')`, so the registrations inside `routes/auth.ts`,
 * `routes/rooms.ts` and `ws/hub.ts` become no-ops rather than a second lookup per request. The
 * root registration is the one that runs.
 *
 * `/health` and `/ready` are registered by `buildApp` *before* this runs, and Fastify binds a
 * route's hooks at the moment the route is added, so neither probe pays for session resolution.
 * That is the behaviour we want, and it is why this must not move into `buildApp`.
 *
 * ## Why the registry is created here
 *
 * `roomRegistry()` is a process-wide singleton whose *first* call decides its dependencies
 * (`shared ??= new RoomRegistry(options)`). Its `archive` defaults to `noopArchive`, which
 * writes nothing — so a server whose first call is the bare `roomRegistry()` in `routes/rooms.ts`
 * plays hands that are never persisted, and `GET /hands` is empty forever. `postgresArchive`
 * exists for exactly this and had no caller. So the registry is constructed here, before any
 * route module can ask for it, with the archive bound and `onProblem` pointed at the app logger
 * instead of the default no-op that swallowed it.
 *
 * ORDERING: `registerApiRoutes` must run after `configureDatabase` and before anything else calls
 * `roomRegistry()`.
 */

import type { FastifyInstance } from 'fastify';
import { type RouteModule, registerRoutes } from '../app.ts';
import { sessionPlugin } from '../auth/session.ts';
import { getSql } from '../db.ts';
import { recordProblem } from '../observability/telemetry.ts';
import { postgresArchive, roomRegistry } from '../rooms/registry.ts';
import wsHub from '../ws/hub.ts';
import authRoutes, { createAuthStore } from './auth.ts';
import calcRoutes from './calc.ts';
import contentRoutes from './content.ts';
import handsRoutes from './hands.ts';
import progressRoutes from './progress.ts';
import roomRoutes from './rooms.ts';

export { authRoutes, calcRoutes, contentRoutes, handsRoutes, progressRoutes, roomRoutes, wsHub };

/**
 * Every route module, in registration order.
 *
 * The order matches `EXPECTED_ROUTE_MODULES` in `app.ts`. It is not load-bearing — no module
 * depends on another's hooks, and the paths do not overlap — but keeping the two lists in the
 * same order means a missing module is visible by reading them side by side.
 */
export const API_ROUTE_MODULES: readonly RouteModule[] = [
  authRoutes,
  contentRoutes,
  calcRoutes,
  roomRoutes,
  handsRoutes,
  progressRoutes,
  wsHub,
];

/**
 * Wires the shared state and registers every route module under `API_PREFIX`.
 *
 * One call, so the order above cannot be got wrong by a later edit: the session plugin has to be
 * on the root instance before the first module is registered, and the registry has to exist
 * before the first module asks for it.
 */
export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  // The process-wide instance, the same one `buildApp` gave the HTTP hook and the `/metrics`
  // route. Read once here rather than inside the hook so that every notice from every table in
  // this process lands on one registry.
  const metrics = app.appMetrics;

  // Lazily bound: `postgresArchive` takes a getter, so building the registry never touches the
  // pool. A failed write then surfaces as a logged archive failure on a live table rather than
  // as a crash at boot.
  roomRegistry({
    metrics,
    archive: postgresArchive(getSql),
    // A lone learner at a table of bots gets this long to act, so the Coach panel can actually be
    // read before the clock folds them. Threaded from config rather than read inside `LiveTable`,
    // so a test constructing a table directly can still vary it.
    learnerTurnSeconds: app.appConfig.learnerTurnSeconds,
    onProblem: (message, detail) => {
      // Logged first and unchanged: the log line is where the room id, the seat and the underlying
      // error live, and it is the thing somebody reads once an alert has fired.
      app.log.warn({ ...detail }, message);
      // Then counted, by the typed `event` rather than by the prose. `recordProblem` decides which
      // events are seat-actor failures and which are already counted at their source — see
      // `classifyProblem` in `observability/telemetry.ts` for why each one is in the class it is.
      // Doing the classification there rather than with a switch here keeps one list of events,
      // exhaustively checked by the compiler, instead of two that can disagree.
      recordProblem(detail.event, metrics);
    },
  });

  // `getSql()` rather than a getter, because `sessionPlugin` needs the store now — which is why
  // this must run after `configureDatabase`.
  //
  // `routes/auth.ts` builds an equivalent store for its own handlers, so there are two of these
  // objects in a running server. That costs nothing and is not worth threading a parameter to
  // avoid: `createAuthStore` is a set of closures over the `sql` handle with no state and no
  // connections of its own, so both are views onto the one pool. What would matter is two *pools*,
  // and `db.ts` refuses that outright.
  await app.register(sessionPlugin, { store: createAuthStore(getSql()).sessions });

  await registerRoutes(app, API_ROUTE_MODULES);
}

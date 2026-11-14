/**
 * The route manifest, plus the process-wide wiring no single route module can do for itself.
 *
 * `sessionPlugin` is registered on the root because `decorateRequest` is scoped per instance. Inside
 * `routes/auth.ts` alone, every other module would see no `request.session`. The registrations in
 * auth, rooms and `ws/hub.ts` are no-ops once this one runs.
 * `/health` and `/ready` are added in `buildApp` before this, so they skip session resolution.
 * The registry is built here because its first `roomRegistry()` call fixes its dependencies, and
 * the bare default archives nothing.
 * ORDERING: run after `configureDatabase` and before anything else calls `roomRegistry()`.
 */

import type { FastifyInstance } from 'fastify';
import { type RouteModule, registerRoutes } from '../app.ts';
import { sessionPlugin } from '../auth/session.ts';
import { getSql } from '../db.ts';
import { recordProblem } from '../observability/telemetry.ts';
import { postgresSeatEntitlement } from '../rooms/entitlement.ts';
import { postgresRoomOwnership } from '../rooms/ownership.ts';
import { postgresArchive, roomRegistry } from '../rooms/registry.ts';
import wsHub from '../ws/hub.ts';
import authRoutes, { createAuthStore } from './auth.ts';
import calcRoutes from './calc.ts';
import contentRoutes from './content.ts';
import handsRoutes from './hands.ts';
import progressRoutes from './progress.ts';
import roomRoutes from './rooms.ts';

export { authRoutes, calcRoutes, contentRoutes, handsRoutes, progressRoutes, roomRoutes, wsHub };

/** Same order as `EXPECTED_ROUTE_MODULES` in `app.ts`, so the two lists compare side by side. */
export const API_ROUTE_MODULES: readonly RouteModule[] = [
  authRoutes,
  contentRoutes,
  calcRoutes,
  roomRoutes,
  handsRoutes,
  progressRoutes,
  wsHub,
];

/** One call, so the session plugin and the registry always exist before the first module registers. */
export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  // The same instance `buildApp` gave the HTTP hook and `/metrics`, so every table reports to one registry.
  const metrics = app.appMetrics;

  // `postgresArchive` takes a getter, so building the registry never touches the pool.
  roomRegistry({
    metrics,
    archive: postgresArchive(getSql),
    // The lease that makes one API process per room real. The default `ownership: null` lets two
    // processes (a second replica, or a rolling deploy) deal separate decks for one room, silently.
    ownership: postgresRoomOwnership(getSql),
    // `enforced` gates taking a seat and nothing else. `prl_app` holds SELECT only on enrolments
    // (`db/migrations/0006_cohort_enrolments.sql`).
    ...(app.appConfig.enrolmentRequired === 'enforced'
      ? { entitlement: postgresSeatEntitlement(getSql) }
      : {}),
    // Longer clock for a lone learner among bots, so the Coach panel can be read. Configurable for tests.
    learnerTurnSeconds: app.appConfig.learnerTurnSeconds,
    onProblem: (message, detail) => {
      app.log.warn({ ...detail }, message);
      // `classifyProblem` in `observability/telemetry.ts` owns the single list of events.
      recordProblem(detail.event, metrics);
    },
  });

  // `getSql()` now, not a getter, because `sessionPlugin` needs the store at registration.
  // `routes/auth.ts` builds a second store. Both are stateless closures over one pool.
  await app.register(sessionPlugin, { store: createAuthStore(getSql()).sessions });

  await registerRoutes(app, API_ROUTE_MODULES);
}

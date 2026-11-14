/**
 * `src/repositories`, every SQL statement in the application. Each module is plain async functions
 * that take a `Db` handle first, so they compose inside `withTransaction`. Namespace exports, because
 * `create` and `byId` are the right names in several modules. Rules for every module: parameterised SQL
 * only, credentials hashed inside the repository, authorisation in the WHERE clause, races decided by
 * the database and translated by `sql.ts`. Route modules, the hub and the bots contain no SQL.
 */

export * as audit from './audit.ts';
export * as enrolments from './enrolments.ts';
export * as hands from './hands.ts';
export * as hashing from './hashing.ts';
export * as ids from './ids.ts';
export * as progress from './progress.ts';
export * as rooms from './rooms.ts';
export * as sessions from './sessions.ts';
export {
  type Db,
  insideSavepoint,
  isCheckViolation,
  isTransaction,
  isUniqueViolation,
  jsonbObjectParam,
  jsonbParam,
  jsonbParamOrNull,
  requireTransaction,
  SQL_STATE,
  type SqlViolation,
  sqlViolation,
  violationCode,
  violationError,
} from './sql.ts';
export * as users from './users.ts';

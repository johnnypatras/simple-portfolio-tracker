/**
 * Named constants for PostgreSQL / PostgREST error codes we check against in
 * application code. Using symbolic names at call sites documents intent and
 * avoids typos. Source: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */

/** 23505: unique_violation — raised on UNIQUE or EXCLUDE constraint conflict. */
export const PG_UNIQUE_VIOLATION = "23505";

/** 23503: foreign_key_violation — raised when a REFERENCES constraint fails. */
export const PG_FK_VIOLATION = "23503";

/** 23514: check_violation — raised when a CHECK constraint fails. */
export const PG_CHECK_VIOLATION = "23514";

/** 23502: not_null_violation — raised when NOT NULL is violated. */
export const PG_NOT_NULL_VIOLATION = "23502";

/**
 * PGRST116: "JSON object requested, multiple (or no) rows returned" — raised
 * by PostgREST when `.single()` or `.maybeSingle()` expected exactly one row
 * and got zero (or too many). Not a Postgres error code — lives in the
 * PostgREST error namespace.
 */
export const PGRST_NO_ROWS = "PGRST116";

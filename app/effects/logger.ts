import { Cause, Logger, References } from "effect";

import { errorReplacer } from "#~/helpers/formatError";

/**
 * JSON logger that preserves Error causes in annotation values. Effect's
 * built-in `Logger.formatJson` pre-collapses each annotation value through
 * `Inspectable.toJSON`, which turns a native Error into `{}` before
 * serialization — losing message/stack/cause.
 *
 * This logger keeps annotation values raw and serializes the whole record with
 * `errorReplacer`, so native Errors and tagged errors passed as annotation
 * values (e.g. `Effect.annotateLogs({ error })`) serialize fully with their
 * `_tag`, fields, and nested cause.
 *
 * The fiber-level `cause` field (from a failed effect surfacing in
 * `options.cause`) is rendered as a human-readable string via
 * `Cause.pretty(cause)`, matching `Logger.formatJson`'s
 * behavior — it is NOT run through `errorReplacer`.
 *
 * Output shape matches the v3 `Logger.json` (message/logLevel/timestamp/cause/
 * annotations/spans/fiberId) so log consumers are unaffected.
 */
export const JsonLoggerWithCause = Logger.make(
  ({ cause, date, fiber, logLevel, message }) => {
    const annotationsObj: Record<string, unknown> = {
      ...fiber.getRef(References.CurrentLogAnnotations),
    };

    const now = date.getTime();
    const spansObj: Record<string, number> = {};
    for (const [label, startTime] of fiber.getRef(References.CurrentLogSpans)) {
      spansObj[label] = now - startTime;
    }

    const record = {
      // v4 always passes the variadic message array; unwrap the single-message
      // case so the field stays a scalar like it was in v3.
      message:
        Array.isArray(message) && message.length === 1 ? message[0] : message,
      logLevel: logLevel.toUpperCase(),
      timestamp: date.toISOString(),
      cause: cause.reasons.length === 0 ? undefined : Cause.pretty(cause),
      annotations: annotationsObj,
      spans: spansObj,
      fiberId: `#${fiber.id}`,
    };

    globalThis.console.log(JSON.stringify(record, errorReplacer));
  },
);

/** Layer that replaces the default logger with the error-aware JSON logger. */
export const JsonLoggerLayer = Logger.layer([JsonLoggerWithCause]);

import { Cause, FiberId, Logger } from "effect";

import { errorReplacer } from "#~/helpers/formatError";

/**
 * JSON logger that preserves Error causes. Effect's built-in `Logger.json`
 * pre-collapses each annotation value through `Inspectable.toJSON`, which turns
 * a native Error into `{}` before serialization — losing message/stack/cause.
 *
 * This logger keeps annotation values raw and serializes the whole record with
 * `errorReplacer`, so native Errors and tagged-error causes serialize fully.
 * Output shape matches `Logger.json` (message/logLevel/timestamp/cause/
 * annotations/spans/fiberId) so log consumers are unaffected.
 */
export const JsonLoggerWithCause = Logger.make((options) => {
  const { annotations, cause, date, fiberId, logLevel, message, spans } =
    options;

  const annotationsObj: Record<string, unknown> = {};
  for (const [key, value] of annotations) {
    annotationsObj[key] = value;
  }

  const now = date.getTime();
  const spansObj: Record<string, number> = {};
  for (const span of spans) {
    spansObj[span.label] = now - span.startTime;
  }

  const record = {
    message,
    logLevel: logLevel.label,
    timestamp: date.toISOString(),
    cause: Cause.isEmpty(cause)
      ? undefined
      : Cause.pretty(cause, { renderErrorCause: true }),
    annotations: annotationsObj,
    spans: spansObj,
    fiberId: FiberId.threadName(fiberId),
  };

  globalThis.console.log(JSON.stringify(record, errorReplacer));
});

/** Layer that replaces the default logger with the error-aware JSON logger. */
export const JsonLoggerLayer = Logger.replace(
  Logger.defaultLogger,
  JsonLoggerWithCause,
);

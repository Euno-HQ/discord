/**
 * JSON.stringify replacer that serializes Error objects, whose `message`,
 * `stack`, and `cause` are non-enumerable and would otherwise vanish (yielding
 * "{}"). Tagged errors (Data.TaggedError) already expose their fields and `_tag`
 * as own enumerable properties, so they serialize without help.
 */
export const errorReplacer = (_key: string, value: unknown) => {
  if (value instanceof Error) {
    const errorObj: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    const cause = (value as { cause?: unknown }).cause;
    if (cause !== undefined) {
      errorObj.cause = cause;
    }
    return errorObj;
  }
  return value;
};

/**
 * Render any error as a readable string for the rare contexts that genuinely
 * need one — a DB column, a user-facing webhook alert, an analytics field.
 *
 * Prefer passing the error object through to a structured logger instead; only
 * reach for this when an API requires a string. Unlike `String(error)`, this
 * preserves the `_tag` discriminant and structured fields of tagged errors and
 * the message/cause of native Errors.
 */
export const formatError = (error: unknown): string =>
  typeof error === "string" ? error : JSON.stringify(error, errorReplacer);

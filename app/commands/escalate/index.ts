import { Cause } from "effect";

/**
 * Extract the first failure from a Cause for type-safe error matching.
 * Returns undefined if the Cause doesn't contain a Fail.
 */
export const getFailure = <E>(cause: Cause.Cause<E>): E | undefined => {
  const option = Cause.findErrorOption(cause);
  return option._tag === "Some" ? option.value : undefined;
};

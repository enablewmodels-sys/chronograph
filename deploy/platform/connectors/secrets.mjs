// Secret references, never secret values.
//
// A connector is allowed to know that a credential exists and to read it at the
// moment it calls a provider. It is never allowed to return it to a caller, put it
// in a log, or fall back to a default when it is missing: a missing credential means
// the provider call does not happen, because silently using a weaker path is how an
// unauthenticated request looks like a successful one.

/** Raised when a required secret reference has no value in the environment. */
export class MissingSecretError extends Error {
  constructor(name) {
    super("Missing secret reference: " + name);
    this.name = "MissingSecretError";
    this.code = "MISSING_SECRET";
    this.reference = name;
  }
}

/**
 * Resolve secret references by name from one environment object.
 *
 * @param {Record<string, string | undefined>} env source of values, normally process.env
 */
export function createSecrets(env = {}) {
  const read = (name) => {
    if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/.test(name))
      throw new TypeError("Not a secret reference name: " + String(name));
    const value = env[name];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  return {
    /** True when the reference resolves to a nonempty value. */
    has(name) {
      return read(name) !== undefined;
    },
    /** The value, or a typed failure. Never logged by this module. */
    require(name) {
      const value = read(name);
      if (value === undefined) throw new MissingSecretError(name);
      return value;
    },
    /**
     * Which references exist, by name only. Safe to print: it can never carry a
     * value, so a diagnostic cannot leak one.
     */
    describe(names) {
      return names.map((name) => ({ reference: name, present: read(name) !== undefined }));
    },
  };
}

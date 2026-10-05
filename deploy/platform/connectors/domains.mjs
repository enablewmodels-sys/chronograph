// Domains binds a hostname to a project at the edge.
//
// The token is read from its reference at call time and placed only in the request
// header. Record mode exists so an operator can see exactly what would be sent during
// a dry run, which is also what makes the connector testable without a Cloudflare
// account: no account, no request, but a real, inspectable plan.
export const API = "https://api.cloudflare.com/client/v4";

/**
 * @param {object} options
 * @param {{require: (name: string) => string, has: (name: string) => boolean}} options.secrets
 * @param {(url: string, init?: object) => Promise<Response>} options.fetch
 * @param {boolean} options.record when true nothing is sent, the request is returned
 * @param {{apiToken: string, zone: string}} [options.references]
 */
export function createDomains({
  secrets,
  fetch: fetcher,
  record,
  references = { apiToken: "CHRONOGRAPH_DOMAINS_API_TOKEN", zone: "CHRONOGRAPH_DOMAINS_ZONE" },
}) {
  function request(method, path, body) {
    return {
      method,
      url: API + "/zones/" + encodeURIComponent(secrets.require(references.zone)) + path,
      headers: { authorization: "Bearer " + secrets.require(references.apiToken), "content-type": "application/json" },
      body,
    };
  }

  async function send(plan) {
    // Record mode never needs the token, so a dry run works before a connection
    // exists at all; that is the difference between planning and pretending.
    if (record)
      return {
        recorded: true,
        request: {
          ...plan,
          headers: { ...plan.headers, authorization: "Bearer <" + references.apiToken + ">" },
        },
      };
    const response = await fetcher(plan.url, {
      method: plan.method,
      headers: plan.headers,
      ...(plan.body === undefined ? {} : { body: JSON.stringify(plan.body) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = Array.isArray(payload.errors) && payload.errors.length
        ? payload.errors.map((error) => error.message).join("; ")
        : String(response.status);
      throw new Error("Domain provider refused the request: " + message);
    }
    return { recorded: false, result: payload.result };
  }

  return {
    references,
    /** Attach a hostname to a project. */
    async bind(hostname, projectId) {
      const plan = request("POST", "/custom_hostnames", {
        hostname,
        ssl: { method: "http", type: "dv" },
        custom_metadata: { project: String(projectId) },
      });
      return send(plan);
    },
    /** Detach a hostname. Looks the record up first: deleting by name is not supported. */
    async unbind(hostname) {
      const found = await send(request("GET", "/custom_hostnames?hostname=" + encodeURIComponent(hostname)));
      if (found.recorded) return found;
      const id = found.result?.[0]?.id;
      if (!id) throw new Error("No custom hostname bound for " + hostname);
      return send(request("DELETE", "/custom_hostnames/" + encodeURIComponent(id)));
    },
  };
}

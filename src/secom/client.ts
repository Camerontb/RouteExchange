import { Agent, request } from "undici";
import { config, assertConfigured } from "../config.ts";

/**
 * Minimal SECOM (IEC 63173-2) REST client.
 *
 * SECOM exposes a small set of HTTPS interfaces. For receiving S-124 we use the
 * "Get Object" interface. Exact path + query params must be confirmed against
 * Fintraffic's test service (see PLAN.md open questions) — `/v1/object` is the
 * SECOM-core default and is used here as the starting point.
 */

/** mTLS dispatcher built from the MIR client identity, if configured. */
function buildDispatcher(): Agent | undefined {
  const { cert, key, ca } = config.tls;
  if (!cert || !key) return undefined; // test service may be open (no client auth yet)
  return new Agent({
    connect: { cert, key, ca },
  });
}

const dispatcher = buildDispatcher();

export interface GetObjectQuery {
  /** WKT or bbox describing the area of interest; shape TBD from Fintraffic spec. */
  geometry?: string;
  /** ISO timestamps bounding the query. */
  fromTime?: string;
  toTime?: string;
}

/**
 * SECOM "Get Object" against the S-124 service.
 * Returns the raw response body (SECOM envelope, typically JSON wrapping base64
 * S-124 GML). Envelope verification + GML parsing happen in the caller (s124.ts).
 */
export async function getS124Objects(query: GetObjectQuery = {}): Promise<unknown> {
  assertConfigured();
  const url = new URL("/v1/object", config.secomS124BaseUrl);
  if (query.geometry) url.searchParams.set("geometry", query.geometry);
  if (query.fromTime) url.searchParams.set("fromTime", query.fromTime);
  if (query.toTime) url.searchParams.set("toTime", query.toTime);

  const res = await request(url, {
    method: "GET",
    headers: { accept: "application/json" },
    dispatcher,
  });

  if (res.statusCode >= 400) {
    const body = await res.body.text();
    throw new Error(`SECOM GetObject failed: ${res.statusCode} ${body.slice(0, 500)}`);
  }

  // TODO(M0): verify the SECOM response envelope signature before trusting the payload.
  return res.body.json();
}

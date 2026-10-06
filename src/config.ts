import { readFileSync } from "node:fs";

/** Reads a cert/key either from an inline PEM env var or a file path. */
function readPem(inline?: string, path?: string): string | undefined {
  if (inline && inline.trim()) return inline.replace(/\\n/g, "\n");
  if (path && path.trim()) return readFileSync(path, "utf8");
  return undefined;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),

  /**
   * AIS relay: one upstream aisstream WebSocket per org, folded into
   * orgs/{orgId}/aisTargets in Firestore. Keys live in Firestore (secrets/ais),
   * read with the Admin SDK — never passed to a browser.
   */
  ais: {
    enabled: process.env.AIS_RELAY_ENABLED !== "false", // on unless turned off
    streamUrl: process.env.AISSTREAM_URL ?? "wss://stream.aisstream.io/v0/stream",
    // Fastest we rewrite a given vessel's position doc. AIS sends far more often
    // than a pilot needs, and each write is billed, so we coalesce.
    positionThrottleMs: Number(process.env.AIS_POSITION_THROTTLE_MS ?? 8000),
    // A vessel unheard this long is pruned from the chart.
    staleMs: Number(process.env.AIS_STALE_MS ?? 10 * 60 * 1000),
    pruneIntervalMs: Number(process.env.AIS_PRUNE_INTERVAL_MS ?? 60 * 1000),
    // Safety cap: most distinct vessels one org will hold at once. A box drawn
    // far too wide can't then run up an unbounded Firestore bill — once an org
    // is tracking this many, further *new* vessels are dropped (known ones keep
    // updating) and the status doc flags it.
    maxVesselsPerOrg: Number(process.env.AIS_MAX_VESSELS_PER_ORG ?? 1000),
    // How often each org's status doc (live/error, vessel count, last message)
    // is refreshed so the Admin AIS tab can show the feed is really working.
    statusIntervalMs: Number(process.env.AIS_STATUS_INTERVAL_MS ?? 30 * 1000),
    // Single-writer lease. Only the instance holding the lease runs the feeds,
    // so a second Cloud Run instance (deploy overlap, a stray scale-up) can't
    // double the upstream connections or the writes. Renewed well inside the
    // TTL; a dead holder's lease is taken over after it expires.
    leaseTtlMs: Number(process.env.AIS_LEASE_TTL_MS ?? 60 * 1000),
    leaseRenewMs: Number(process.env.AIS_LEASE_RENEW_MS ?? 20 * 1000),
  },

  /** Base URL of the Fintraffic S-124 SECOM service (direct test URL from Ramin). */
  secomS124BaseUrl: process.env.SECOM_S124_BASE_URL ?? "",

  /**
   * mTLS client identity (MIR-issued cert). Leave unset while the test service
   * is open; set once Fintraffic requires client auth.
   */
  tls: {
    cert: readPem(process.env.SECOM_CLIENT_CERT, process.env.SECOM_CLIENT_CERT_PATH),
    key: readPem(process.env.SECOM_CLIENT_KEY, process.env.SECOM_CLIENT_KEY_PATH),
    ca: readPem(process.env.SECOM_CA_CERT, process.env.SECOM_CA_CERT_PATH),
  },
} as const;

export function assertConfigured(): void {
  if (!config.secomS124BaseUrl) {
    throw new Error("SECOM_S124_BASE_URL is not set — get the test service URL from Fintraffic (Ramin).");
  }
}

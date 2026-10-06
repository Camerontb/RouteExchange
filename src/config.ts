import { readFileSync } from "node:fs";

/** Reads a cert/key either from an inline PEM env var or a file path. */
function readPem(inline?: string, path?: string): string | undefined {
  if (inline && inline.trim()) return inline.replace(/\\n/g, "\n");
  if (path && path.trim()) return readFileSync(path, "utf8");
  return undefined;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),

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

import express from "express";
import { config } from "./config.ts";
import { getS124Objects } from "./secom/client.ts";
import { s124ToGeoJSON } from "./secom/s124.ts";

export function createServer() {
  const app = express();
  app.use(express.json());

  // Liveness probe for Cloud Run.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "empx-mcp-gateway", secomConfigured: Boolean(config.secomS124BaseUrl) });
  });

  /**
   * S-124 navigational warnings as GeoJSON for EMPX.
   * EMPX speaks only this — no SECOM, no GML, no certs.
   *
   * Query: ?bbox=minLon,minLat,maxLon,maxLat (optional)
   */
  app.get("/warnings", async (req, res) => {
    try {
      const geometry = bboxToWkt(req.query.bbox);
      const payload = await getS124Objects({ geometry });
      res.json(s124ToGeoJSON(payload));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: "secom_upstream_error", message });
    }
  });

  return app;
}

/** bbox "minLon,minLat,maxLon,maxLat" → WKT POLYGON (query shape TBD w/ Fintraffic). */
function bboxToWkt(bbox: unknown): string | undefined {
  if (typeof bbox !== "string") return undefined;
  const p = bbox.split(",").map(Number);
  if (p.length !== 4 || p.some(Number.isNaN)) return undefined;
  const [minLon, minLat, maxLon, maxLat] = p;
  return `POLYGON((${minLon} ${minLat}, ${maxLon} ${minLat}, ${maxLon} ${maxLat}, ${minLon} ${maxLat}, ${minLon} ${minLat}))`;
}

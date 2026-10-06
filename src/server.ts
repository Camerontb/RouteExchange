import express from "express";
import { config } from "./config.ts";
import { getS124Objects } from "./secom/client.ts";
import { s124ToGeoJSON } from "./secom/s124.ts";
import type { AisRelay } from "./ais/relay.ts";
import type { RouteHub } from "./exchange/hub.ts";
import { PILOT_HTML, BRIDGE_HTML } from "./exchange/demo.ts";

export function createServer(relay: AisRelay | null = null, hub: RouteHub | null = null) {
  const app = express();
  app.use(express.json());

  // Liveness probe for Cloud Run.
  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      service: "empx-mcp-gateway",
      secomConfigured: Boolean(config.secomS124BaseUrl),
      ais: relay
        ? { enabled: true, leader: relay.isLeader(), activeOrgs: relay.activeOrgs().length }
        : { enabled: false },
      routeHub: hub ? { enabled: true, sessions: hub.activeSessions() } : { enabled: false },
    });
  });

  // Route exchange: hand an offer to the paired PPU. Live status + chat ride the
  // WebSocket at /ws (see exchange/hub.ts). The in-browser demo clients:
  app.post("/routes", (req, res) => {
    if (!hub) return res.status(503).json({ error: "route_hub_disabled" });
    const result = hub.submitRoute(req.body ?? {});
    return res.status(result.error ? 409 : 200).json(result);
  });
  app.get("/demo", (_req, res) => res.redirect("/demo/pilot"));
  app.get("/demo/pilot", (_req, res) => res.type("html").send(PILOT_HTML));
  app.get("/demo/bridge", (_req, res) => res.type("html").send(BRIDGE_HTML));

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

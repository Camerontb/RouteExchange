# empx-mcp-gateway

Gateway between **EMPX** and **Fintraffic's Maritime Connectivity Platform (MCP)**.

Speaks **SECOM** (IEC 63173-2) + S-100 to Fintraffic; serves plain JSON/GeoJSON to EMPX.
All S-100 / GML / PKI complexity lives here so the EMPX app never has to.

See [PLAN.md](./PLAN.md) for the roadmap and decisions.

## Status

**M0 — S-124 navigational warnings (receive-only).** Scaffold in place; wiring to a
real Fintraffic test service is the next step (needs the service URL from Ramin).

## Run locally

```bash
npm install
cp .env.example .env     # fill in SECOM_S124_BASE_URL once you have it
npm run dev              # http://localhost:8080
```

```bash
curl localhost:8080/healthz
curl "localhost:8080/warnings?bbox=19,59,27,65"   # Gulf of Finland-ish bbox
```

`/warnings` returns a GeoJSON `FeatureCollection` EMPX can render directly.
It returns an empty collection until `s124ToGeoJSON` is implemented against a real
S-124 sample (M0).

## Layout

| Path | What |
|---|---|
| `src/server.ts` | Express app: `/healthz`, `/warnings` |
| `src/secom/client.ts` | SECOM REST client (mTLS, GetObject) |
| `src/secom/s124.ts` | S-124 GML → GeoJSON (stub) |
| `src/ais/relay.ts` | AIS relay: upstream aisstream WebSocket per org |
| `src/ais/firestore.ts` | Admin SDK — config watch, key read, target writes |
| `src/config.ts` | Env config + cert loading |
| `Dockerfile` | Cloud Run container |

## AIS relay (aisstream.io → Firestore)

The EMPX app shows live AIS traffic on the chart, but the aisstream API key must
never reach a pilot's device. So the gateway holds it instead:

1. An org admin enters the key and a bounding box in the app's **Admin → AIS** tab.
   The key is written to `orgs/{orgId}/secrets/ais` (write-only; no client can
   read it back), the rest to `orgs/{orgId}/config/ais`.
2. The relay watches every `config/ais`, and for each enabled org opens one
   WebSocket to aisstream with that org's key and boxes.
3. Decoded position/static reports are folded into `orgs/{orgId}/aisTargets`
   (throttled per vessel). The app reads that collection over Firestore's own
   realtime channel — no app ↔ gateway socket, no key on the device.

Hardening in place:
- **Single-writer lease** (`gatewayControl/aisRelayLock`): only the instance
  holding the lease runs any feeds, so a second instance can't double the
  upstream connections or the writes — it idles until it wins the lease.
- **Feed status** is published to `orgs/{orgId}/config/aisStatus`
  (live / error / connecting, vessel count, last-message time). The Admin AIS
  tab shows it, so a wrong key reads as an error rather than silence. A bad key
  is treated as fatal — the feed stops retrying until the settings change.
- **Vessel cap** (`AIS_MAX_VESSELS_PER_ORG`, default 1000): a box drawn far too
  wide can't run up an unbounded Firestore bill.
- `decode.ts` is pure and unit-tested (`npm test`).

Needs Firestore Admin credentials: the Cloud Run service account on deploy, or
`GOOGLE_APPLICATION_CREDENTIALS` locally. Grant the service account the
**Cloud Datastore User** role on the app's Firebase project. `/healthz` reports
whether this instance is the leader and how many orgs it has connected.

## Deploy (Cloud Run)

```bash
gcloud run deploy empx-mcp-gateway --source . --region europe-north1 \
  --set-env-vars SECOM_S124_BASE_URL=... \
  --no-allow-unauthenticated
```

The AIS relay keeps upstream WebSockets open, so give the service a warm
instance and let it run without request-based scaling:

```bash
gcloud run services update empx-mcp-gateway --region europe-north1 \
  --min-instances 1 --max-instances 1 --no-cpu-throttling
```

One instance is still the intended shape (lowest cost, one socket per org). The
single-writer lease means a brief overlap during a deploy is *safe* — the new
instance idles until it wins the lease — rather than silently doubling every
write. Client certs for mTLS go in as secrets, not env vars, once required.

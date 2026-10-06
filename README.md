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
| `src/config.ts` | Env config + cert loading |
| `Dockerfile` | Cloud Run container |

## Deploy (Cloud Run)

```bash
gcloud run deploy empx-mcp-gateway --source . --region europe-north1 \
  --set-env-vars SECOM_S124_BASE_URL=... \
  --allow-unauthenticated
```

Client certs for mTLS go in as secrets, not env vars, once required.

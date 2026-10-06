# EMPX ↔ Fintraffic Maritime Connectivity Gateway — Plan

A standalone service that speaks **SECOM** (IEC 63173-2) to Fintraffic's Maritime
Connectivity Platform (MCP) on one side, and plain JSON to the EMPX app on the other.
EMPX never learns SECOM; all S-100 / GML / PKI complexity stays behind this gateway.

```
          plain JSON/GeoJSON                 SECOM (IEC 63173-2, mTLS)
EMPX  ───────────────────────►  empx-mcp-gateway  ───────────────────────►  Fintraffic MCP
(React app)   GET /warnings       (Node/TS, Cloud Run)   S-124 / S-421 / ...   (test services)
```

## Why a separate service (decided)

- SECOM uses **mutual-TLS with MCP/MIR certificates** (PKI identity per actor). That
  trust material must not live in a browser app, and shouldn't be bolted onto the EMPX
  Cloud Functions beside Stripe/billing.
- Inbound push, subscriptions and polling are **stateful server work** a client can't do.
- Anti-corruption layer: EMPX stays clean and the same gateway can later serve the
  Port/VTS side, not just EMPX.

## Decisions locked

| Decision | Choice | Rationale |
|---|---|---|
| Stack | **Node 20+/TypeScript** | Same ecosystem as EMPX/Functions; SECOM is a small REST surface. Reach for GLA `secom-core` (Java) only if the signed-envelope crypto gets painful in production. |
| Transport | **SECOM over HTTPS (REST)** | SECOM *is* REST; mTLS via undici `Agent`. |
| First capability | **S-124 nav warnings (receive-only)** | A single authenticated GET → GeoJSON. Cheapest proof we can speak SECOM. Matches what was agreed with Fintraffic. |
| Deploy | **Single Cloud Run container** | Handles mTLS client certs + inbound push cleanly; one service, scales to zero. |
| Repo | **Standalone** (`empx-mcp-gateway`) | Clean trust boundary, own deploy/lifecycle. |

## Milestones

### M0 — SECOM "hello world": S-124 receive  ← prototype target
De-risk the one genuinely unknown thing: SECOM auth + envelope.

- [ ] Get Fintraffic's **direct test S-124 service URL** from Ramin (no MSR lookup needed for testing)
- [ ] Obtain / generate the **MIR client certificate** for mTLS (or confirm test service is open)
- [ ] `GET /v1/object` against the S-124 service via mTLS (undici `Agent`)
- [ ] Verify the SECOM **response envelope + signature** (log only at first; enforce next)
- [ ] Parse **S-124 GML** → GeoJSON `FeatureCollection`
- [ ] Expose `GET /warnings?bbox=...` returning that GeoJSON
- [ ] Render in EMPX on the chart as a warnings overlay
- **Done =** real Finnish nav warnings visible on the EMPX chart.

### M1 — Route Exchange (S-421)  ← the IALA demo centerpiece
Same service, the harder half: bidirectional + a proprietary API.

- [ ] Map EMPX route (RTZ / IEC 61174) → **S-421 GML**
- [ ] `POST /v1/object` (upload) a route to the Route Exchange Service
- [ ] Receive a route back (poll `GET /v1/object` or subscription) → S-421 → GeoJSON → RTZ
- [ ] `POST /routes` and `GET /routes` on the gateway for EMPX
- [ ] Round-trip demo: EMPX route → Fintraffic → returned route rendered in EMPX

### M2+ — later (not now)
- S-212 traffic clearance (ties into the AI hotspot/collision use case)
- MSR service discovery + MIR-issued certs (instead of direct URLs)
- Subscriptions / inbound push from Fintraffic
- Swap hand-rolled SECOM envelope for GLA `secom-core` if production demands it

## Open questions for Fintraffic (Ramin)
1. Test S-124 service URL + whether it needs a client cert or is open for testing.
2. Exact SECOM interface version and the S-124 query params (`GET /v1/object` shape).
3. For M1: Route Exchange test endpoint + where the proprietary API sits vs SECOM.
4. MIR cert issuance process for when we move off direct URLs.

## Scaffold in this repo
- `src/server.ts` — Express app, `GET /healthz`, `GET /warnings`
- `src/secom/client.ts` — SECOM REST client with mTLS agent (GetObject)
- `src/secom/s124.ts` — S-124 GML → GeoJSON (stub, M0 fills it in)
- `src/config.ts` — env config
- `Dockerfile` — Cloud Run container
- `.env.example` — required env vars

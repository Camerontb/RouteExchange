import { createServer } from "./server.ts";
import { config } from "./config.ts";
import { AisRelay } from "./ais/relay.ts";
import { RouteHub } from "./exchange/hub.ts";

const relay = config.ais.enabled ? new AisRelay() : null;
const hub = new RouteHub();
const app = createServer(relay, hub);

const server = app.listen(config.port, () => {
  console.log(`empx-mcp-gateway listening on :${config.port}`);
  console.log(`[hub] route exchange ready — demo at http://localhost:${config.port}/demo`);
  if (!config.secomS124BaseUrl) {
    console.warn("⚠  SECOM_S124_BASE_URL not set — /warnings will error until the Fintraffic test URL is configured.");
  }
  if (relay) {
    relay.start();
  } else {
    console.log("[ais] relay disabled (AIS_RELAY_ENABLED=false)");
  }
});

hub.attach(server);

// Cloud Run sends SIGTERM before stopping the instance; close the upstreams
// and release the lease so a replacement instance can take over at once.
process.on("SIGTERM", async () => {
  await relay?.stop();
  process.exit(0);
});

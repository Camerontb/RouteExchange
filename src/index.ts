import { createServer } from "./server.ts";
import { config } from "./config.ts";

const app = createServer();

app.listen(config.port, () => {
  console.log(`empx-mcp-gateway listening on :${config.port}`);
  if (!config.secomS124BaseUrl) {
    console.warn("⚠  SECOM_S124_BASE_URL not set — /warnings will error until the Fintraffic test URL is configured.");
  }
});

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

export async function startServer(overrides = {}) {
  const app = await createApp(overrides);
  const server = createServer(app.handler);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(app.config.port, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return { server, app };
}

const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { server, app } = await startServer();
  console.log(`Quadrafy disponível em http://localhost:${app.config.port}`);

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

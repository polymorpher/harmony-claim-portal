import { buildConfirmApp } from "./confirm/app.js";
import { PgConfirmStore } from "./confirm/store.js";
import { loadConfirmConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfirmConfig();
  const store = new PgConfirmStore(config.databaseUrl);
  if (config.enforceDbPrivileges) await store.checkPrivileges();
  const app = await buildConfirmApp({ config, store });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

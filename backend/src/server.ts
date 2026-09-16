import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PgRepository } from "./repository.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const repo = new PgRepository(config.databaseUrl);
  const app = await buildApp({ config, repo });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await repo.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

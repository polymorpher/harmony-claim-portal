import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PgRepository } from "./repository.js";
import { PgVaultMetadataStore } from "./vault/store.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const repo = new PgRepository(config.databaseUrl);
  const vaultNames = new PgVaultMetadataStore(config.databaseUrl);
  if (config.enforceDbPrivileges) await repo.checkPrivileges();
  const app = await buildApp({ config, repo, archive: repo.archive, vaultNames });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await repo.close();
    await vaultNames.close();
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

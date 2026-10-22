import { buildConfirmApp } from "./confirm/app.js";
import { PgConfirmStore } from "./confirm/store.js";
import { loadConfirmConfig } from "./config.js";
import { ethereumVaultChain } from "./vault/chain.js";
import { VaultNameService } from "./vault/service.js";
import { PgVaultMetadataStore } from "./vault/store.js";

async function main(): Promise<void> {
  const config = loadConfirmConfig();
  const store = new PgConfirmStore(config.databaseUrl);
  const vaultNames = new PgVaultMetadataStore(config.databaseUrl);
  if (config.enforceDbPrivileges) await store.checkPrivileges();
  const names = new VaultNameService(vaultNames, ethereumVaultChain(config.vaultEthRpcUrls), {
    domain: config.domain,
    challengeTtlSeconds: config.challengeTtlSeconds,
  });
  const app = await buildConfirmApp({ config, store, names });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await store.close();
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

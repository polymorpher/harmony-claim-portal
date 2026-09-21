import Fastify, { type FastifyInstance } from "fastify";
import { normalizeAddress } from "./address.js";
import { buildClaimResponse, buildMeta } from "./claims.js";
import type { Config } from "./config.js";
import { clientKey, registerApiSafety, registerNotFound } from "./http.js";
import type { ClaimRepository } from "./repository.js";

export { clientKey };

export interface AppOptions {
  config: Pick<Config, "rateLimitMax" | "rateLimitWindow" | "exposeContractAmounts" | "logLevel" | "trustProxy">;
  repo: ClaimRepository;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { config, repo } = opts;
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 1024,
  });
  await registerApiSafety(app, config);

  app.get("/api/health", { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      await repo.ping();
      return { status: "ok" };
    } catch (err) {
      app.log.warn({ err }, "database ping failed");
      return reply.code(503).send({ status: "degraded", database: "unreachable" });
    }
  });

  app.get("/api/v1/meta", async () => buildMeta(await repo.getMeta()));

  app.get<{ Params: { address: string } }>("/api/v1/claims/:address", async (req, reply) => {
    if (!req.params.address) return reply.callNotFound();
    const address = normalizeAddress(req.params.address);
    const [account, delegations, exceptions, exchangeWallets, reasonTexts, meta] = await Promise.all([
      repo.getAccount(address),
      repo.getDelegations(address),
      repo.getExceptions(address),
      repo.getExchangeWallets(address),
      repo.getReasonTexts(),
      repo.getMeta(),
    ]);
    const validators = [...new Set(delegations.map((d) => d.validator_address.toLowerCase()))];
    const vaults = await repo.getVaults(validators);
    return buildClaimResponse(
      address,
      account,
      delegations,
      exceptions,
      exchangeWallets,
      vaults,
      reasonTexts,
      meta,
      { exposeContractAmounts: config.exposeContractAmounts },
    );
  });

  registerNotFound(app);

  return app;
}

import { STATUS_CODES } from "node:http";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { ApiError } from "@hcp/shared";
import { InvalidAddressError, normalizeAddress } from "./address.js";
import { buildClaimResponse, buildMeta } from "./claims.js";
import type { Config } from "./config.js";
import type { ClaimRepository } from "./repository.js";

export interface AppOptions {
  config: Pick<Config, "rateLimitMax" | "rateLimitWindow" | "exposeContractAmounts" | "logLevel" | "trustProxy">;
  repo: ClaimRepository;
}

/** Client key: Cloudflare header, then first X-Forwarded-For hop, then socket. */
export function clientKey(req: FastifyRequest): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
  const xff = req.headers["x-forwarded-for"];
  const first = Array.isArray(xff) ? xff[0] : xff;
  if (typeof first === "string" && first.trim()) return first.split(",")[0].trim();
  return req.ip;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { config, repo } = opts;
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false, // API returns JSON only; the SPA is served by the bucket
    crossOriginResourcePolicy: { policy: "same-origin" },
  });

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindow,
    keyGenerator: clientKey,
    addHeadersOnExceeding: { "x-ratelimit-limit": true, "x-ratelimit-remaining": true },
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    },
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: `Rate limit exceeded; retry in ${Math.ceil(context.ttl / 1000)} seconds`,
    }),
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof InvalidAddressError) {
      const body: ApiError = { statusCode: 400, error: "Bad Request", message: err.message };
      return reply.code(400).send(body);
    }
    const e = (err ?? {}) as { statusCode?: unknown; message?: unknown };
    const status = typeof e.statusCode === "number" ? e.statusCode : 500;
    if (status >= 500) app.log.error({ err }, "request failed");
    const body: ApiError = {
      statusCode: status,
      error: STATUS_CODES[status] ?? "Error",
      message: status >= 500 ? "internal error" : String(e.message ?? ""),
    };
    return reply.code(status).send(body);
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

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
    const [account, delegations, exceptions, reasonTexts, meta] = await Promise.all([
      repo.getAccount(address),
      repo.getDelegations(address),
      repo.getExceptions(address),
      repo.getReasonTexts(),
      repo.getMeta(),
    ]);
    const validators = [...new Set(delegations.map((d) => d.validator_address.toLowerCase()))];
    const vaults = await repo.getVaults(validators);
    return buildClaimResponse(address, account, delegations, exceptions, vaults, reasonTexts, meta, {
      exposeContractAmounts: config.exposeContractAmounts,
    });
  });

  app.setNotFoundHandler({ preHandler: app.rateLimit() }, async (_req, reply) => {
    const body: ApiError = { statusCode: 404, error: "Not Found", message: "route not found" };
    return reply.code(404).send(body);
  });

  return app;
}

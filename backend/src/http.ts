import { STATUS_CODES } from "node:http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { ApiError } from "@hcp/shared";
import { InvalidAddressError } from "./address.js";

/** Client IP: Cloudflare header, then first X-Forwarded-For hop, then socket. */
export function clientIp(req: FastifyRequest): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
  const xff = req.headers["x-forwarded-for"];
  const first = Array.isArray(xff) ? xff[0] : xff;
  if (typeof first === "string" && first.trim()) return first.split(",")[0].trim();
  return req.ip;
}

/** Browser identity. Newlines are stripped and the value is capped so it cannot be a storage key of arbitrary size. */
export function clientUserAgent(req: FastifyRequest): string {
  const raw = req.headers["user-agent"];
  const ua = (typeof raw === "string" ? raw : "").replace(/[\r\n]/g, " ").trim().slice(0, 160);
  return ua || "-";
}

/** One browser: IP plus User-Agent. Limits are never keyed by the looked-up address. */
export function clientKey(req: FastifyRequest): string {
  return `${clientIp(req)}\n${clientUserAgent(req)}`;
}

/** One IP may host several browsers. Rotating User-Agent does not multiply this budget. */
const IP_BUDGET_FACTOR = 10;

export async function registerApiSafety(
  app: FastifyInstance,
  opts: { rateLimitMax: number; rateLimitWindow: string },
): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: false, // API returns JSON only; the SPA is served by the bucket
    crossOriginResourcePolicy: { policy: "same-origin" },
  });

  const limitHeaders = {
    addHeadersOnExceeding: { "x-ratelimit-limit": true, "x-ratelimit-remaining": true },
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    },
    errorResponseBuilder: (_req: FastifyRequest, context: { ttl: number }) => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: `Rate limit exceeded; retry in ${Math.ceil(context.ttl / 1000)} seconds`,
    }),
  };
  await app.register(rateLimit, {
    global: true,
    max: opts.rateLimitMax,
    timeWindow: opts.rateLimitWindow,
    keyGenerator: clientKey,
    nameSpace: "hcp-client-",
    ...limitHeaders,
  });
  await app.register(rateLimit, {
    global: true,
    max: opts.rateLimitMax * IP_BUDGET_FACTOR,
    timeWindow: opts.rateLimitWindow,
    keyGenerator: clientIp,
    nameSpace: "hcp-ip-",
    ...limitHeaders,
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
}

export function registerNotFound(app: FastifyInstance): void {
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, async (_req, reply) => {
    const body: ApiError = { statusCode: 404, error: "Not Found", message: "route not found" };
    return reply.code(404).send(body);
  });
}

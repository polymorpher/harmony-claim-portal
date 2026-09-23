import Fastify, { type FastifyInstance } from "fastify";
import { isSignatureScheme } from "@hcp/shared";
import { normalizeAddress } from "../address.js";
import type { ConfirmConfig } from "../config.js";
import { registerApiSafety, registerNotFound } from "../http.js";
import { ConfirmService } from "./service.js";
import type { ConfirmStore } from "./store.js";

export interface ConfirmAppOptions {
  config: Pick<ConfirmConfig, "rateLimitMax" | "rateLimitWindow" | "logLevel" | "trustProxy" | "domain" | "challengeTtlSeconds">;
  store: ConfirmStore;
  now?: () => Date;
}

export async function buildConfirmApp(opts: ConfirmAppOptions): Promise<FastifyInstance> {
  const { config, store } = opts;
  const service = new ConfirmService(store, {
    domain: config.domain,
    challengeTtlSeconds: config.challengeTtlSeconds,
    now: opts.now,
  });
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 4096,
  });
  await registerApiSafety(app, config);

  app.get("/api/health", { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      await store.ping();
      return { status: "ok" };
    } catch (err) {
      app.log.warn({ err }, "database ping failed");
      return reply.code(503).send({ status: "degraded", database: "unreachable" });
    }
  });

  app.get<{ Params: { address: string } }>("/api/v1/confirmations/:address", async (req) => {
    const address = normalizeAddress(req.params.address);
    return service.status(address);
  });

  app.post<{ Body: { address?: unknown } }>("/api/v1/confirmations/challenges", async (req) => {
    const address = normalizeAddress(readAddress(req.body));
    return service.challenge(address);
  });

  app.post<{
    Body: {
      address?: unknown;
      nonce?: unknown;
      issued_at?: unknown;
      signature?: unknown;
      data_version?: unknown;
      policy_version?: unknown;
      signature_scheme?: unknown;
    };
  }>(
    "/api/v1/confirmations",
    async (req) => {
      const body = req.body ?? {};
      const address = normalizeAddress(readAddress(body));
      if (typeof body.nonce !== "string" || typeof body.issued_at !== "string" || typeof body.signature !== "string") {
        const err = new Error("nonce, issued_at, and signature are required");
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      const scheme = body.signature_scheme ?? "personal_sign";
      if (!isSignatureScheme(scheme)) {
        const err = new Error("signature_scheme must be personal_sign or harmony_ledger_tx");
        (err as { statusCode?: number }).statusCode = 400;
        throw err;
      }
      const signedVersion =
        typeof body.data_version === "string" && typeof body.policy_version === "string"
          ? { dataVersion: body.data_version, policyVersion: body.policy_version }
          : undefined;
      return service.submit(address, body.nonce, body.issued_at, body.signature, signedVersion, scheme);
    },
  );

  registerNotFound(app);
  return app;
}

function readAddress(body: { address?: unknown } | undefined): string {
  if (!body || typeof body.address !== "string") {
    const err = new Error("address is required");
    (err as { statusCode?: number }).statusCode = 400;
    throw err;
  }
  return body.address;
}

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { ADDR, MemoryRepository } from "./fixtures.js";
import { hexToBech32 } from "@hcp/shared";

let app: FastifyInstance;
const repo = new MemoryRepository();

beforeAll(async () => {
  app = await buildApp({
    config: {
      rateLimitMax: 5,
      rateLimitWindow: "1 minute",
      exposeContractAmounts: false,
      logLevel: "silent",
      trustProxy: true,
    },
    repo,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("http surface", () => {
  it("health reflects database reachability", async () => {
    const ok = await app.inject({ method: "GET", url: "/api/health" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ status: "ok" });
    repo.failPing = true;
    const bad = await app.inject({ method: "GET", url: "/api/health" });
    repo.failPing = false;
    expect(bad.statusCode).toBe(503);
  });

  it("meta", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/meta" });
    expect(res.statusCode).toBe(200);
    expect(res.json().cutoff.shard0.block).toBe(93623067);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("claims accept one1 and checksum forms", async () => {
    const bech = hexToBech32(ADDR.eoa);
    const a = await app.inject({ method: "GET", url: `/api/v1/claims/${bech}`, headers: { "cf-connecting-ip": "10.0.0.1" } });
    expect(a.statusCode).toBe(200);
    expect(a.json().address.hex).toBe(ADDR.eoa);
    const b = await app.inject({ method: "GET", url: "/api/v1/claims/0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", headers: { "cf-connecting-ip": "10.0.0.2" } });
    expect(b.json().found).toBe(true);
  });

  it("rejects invalid addresses with 400", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/claims/nope", headers: { "cf-connecting-ip": "10.0.0.3" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Bad Request");
  });

  it("rate limits per client key with Retry-After", async () => {
    const headers = { "x-forwarded-for": "203.0.113.9, 130.211.0.1" };
    let last;
    for (let i = 0; i < 6; i++) {
      last = await app.inject({ method: "GET", url: `/api/v1/claims/${ADDR.eoa}`, headers });
    }
    expect(last?.statusCode).toBe(429);
    expect(last?.headers["retry-after"]).toBeDefined();
    expect(last?.json().error).toBe("Too Many Requests");
    // a different Cloudflare-identified client is unaffected
    const other = await app.inject({
      method: "GET",
      url: `/api/v1/claims/${ADDR.eoa}`,
      headers: { "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": "203.0.113.9" },
    });
    expect(other.statusCode).toBe(200);
    // a different browser on the same IP is its own client; the address is not the limit
    const otherBrowser = await app.inject({
      method: "GET",
      url: `/api/v1/claims/${ADDR.eoa}`,
      headers: { "x-forwarded-for": "203.0.113.9, 130.211.0.1", "user-agent": "OtherBrowser/1.0" },
    });
    expect(otherBrowser.statusCode).toBe(200);
  });

  it("has no enumeration endpoints", async () => {
    for (const url of ["/api/v1/claims", "/api/v1/accounts", "/api/v1/claims/"]) {
      const res = await app.inject({ method: "GET", url, headers: { "cf-connecting-ip": "10.0.0.9" } });
      expect(res.statusCode).toBe(404);
    }
  });
});

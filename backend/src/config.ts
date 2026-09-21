export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  rateLimitMax: number;
  rateLimitWindow: string;
  exposeContractAmounts: boolean;
  logLevel: string;
  trustProxy: boolean;
  enforceDbPrivileges: boolean;
}

export interface ConfirmConfig {
  port: number;
  host: string;
  databaseUrl: string;
  rateLimitMax: number;
  rateLimitWindow: string;
  logLevel: string;
  trustProxy: boolean;
  enforceDbPrivileges: boolean;
  domain: string;
  challengeTtlSeconds: number;
}

function envBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

function assertProductionRole(env: NodeJS.ProcessEnv, urlName: string): void {
  if (env.NODE_ENV !== "production") return;
  if (!envBool(env, "ENFORCE_DB_PRIVILEGES", true)) {
    throw new Error("production refuses ENFORCE_DB_PRIVILEGES=false");
  }
  if (!env[urlName]) throw new Error(`production requires ${urlName}`);
  if (urlName !== "DATABASE_URL" && env.DATABASE_URL) {
    throw new Error("production refuses DATABASE_URL on an API process");
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  assertProductionRole(env, "CLAIM_READ_URL");
  const databaseUrl = env.CLAIM_READ_URL || env.DATABASE_URL;
  if (!databaseUrl) throw new Error("CLAIM_READ_URL is required");
  return {
    port: envInt(env, "PORT", 8081),
    host: env.HOST ?? "127.0.0.1",
    databaseUrl,
    rateLimitMax: envInt(env, "RATE_LIMIT_MAX", 30),
    rateLimitWindow: env.RATE_LIMIT_WINDOW ?? "1 minute",
    exposeContractAmounts: envBool(env, "EXPOSE_CONTRACT_AMOUNTS", false),
    logLevel: env.LOG_LEVEL ?? "info",
    trustProxy: envBool(env, "TRUST_PROXY", true),
    enforceDbPrivileges: envBool(env, "ENFORCE_DB_PRIVILEGES", true),
  };
}

export function loadConfirmConfig(env: NodeJS.ProcessEnv = process.env): ConfirmConfig {
  assertProductionRole(env, "CONFIRM_DATABASE_URL");
  const databaseUrl = env.CONFIRM_DATABASE_URL;
  if (!databaseUrl) throw new Error("CONFIRM_DATABASE_URL is required");
  if (env.CLAIM_READ_URL) throw new Error("confirm process refuses CLAIM_READ_URL");
  const domain = (env.CONFIRM_DOMAIN ?? "").trim();
  if (!domain || /[\s/]/.test(domain)) throw new Error("CONFIRM_DOMAIN must be a hostname");
  return {
    port: envInt(env, "PORT", 8082),
    host: env.HOST ?? "127.0.0.1",
    databaseUrl,
    rateLimitMax: envInt(env, "CONFIRM_RATE_LIMIT_MAX", 10),
    rateLimitWindow: env.CONFIRM_RATE_LIMIT_WINDOW ?? env.RATE_LIMIT_WINDOW ?? "1 minute",
    logLevel: env.LOG_LEVEL ?? "info",
    trustProxy: envBool(env, "TRUST_PROXY", true),
    enforceDbPrivileges: envBool(env, "ENFORCE_DB_PRIVILEGES", true),
    domain,
    challengeTtlSeconds: envInt(env, "CHALLENGE_TTL_SECONDS", 600),
  };
}

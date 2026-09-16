export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  rateLimitMax: number;
  rateLimitWindow: string;
  exposeContractAmounts: boolean;
  logLevel: string;
  trustProxy: boolean;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return {
    port: envInt("PORT", 8080),
    host: env.HOST ?? "0.0.0.0",
    databaseUrl,
    rateLimitMax: envInt("RATE_LIMIT_MAX", 30),
    rateLimitWindow: env.RATE_LIMIT_WINDOW ?? "1 minute",
    exposeContractAmounts: envBool("EXPOSE_CONTRACT_AMOUNTS", false),
    logLevel: env.LOG_LEVEL ?? "info",
    trustProxy: envBool("TRUST_PROXY", true),
  };
}

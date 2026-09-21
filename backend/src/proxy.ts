import http from "node:http";

export function upstreamFor(pathname: string): "confirm" | "claim" {
  return pathname === "/api/v1/confirmations" || pathname.startsWith("/api/v1/confirmations/")
    ? "confirm"
    : "claim";
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

export function startProxy(opts?: {
  port?: number;
  host?: string;
  claimUpstream?: string;
  confirmUpstream?: string;
}): http.Server {
  const port = opts?.port ?? envInt("PORT", 8080);
  const host = opts?.host ?? process.env.HOST ?? "127.0.0.1";
  const claimUpstream = opts?.claimUpstream ?? process.env.CLAIM_UPSTREAM ?? "http://127.0.0.1:8081";
  const confirmUpstream = opts?.confirmUpstream ?? process.env.CONFIRM_UPSTREAM ?? "http://127.0.0.1:8082";

  const server = http.createServer((req, res) => {
    const raw = req.url ?? "/";
    let pathname = "/";
    try {
      pathname = new URL(raw, "http://127.0.0.1").pathname;
    } catch {
      res.writeHead(400);
      res.end("bad request");
      return;
    }
    const base = new URL(upstreamFor(pathname) === "confirm" ? confirmUpstream : claimUpstream);
    const headers = { ...req.headers, host: base.host };
    const upstream = http.request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port,
        method: req.method,
        path: raw,
        headers,
        timeout: 10_000,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end("bad gateway");
    });
    req.pipe(upstream);
  });

  server.listen(port, host);
  return server;
}

const isDirect = process.argv[1] && /proxy\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  const server = startProxy();
  const address = server.address();
  const where = address && typeof address === "object" ? `${address.address}:${address.port}` : "proxy";
  console.log(`claim proxy listening on ${where}`);
}

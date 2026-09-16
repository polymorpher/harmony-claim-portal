import type { ApiError, ClaimResponse, MetaResponse } from "@hcp/shared";

const BASE = "/api";

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: "application/json" } });
  if (res.ok) return (await res.json()) as T;
  let message = res.statusText || `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as Partial<ApiError>;
    if (body.message) message = body.message;
  } catch {
    // non-JSON error body
  }
  const retry = res.headers.get("retry-after");
  throw new ApiRequestError(res.status, message, retry ? Number(retry) : null);
}

export const fetchMeta = () => request<MetaResponse>("/v1/meta");
export const fetchClaim = (address: string) =>
  request<ClaimResponse>(`/v1/claims/${encodeURIComponent(address.trim())}`);

import type {
  ApiError,
  ClaimResponse,
  ConfirmationChallenge,
  ConfirmationReceipt,
  ConfirmationStatus,
  MetaResponse,
} from "@hcp/shared";

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { accept: "application/json", ...init?.headers },
  });
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

function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const fetchMeta = () => request<MetaResponse>("/v1/meta");
export const fetchClaim = (address: string) =>
  request<ClaimResponse>(`/v1/claims/${encodeURIComponent(address.trim())}`);
export const fetchConfirmation = (address: string) =>
  request<ConfirmationStatus>(`/v1/confirmations/${encodeURIComponent(address.trim())}`);
export const createConfirmationChallenge = (address: string) =>
  postJson<ConfirmationChallenge>("/v1/confirmations/challenges", { address });
export const submitConfirmation = (
  address: string,
  nonce: string,
  issuedAt: string,
  signature: string,
  dataVersion: string,
  policyVersion: string,
) =>
  postJson<ConfirmationReceipt>("/v1/confirmations", {
    address,
    nonce,
    issued_at: issuedAt,
    signature,
    data_version: dataVersion,
    policy_version: policyVersion,
  });

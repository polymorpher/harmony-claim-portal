import { BaseError, UserRejectedRequestError } from "viem";
import type { Connector } from "wagmi";

function rejectedByUser(err: unknown): boolean {
  if (err instanceof BaseError && err.walk((e) => e instanceof UserRejectedRequestError)) return true;
  return (err as { code?: unknown } | null)?.code === 4001;
}

/** Text for a failed wallet connection. Closing the wallet's window is not an error. */
export function connectErrorText(err: Error | null): string | null {
  if (!err || rejectedByUser(err)) return null;
  return err instanceof BaseError ? err.shortMessage : err.message;
}

/** Text for a failed wallet signature, without viem's version and details suffix. */
export function walletErrorText(err: unknown): string | null {
  if (rejectedByUser(err)) return "The signature request was rejected in the wallet.";
  if (err instanceof BaseError) return err.shortMessage;
  return null;
}

/** Whether `connector` is the one a pending useConnect() call is connecting. */
export function isConnecting(pending: boolean, variables: { connector?: unknown } | undefined, connector: Connector): boolean {
  const target = variables?.connector as { uid?: string } | undefined;
  return pending && target?.uid === connector.uid;
}

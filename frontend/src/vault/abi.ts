import { parseAbi, parseAbiItem } from "viem";

/** GovernorDelegator (harmony-migration vault/contract/GovernorDelegator.sol). */
export const vaultAbi = parseAbi([
  "function asset() view returns (address)",
  "function governor() view returns (address)",
  "function feeBps() view returns (uint16)",
  "function balanceOf(address) view returns (uint256)",
  "function transferGovernor(address next)",
  "function setFeeBps(uint16 value)",
  "function deposit(uint256 amount, address delegator)",
  "function withdraw(uint256 amount, address delegator)",
  "event GovernorTransferred(address indexed previous, address indexed next)",
  "event FeeUpdated(uint16 previousFeeBps, uint16 newFeeBps)",
  "event Deposit(address indexed caller, address indexed delegator, uint256 assets)",
  // `caller`'s balance pays; `delegator` is the address that receives the tokens.
  "event Withdraw(address indexed caller, address indexed delegator, uint256 assets)",
]);

export const vaultEvents = vaultAbi.filter((item) => item.type === "event");

export const depositEvent = parseAbiItem("event Deposit(address indexed caller, address indexed delegator, uint256 assets)");

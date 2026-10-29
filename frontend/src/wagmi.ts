import { http, createConfig } from "wagmi";
import { arbitrum, base, bsc, harmonyOne, linea, mainnet, sepolia } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;

// WalletConnect explorer ids, shown first in the QR modal.
const LEDGER_WALLET = "19177a98252e07ddfc9af2083ba8e07ef627cb6103467ffebb3f8f4205fd7927";
const TRUST_WALLET = "4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0";
const METAMASK = "c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96";

// The claim and confirm pages only need the connected address and
// personal_sign; the vault page sends Ethereum transactions (Sepolia when its
// catalog is the rehearsal one), and the bridge page sends claims on Ethereum,
// BNB Chain, Arbitrum, Base and Linea. Harmony is listed so wallets that keep a
// separate Harmony account can offer it; WalletConnect requests every chain as
// optional.
export const wagmiConfig = createConfig({
  chains: [mainnet, harmonyOne, sepolia, bsc, arbitrum, base, linea],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [mainnet.id]: http(),
    [harmonyOne.id]: http(),
    [sepolia.id]: http(),
    [bsc.id]: http(),
    [arbitrum.id]: http(),
    [base.id]: http(),
    [linea.id]: http(),
  },
});

// Not in `connectors`: wagmi starts every listed connector on page load, which
// would download the WalletConnect and Reown code and contact their servers
// for every visitor. Pass this to connect() from the button instead. One
// factory keeps one WalletConnect provider across repeated clicks.
export const walletConnectConnector = projectId
  ? walletConnect({
      projectId,
      showQrModal: true,
      telemetryEnabled: false,
      qrModalOptions: {
        themeMode: "dark",
        explorerRecommendedWalletIds: [LEDGER_WALLET, TRUST_WALLET, METAMASK],
      },
      metadata: {
        name: "Harmony migration",
        description: "Look up a Harmony ONE migration claim, confirm wallet activity, use governor vaults, and claim bridge collateral",
        url: typeof window !== "undefined" ? window.location.origin : "https://migrate.country",
        icons: [],
      },
    })
  : null;

import { http, createConfig } from "wagmi";
import { mainnet } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;

// The portal only needs the connected address; no transactions are sent.
export const wagmiConfig = createConfig({
  chains: [mainnet],
  connectors: [
    injected({ shimDisconnect: true }),
    ...(projectId
      ? [
          walletConnect({
            projectId,
            showQrModal: true,
            metadata: {
              name: "Harmony migration claim lookup",
              description: "Look up your Harmony ONE migration claim",
              url: typeof window !== "undefined" ? window.location.origin : "https://migrate.country",
              icons: [],
            },
          }),
        ]
      : []),
  ],
  transports: {
    [mainnet.id]: http(),
  },
});

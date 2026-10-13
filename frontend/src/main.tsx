import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "./wagmi";
import { App } from "./App";
import { ConfirmPage } from "./ConfirmPage";
import { usePathname } from "./router";
import { VaultPage } from "./vault/VaultPage";
import "./styles.css";

function Root() {
  const path = usePathname();
  if (path === "/confirm") return <ConfirmPage />;
  if (path === "/vault" || path.startsWith("/vault/")) return <VaultPage path={path} />;
  return <App />;
}

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Root />
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);

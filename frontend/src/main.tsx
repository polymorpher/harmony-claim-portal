import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "./wagmi";
import { App } from "./App";
import { ConfirmPage } from "./ConfirmPage";
import "./styles.css";

function Root() {
  const path = typeof window === "undefined" ? "/" : window.location.pathname.replace(/\/+$/, "") || "/";
  return path === "/confirm" ? <ConfirmPage /> : <App />;
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

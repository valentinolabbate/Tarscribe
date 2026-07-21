import React from "react";
import ReactDOM from "react-dom/client";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { ToastProvider, toast } from "./components/Toast";
import { RecordingProvider } from "./hooks/useRecording";
import { installMenuAutoClose } from "./lib/menuAutoClose";
import "./styles.css";

installMenuAutoClose();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
  // Surface mutation failures as toasts instead of silent errors.
  mutationCache: new MutationCache({
    onError: (err) => toast((err as Error)?.message ?? "Ein Fehler ist aufgetreten", "error"),
  }),
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RecordingProvider>
          <App />
        </RecordingProvider>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);

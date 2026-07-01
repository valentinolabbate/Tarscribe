import { useCallback, useEffect, useState } from "react";
import { api, waitForBackend } from "../lib/api";
import { invoke, isTauri } from "../lib/tauri";

export function useAppBootstrap() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const [needsSetup, setNeedsSetup] = useState(false);
  const [needsEnv, setNeedsEnv] = useState(false);

  const proceed = useCallback(() => {
    waitForBackend()
      .then(async () => {
        try {
          const setup = await api.setupStatus();
          setNeedsSetup(!setup.setup_complete);
        } catch {
          /* ignore */
        }
        setReady(true);
      })
      .catch((err) => setError(String(err?.message ?? err)));
  }, []);

  useEffect(() => {
    (async () => {
      if (isTauri()) {
        const backendReady = await invoke<boolean>("is_backend_ready").catch(() => false);
        if (!backendReady) {
          const envReady = await invoke<boolean>("is_env_ready").catch(() => true);
          if (!envReady) {
            setNeedsEnv(true);
            return;
          }
        }
      }
      proceed();
    })();
  }, [proceed]);

  return { ready, error, needsSetup, setNeedsSetup, needsEnv, setNeedsEnv, proceed };
}

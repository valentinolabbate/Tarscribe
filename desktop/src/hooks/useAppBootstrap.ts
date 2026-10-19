import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { createBackendMonitor, type BackendConnection } from "../lib/backendMonitor";
import { invoke, isTauri } from "../lib/tauri";

export function useAppBootstrap() {
  const [ready, setReady] = useState(false);
  const [connection, setConnection] = useState<BackendConnection>({ status: "starting" });
  const [needsSetup, setNeedsSetup] = useState(false);
  const [needsEnv, setNeedsEnv] = useState(false);
  const [envChecked, setEnvChecked] = useState(false);
  const monitor = useRef<ReturnType<typeof createBackendMonitor> | null>(null);
  const queryClient = useQueryClient();

  const proceed = useCallback(() => {
    setNeedsEnv(false);
    setEnvChecked(true);
  }, []);

  useEffect(() => {
    let canceled = false;
    void (async () => {
      const envReady = !isTauri() || await invoke<boolean>("is_env_ready").catch(() => true);
      if (canceled) return;
      setNeedsEnv(!envReady);
      setEnvChecked(true);
    })();
    return () => { canceled = true; };
  }, []);

  useEffect(() => {
    if (!envChecked || needsEnv) return;
    const instance = createBackendMonitor(
      api.health,
      async () => { if (isTauri()) await invoke("restart_backend"); },
      setConnection,
    );
    monitor.current = instance;
    instance.start();
    return () => {
      instance.stop();
      monitor.current = null;
    };
  }, [envChecked, needsEnv]);

  useEffect(() => {
    if (connection.status !== "online") return;
    void queryClient.invalidateQueries();
  }, [connection.status, queryClient]);

  useEffect(() => {
    if (connection.status !== "online" || ready) return;
    let canceled = false;
    void api.setupStatus().then((setup) => {
      if (!canceled) setNeedsSetup(!setup.setup_complete);
    }).catch(() => {}).finally(() => {
      if (!canceled) setReady(true);
    });
    return () => { canceled = true; };
  }, [connection.status, ready]);

  const restart = useCallback(() => { void monitor.current?.restart(); }, []);

  return { ready, connection, restart, needsSetup, setNeedsSetup, needsEnv, setNeedsEnv, proceed };
}

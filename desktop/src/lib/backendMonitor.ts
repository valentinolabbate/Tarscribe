export type BackendConnection = {
  status: "starting" | "online" | "offline" | "restarting";
  error?: string;
};

export function createBackendMonitor(
  probe: () => Promise<unknown>,
  restartService: () => Promise<unknown>,
  onChange: (connection: BackendConnection) => void,
) {
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status: BackendConnection["status"] = "starting";
  let deadline = 0;
  let stopped = true;

  function update(connection: BackendConnection) {
    status = connection.status;
    onChange(connection);
  }

  async function check(current: number) {
    try {
      await probe();
      if (stopped || current !== revision) return;
      if (status !== "online") update({ status: "online" });
    } catch {
      if (stopped || current !== revision) return;
      if (status === "online" || Date.now() >= deadline) {
        update({ status: "offline", error: "Der lokale Tarscribe-Dienst antwortet nicht." });
      }
    }
    timer = setTimeout(() => void check(current), status === "starting" || status === "restarting" ? 1000 : 5000);
  }

  return {
    start() {
      stopped = false;
      clearTimeout(timer);
      deadline = Date.now() + 30000;
      update({ status: "starting" });
      void check(++revision);
    },
    stop() {
      stopped = true;
      revision++;
      clearTimeout(timer);
    },
    async restart() {
      if (stopped || status === "restarting") return;
      clearTimeout(timer);
      const current = ++revision;
      update({ status: "restarting" });
      try {
        await restartService();
        if (stopped || current !== revision) return;
        deadline = Date.now() + 30000;
        void check(current);
      } catch (error) {
        if (stopped || current !== revision) return;
        update({ status: "offline", error: `Neustart fehlgeschlagen: ${String(error instanceof Error ? error.message : error)}` });
        timer = setTimeout(() => void check(current), 5000);
      }
    },
  };
}

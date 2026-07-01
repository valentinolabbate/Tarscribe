export function Splash({ error }: { error?: string }) {
  return (
    <div className="splash">
      {error ? (
        <>
          <div className="big" style={{ color: "var(--danger)" }}>
            Backend nicht erreichbar
          </div>
          <div style={{ maxWidth: 360, textAlign: "center" }}>{error}</div>
        </>
      ) : (
        <>
          <div className="spinner" />
          <div>Tarscribe wird gestartet…</div>
        </>
      )}
    </div>
  );
}

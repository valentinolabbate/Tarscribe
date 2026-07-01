import type { Mode } from "./model";

export function ChatComposer({
  input,
  mode,
  chatAvailable,
  ragOff,
  searching,
  streaming,
  sessionLoading,
  onInputChange,
  onSubmit,
  onStop,
}: {
  input: string;
  mode: Mode;
  chatAvailable: boolean;
  ragOff: boolean;
  searching: boolean;
  streaming: boolean;
  sessionLoading: boolean;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
}) {
  return (
    <div className="chat-composer">
      <textarea
        value={input}
        onChange={(event) => onInputChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
        placeholder={
          mode === "search"
            ? "Suchbegriff oder Frage… (Enter zum Suchen)"
            : chatAvailable
              ? "Frage stellen… (Enter zum Senden, Shift+Enter = Zeilenumbruch)"
              : "Erst ein Chat-Modell in den Einstellungen wählen"
        }
        rows={2}
        disabled={ragOff || sessionLoading || (mode === "chat" && !chatAvailable)}
      />
      {mode === "chat" && streaming ? (
        <button className="btn" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button
          className="btn primary"
          onClick={onSubmit}
          disabled={!input.trim() || ragOff || searching || sessionLoading || (mode === "chat" && !chatAvailable)}
        >
          {mode === "search" ? "Suchen" : "Senden"}
        </button>
      )}
    </div>
  );
}

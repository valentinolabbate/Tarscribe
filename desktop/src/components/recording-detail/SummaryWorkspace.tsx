import type { RefObject } from "react";
import { ActionItemsPanel } from "../ActionItemsPanel";
import { SummaryPanel } from "../SummaryPanel";
import type { PlayerHandle } from "../AudioPlayer";
import { SummaryIcon, TasksIcon } from "../icons";

export function SummaryWorkspace({
  recordingId,
  recordingTitle,
  onOpenSettings,
  playerRef,
  onOpenRecording,
  onOpenDocument,
}: {
  recordingId: number;
  recordingTitle: string;
  onOpenSettings?: () => void;
  playerRef: RefObject<PlayerHandle | null>;
  onOpenRecording?: (recordingId: number, startSec?: number | null) => void;
  onOpenDocument?: (documentId: number) => void;
}) {
  const handleOpenSource = (sourceRecordingId: number, startSec?: number | null) => {
    if (sourceRecordingId === recordingId) {
      playerRef.current?.seek(startSec ?? 0);
    } else {
      onOpenRecording?.(sourceRecordingId, startSec);
    }
  };

  return (
    <section className="detail-panel summary-workspace">
      <div className="detail-panel-head">
        <div>
          <h2>Auswertung</h2>
          <p>Prüfe optional zuerst die Aufgaben und erstelle danach die Zusammenfassung.</p>
        </div>
        <SummaryIcon width={20} height={20} />
      </div>
      <div className="analysis-flow">
        <section className="analysis-step">
          <div className="analysis-step-head">
            <span className="analysis-step-number">1</span>
            <div className="analysis-step-copy">
              <h3><TasksIcon width={16} height={16} /> Aufgaben prüfen</h3>
              <p>Extrahieren und vor dem Zusammenfassen korrigieren. Danach werden sie direkt angehängt.</p>
            </div>
            <span className="analysis-optional">Optional</span>
          </div>
          <ActionItemsPanel recordingId={recordingId} />
        </section>
        <section className="analysis-step">
          <div className="analysis-step-head">
            <span className="analysis-step-number">2</span>
            <div className="analysis-step-copy">
              <h3><SummaryIcon width={16} height={16} /> Zusammenfassung erstellen</h3>
              <p>Das Modell fasst nur zusammen; vorhandene Aufgaben werden anschließend unverändert ergänzt.</p>
            </div>
          </div>
          <SummaryPanel
            recordingId={recordingId}
            recordingTitle={recordingTitle}
            onOpenSettings={onOpenSettings}
            onOpenSource={handleOpenSource}
            onOpenDocument={onOpenDocument}
          />
        </section>
      </div>
    </section>
  );
}

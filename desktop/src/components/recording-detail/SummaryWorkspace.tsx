import { ActionItemsPanel } from "../ActionItemsPanel";
import { SummaryPanel } from "../SummaryPanel";
import { SummaryIcon } from "../icons";

export function SummaryWorkspace({
  recordingId,
  onOpenSettings,
}: {
  recordingId: number;
  onOpenSettings?: () => void;
}) {
  return (
    <section className="detail-panel summary-workspace">
      <div className="detail-panel-head">
        <div>
          <h2>Zusammenfassung</h2>
          <p>Erstelle oder verwalte KI-Zusammenfassungen getrennt vom Transkript.</p>
        </div>
        <SummaryIcon width={20} height={20} />
      </div>
      <SummaryPanel recordingId={recordingId} onOpenSettings={onOpenSettings} />
      <ActionItemsPanel recordingId={recordingId} />
    </section>
  );
}

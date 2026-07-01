import { useDeleteKnownSpeaker, useKnownSpeakers } from "../../hooks/queries";
import { api } from "../../lib/api";
import type { AppSettings } from "../../lib/types";
import { SpeakerIdIcon, TrashIcon } from "../icons";

function KnownSpeakers() {
  const { data: speakers } = useKnownSpeakers();
  const del = useDeleteKnownSpeaker();
  return (
    <div className="field">
      <label>Bekannte Sprecher (Stimmproben)</label>
      {speakers && speakers.length > 0 ? (
        <div className="known-list">
          {speakers.map((speaker) => (
            <div className="known-item" key={speaker.id}>
              <span className="topic-dot" style={{ background: speaker.color }} />
              <SpeakerIdIcon width={15} height={15} />
              <span style={{ fontWeight: 550 }}>{speaker.name}</span>
              <span className="rec-sub">{speaker.sample_count} Probe(n)</span>
              <div style={{ flex: 1 }} />
              <button className="btn ghost danger" style={{ padding: 4 }} onClick={() => del.mutate(speaker.id)}>
                <TrashIcon width={15} height={15} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="rec-sub" style={{ fontSize: 12 }}>
          Noch keine. In einer Aufnahme bei einem Sprecher auf das Stimmen-Symbol klicken, um eine
          Stimmprobe zu speichern.
        </div>
      )}
    </div>
  );
}

export function SpeakersSettingsTab({
  settings,
  setSettings,
}: {
  settings: AppSettings;
  setSettings: (settings: AppSettings) => void;
}) {
  const { data: knownSpeakers } = useKnownSpeakers();
  return (
    <>
      <div className="settings-section-title">
        <span>Stimmen</span>
        <small>Gespeicherte Stimmen und Aufgaben-Zuordnung.</small>
      </div>
      <KnownSpeakers />

      <div className="field">
        <label>Das bin ich</label>
        <select
          value={settings.my_speaker_id ?? 0}
          onChange={(event) => {
            const value = Number(event.target.value);
            setSettings({ ...settings, my_speaker_id: value || null });
            api.updateSettings({ my_speaker_id: value });
          }}
        >
          <option value={0}>— Nicht festgelegt —</option>
          {(knownSpeakers ?? []).map((speaker) => (
            <option key={speaker.id} value={speaker.id}>
              {speaker.name}
            </option>
          ))}
        </select>
        <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 7, lineHeight: 1.5 }}>
          Der Aufgaben-Bereich zeigt standardmäßig nur Aufgaben und Entscheidungen, die
          diesem Sprecher zugeordnet sind. In jeder Aufnahme werden weiterhin alle
          Aufgaben extrahiert; andere lassen sich gezielt zu „Meine Aufgaben“ hinzufügen.
          {(knownSpeakers ?? []).length === 0 && " Lege zuerst über „Bekannte Sprecher“ eine Stimme an."}
        </div>
      </div>

      <div className="field">
        <label>Speaker-Match-Schwellenwert</label>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input
            type="range"
            min={0.1}
            max={0.95}
            step={0.05}
            value={settings.speaker_match_threshold ?? 0.5}
            style={{ flex: 1 }}
            onChange={(event) => {
              const value = Number(event.target.value);
              setSettings({ ...settings, speaker_match_threshold: value });
            }}
            onMouseUp={(event) => {
              api.updateSettings({ speaker_match_threshold: Number((event.target as HTMLInputElement).value) });
            }}
          />
          <span className="mono" style={{ width: 34 }}>
            {(settings.speaker_match_threshold ?? 0.5).toFixed(2)}
          </span>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 4, lineHeight: 1.5 }}>
          Wie ähnlich eine Stimme einem bekannten Sprecher sein muss, um als Match zu gelten (0 = immer, 1 = nur exakt).
        </div>
      </div>
    </>
  );
}

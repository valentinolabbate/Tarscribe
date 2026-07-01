export function ChatFilters({
  scoped,
  speakerFilter,
  dateFrom,
  dateTo,
  activeFilterCount,
  onSpeakerFilterChange,
  onDateFromChange,
  onDateToChange,
  onReset,
}: {
  scoped: boolean;
  speakerFilter: string;
  dateFrom: string;
  dateTo: string;
  activeFilterCount: number;
  onSpeakerFilterChange: (value: string) => void;
  onDateFromChange: (value: string) => void;
  onDateToChange: (value: string) => void;
  onReset: () => void;
}) {
  return (
    <div className="search-filters">
      <label>
        Sprecher
        <input
          type="text"
          value={speakerFilter}
          onChange={(event) => onSpeakerFilterChange(event.target.value)}
          placeholder="z. B. Anna"
        />
      </label>
      {!scoped && (
        <>
          <label>
            Von
            <input type="date" value={dateFrom} onChange={(event) => onDateFromChange(event.target.value)} />
          </label>
          <label>
            Bis
            <input type="date" value={dateTo} onChange={(event) => onDateToChange(event.target.value)} />
          </label>
        </>
      )}
      {activeFilterCount > 0 && (
        <button className="btn ghost" style={{ padding: "4px 10px", fontSize: 12 }} onClick={onReset}>
          Zurücksetzen
        </button>
      )}
    </div>
  );
}

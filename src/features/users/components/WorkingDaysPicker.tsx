export const WEEKDAYS = [
  { id: 1, label: "Thứ 2" },
  { id: 2, label: "Thứ 3" },
  { id: 3, label: "Thứ 4" },
  { id: 4, label: "Thứ 5" },
  { id: 5, label: "Thứ 6" },
  { id: 6, label: "Thứ 7" },
  { id: 7, label: "Chủ nhật" },
] as const;

export function WorkingDaysPicker({
  value,
  onChange,
}: {
  value: readonly number[];
  onChange: (next: number[]) => void;
}) {
  const toggle = (day: number) => {
    if (value.includes(day)) {
      onChange(value.filter((d) => d !== day));
    } else {
      onChange([...value, day].sort());
    }
  };

  return (
    <div className="row" style={{ flexWrap: "wrap", gap: "10px" }}>
      {WEEKDAYS.map((day) => (
        <label key={day.id} className="checkbox">
          <input
            type="checkbox"
            checked={value.includes(day.id)}
            onChange={() => toggle(day.id)}
          />
          {day.label}
        </label>
      ))}
    </div>
  );
}

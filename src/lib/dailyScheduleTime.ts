export function suggestedEndTime(start: string): string {
  const [hours, minutes] = start.split(":").map(Number);
  const end = Math.min(hours * 60 + minutes + 60, 1440);
  return `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
}

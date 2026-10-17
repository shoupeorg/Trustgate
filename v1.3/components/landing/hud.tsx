// Landing copy has no sentence-ending periods: sentences are joined with " · " like the HUD panels.
// Decimals (0.5 GEN) and names (V1.3) are untouched because only a period followed by a space or the end counts.
export function hudText(s: string) {
  return s
    .replace(/\s*\(([^)]*)\)/g, " · $1")
    .replace(/[.:;]\s+/g, " · ")
    .replace(/,\s+(?=[a-z])/g, " · ")
    .replace(/\.$/, "")
    .trim();
}

// A mandate is shown one sentence per line, without the final periods.
export function MandateLines({ text }: { text: string }) {
  const lines = text.split(/(?<=[.!?])\s+|\n+/).map((l) => l.trim().replace(/\.$/, "")).filter(Boolean);
  return (
    <>
      {lines.map((l, i) => (
        <span key={i} className="ml">{l}</span>
      ))}
    </>
  );
}

import { useSearchStore } from "../../state/search-store";

interface SearchHighlightsProps {
  pageIndex: number;
  scale: number;
}

/**
 * Match rects for one page. Rendered inside the page rotator, so geometry
 * is plain points × scale and rotation applies structurally.
 */
export function SearchHighlights({ pageIndex, scale }: SearchHighlightsProps) {
  const results = useSearchStore((s) => s.results);
  const currentIndex = useSearchStore((s) => s.currentIndex);

  const boxes: React.ReactNode[] = [];
  for (let i = 0; i < results.length; i++) {
    const match = results[i];
    if (match.pageIndex !== pageIndex) continue;
    const isCurrent = i === currentIndex;
    for (let j = 0; j < match.rects.length; j++) {
      const r = match.rects[j];
      boxes.push(
        <div
          key={`${i}-${j}`}
          style={{
            position: "absolute",
            left: r.x * scale,
            top: r.y * scale,
            width: r.width * scale,
            height: r.height * scale,
            background: isCurrent
              ? "rgba(255, 140, 0, 0.55)"
              : "rgba(255, 213, 0, 0.35)",
            outline: isCurrent ? "2px solid rgba(255, 100, 0, 0.9)" : "none",
            pointerEvents: "none",
            mixBlendMode: "multiply",
          }}
        />,
      );
    }
  }

  if (boxes.length === 0) return null;
  return <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>{boxes}</div>;
}

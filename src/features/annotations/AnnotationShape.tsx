import type { Annotation } from "../../lib/annotations";

/** One annotation as SVG, in page-point coordinates (unrotated). Mirrors
 * the /AP streams the engine writes so screen and saved file agree. */
export function AnnotationShape({
  annotation: a,
  selected,
}: {
  annotation: Annotation;
  selected: boolean;
}) {
  const sel = selected ? (
    <SelectionOutline annotation={a} />
  ) : null;

  switch (a.kind) {
    case "highlight":
      return (
        <>
          {a.quads.map((q, i) => (
            <rect
              key={i}
              x={q.x}
              y={q.y}
              width={q.width}
              height={q.height}
              fill={a.color}
              fillOpacity={a.opacity}
            />
          ))}
          {sel}
        </>
      );
    case "underline":
    case "strikeout":
      return (
        <>
          {a.quads.map((q, i) => {
            const y = a.kind === "strikeout" ? q.y + q.height * 0.55 : q.y + q.height * 0.92;
            return (
              <line
                key={i}
                x1={q.x}
                y1={y}
                x2={q.x + q.width}
                y2={y}
                stroke={a.color}
                strokeOpacity={a.opacity}
                strokeWidth={Math.max(q.height * 0.07, 0.7)}
              />
            );
          })}
          {sel}
        </>
      );
    case "ink":
      return (
        <>
          {a.strokes.map((s, i) => (
            <polyline
              key={i}
              points={s.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              stroke={a.color}
              strokeOpacity={a.opacity}
              strokeWidth={a.strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {sel}
        </>
      );
    case "note":
      return (
        <>
          <g>
            <title>{`${a.author}: ${a.contents}`}</title>
            <rect
              x={a.at.x + 1}
              y={a.at.y + 1}
              width={18}
              height={16}
              rx={2}
              fill={a.color}
              stroke="#00000055"
            />
            <path
              d={`M ${a.at.x + 5} ${a.at.y + 17} l 4 4 l 0 -4`}
              fill={a.color}
              stroke="#00000055"
            />
          </g>
          {sel}
        </>
      );
    case "rect":
      return (
        <>
          <rect
            x={a.rect.x}
            y={a.rect.y}
            width={a.rect.width}
            height={a.rect.height}
            fill={a.fill ?? "none"}
            stroke={a.color}
            strokeOpacity={a.opacity}
            strokeWidth={a.strokeWidth}
          />
          {sel}
        </>
      );
    case "ellipse":
      return (
        <>
          <ellipse
            cx={a.rect.x + a.rect.width / 2}
            cy={a.rect.y + a.rect.height / 2}
            rx={a.rect.width / 2}
            ry={a.rect.height / 2}
            fill={a.fill ?? "none"}
            stroke={a.color}
            strokeOpacity={a.opacity}
            strokeWidth={a.strokeWidth}
          />
          {sel}
        </>
      );
    case "line":
    case "arrow":
      return (
        <>
          <line
            x1={a.from.x}
            y1={a.from.y}
            x2={a.to.x}
            y2={a.to.y}
            stroke={a.color}
            strokeOpacity={a.opacity}
            strokeWidth={a.strokeWidth}
            strokeLinecap="round"
          />
          {a.kind === "arrow" && <ArrowHead annotation={a} />}
          {sel}
        </>
      );
    case "stamp": {
      const { x, y, width, height } = a.rect;
      return (
        <>
          <g stroke={a.color} strokeWidth={2} fill="none">
            <rect x={x + 1} y={y + 1} width={width - 2} height={height - 2} />
            <StampGlyph annotation={a} />
          </g>
          {sel}
        </>
      );
    }
  }
}

function ArrowHead({
  annotation: a,
}: {
  annotation: Extract<Annotation, { kind: "line" | "arrow" }>;
}) {
  const dx = a.to.x - a.from.x;
  const dy = a.to.y - a.from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const head = Math.max(a.strokeWidth * 4, 8);
  const p1 = {
    x: a.to.x - head * (ux * 0.866 - uy * 0.5),
    y: a.to.y - head * (uy * 0.866 + ux * 0.5),
  };
  const p2 = {
    x: a.to.x - head * (ux * 0.866 + uy * 0.5),
    y: a.to.y - head * (uy * 0.866 - ux * 0.5),
  };
  return (
    <path
      d={`M ${p1.x} ${p1.y} L ${a.to.x} ${a.to.y} L ${p2.x} ${p2.y}`}
      fill="none"
      stroke={a.color}
      strokeOpacity={a.opacity}
      strokeWidth={a.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

function StampGlyph({
  annotation: a,
}: {
  annotation: Extract<Annotation, { kind: "stamp" }>;
}) {
  const { x, y, width, height } = a.rect;
  const cx = x + width / 2;
  const cy = y + height / 2;
  const u = Math.max(Math.min(width, height) / 2 - 6, 4);
  switch (a.stamp) {
    case "approved":
      return (
        <path
          d={`M ${cx - u} ${cy} L ${cx - u * 0.2} ${cy + u * 0.6} L ${cx + u} ${cy - u * 0.6}`}
          strokeWidth={3}
        />
      );
    case "rejected":
      return (
        <path
          d={`M ${cx - u} ${cy - u} L ${cx + u} ${cy + u} M ${cx - u} ${cy + u} L ${cx + u} ${cy - u}`}
          strokeWidth={3}
        />
      );
    case "draft":
      return <path d={`M ${cx - u} ${cy} L ${cx + u} ${cy}`} strokeWidth={3} />;
    default:
      return (
        <rect x={cx - u} y={cy - u * 0.4} width={u * 2} height={u * 0.8} strokeWidth={3} />
      );
  }
}

function SelectionOutline({ annotation: a }: { annotation: Annotation }) {
  const b = bounds(a);
  return (
    <rect
      x={b.x - 3}
      y={b.y - 3}
      width={b.width + 6}
      height={b.height + 6}
      fill="none"
      stroke="var(--accent-soft)"
      strokeWidth={1}
      strokeDasharray="4 3"
      vectorEffect="non-scaling-stroke"
    />
  );
}

function bounds(a: Annotation): { x: number; y: number; width: number; height: number } {
  switch (a.kind) {
    case "highlight":
    case "underline":
    case "strikeout": {
      const xs = a.quads.flatMap((q) => [q.x, q.x + q.width]);
      const ys = a.quads.flatMap((q) => [q.y, q.y + q.height]);
      return box(xs, ys);
    }
    case "ink": {
      const pts = a.strokes.flat();
      return box(pts.map((p) => p.x), pts.map((p) => p.y));
    }
    case "note":
      return { x: a.at.x, y: a.at.y, width: 20, height: 22 };
    case "rect":
    case "ellipse":
    case "stamp":
      return a.rect;
    case "line":
    case "arrow":
      return box([a.from.x, a.to.x], [a.from.y, a.to.y]);
  }
}

function box(xs: number[], ys: number[]) {
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

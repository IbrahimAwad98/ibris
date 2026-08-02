import type { Size } from "../../lib/coords";
import {
  removeRedaction,
  useDocumentStore,
  type PendingRedaction,
} from "../../state/document-store";

const RED = "#c62828";

/** The hatch pattern for pending marks; one per SVG, referenced by id. */
export function RedactionHatch({ id }: { id: string }) {
  return (
    <defs>
      <pattern
        id={id}
        width={6}
        height={6}
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <rect width={6} height={6} fill="rgba(198, 40, 40, 0.12)" />
        <line x1={0} y1={0} x2={0} y2={6} stroke="rgba(198, 40, 40, 0.5)" strokeWidth={2} />
      </pattern>
    </defs>
  );
}

/**
 * A pending redaction mark. Deliberately NOT a filled black box: the page
 * content stays visible through the hatch and the mark is labelled, so a
 * screenshot of the pending state cannot pass for a completed redaction.
 * The content is only removed — and engine-verified gone — at a confirmed
 * save.
 */
export function RedactionMarkShape({
  rect,
  hatchId,
}: {
  rect: PendingRedaction["rect"];
  hatchId: string;
}) {
  const showLabel = rect.width > 90 && rect.height > 13;
  return (
    <g>
      <rect
        x={rect.x}
        y={rect.y}
        width={rect.width}
        height={rect.height}
        fill={`url(#${hatchId})`}
        stroke={RED}
        strokeWidth={1.5}
        strokeDasharray="4 3"
      />
      {showLabel && (
        <text
          x={rect.x + rect.width / 2}
          y={rect.y + rect.height / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={8}
          fontFamily="sans-serif"
          fontWeight={700}
          fill={RED}
          stroke="#ffffff"
          strokeWidth={2.5}
          paintOrder="stroke"
        >
          REDACTS ON SAVE
        </text>
      )}
    </g>
  );
}

interface Props {
  pageIndex: number;
  pagePt: Size;
  scale: number;
}

/** SVG overlay for this page's pending redaction marks, each with an ×
 * control that unmarks it (an undoable command, like every edit). */
export function RedactionLayer({ pageIndex, pagePt, scale }: Props) {
  const redactions = useDocumentStore((s) => s.redactions);
  const execute = useDocumentStore((s) => s.execute);
  const marks = Object.values(redactions).filter(
    (r) => r.pageIndex === pageIndex,
  );
  if (marks.length === 0) return null;
  const hatchId = `redact-hatch-${pageIndex}`;
  return (
    <svg
      width={pagePt.width * scale}
      height={pagePt.height * scale}
      viewBox={`0 0 ${pagePt.width} ${pagePt.height}`}
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      data-redaction-layer
    >
      <RedactionHatch id={hatchId} />
      {marks.map((r) => {
        const cx = r.rect.x + r.rect.width;
        const cy = r.rect.y;
        return (
          <g key={r.id}>
            <RedactionMarkShape rect={r.rect} hatchId={hatchId} />
            <g
              style={{ pointerEvents: "auto", cursor: "pointer" }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => execute(removeRedaction(r))}
            >
              <title>Remove this redaction mark (nothing has been redacted yet)</title>
              <circle cx={cx} cy={cy} r={6} fill={RED} />
              <path
                d={`M ${cx - 2.5} ${cy - 2.5} L ${cx + 2.5} ${cy + 2.5} M ${cx - 2.5} ${cy + 2.5} L ${cx + 2.5} ${cy - 2.5}`}
                stroke="#ffffff"
                strokeWidth={1.5}
              />
            </g>
          </g>
        );
      })}
    </svg>
  );
}

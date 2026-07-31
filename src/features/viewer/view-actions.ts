// Store-driven view operations shared by the Toolbar and the command
// registry, so both surfaces do exactly the same thing.
import {
  PAGE_GAP,
  pageOrderOf,
  pageRotation,
  useViewerStore,
} from "../../state/viewer-store";
import { fitPageScale, fitWidthScale, zoomIn, zoomOut } from "../../lib/zoom";

function viewerEl(): HTMLDivElement | null {
  return document.querySelector<HTMLDivElement>("[data-viewer-area]");
}

function centreAnchor(): { x: number; y: number } {
  const el = viewerEl();
  return el ? { x: el.clientWidth / 2, y: el.clientHeight / 2 } : { x: 0, y: 0 };
}

export function zoomInCentred(): void {
  const s = useViewerStore.getState();
  s.setScale(zoomIn(s.scale), { anchor: centreAnchor() });
}

export function zoomOutCentred(): void {
  const s = useViewerStore.getState();
  s.setScale(zoomOut(s.scale), { anchor: centreAnchor() });
}

/** Back to 100% ("actual size"). */
export function resetZoom(): void {
  useViewerStore.getState().setScale(1, { anchor: centreAnchor() });
}

export function fitTo(mode: "width" | "page"): void {
  const el = viewerEl();
  const s = useViewerStore.getState();
  const pt = s.pages[pageOrderOf(s)[s.currentPage]];
  if (!el || !pt) return;
  const rot = pageRotation(s, s.currentPage);
  const target =
    mode === "width"
      ? fitWidthScale(el.clientWidth, pt, rot, PAGE_GAP)
      : fitPageScale(
          { width: el.clientWidth, height: el.clientHeight },
          pt,
          rot,
          PAGE_GAP,
        );
  s.setScale(target, { fitMode: mode, anchor: centreAnchor() });
}

export function rotateCurrentPage(): void {
  const s = useViewerStore.getState();
  s.rotatePage(s.currentPage);
}

export function rotateDocument(): void {
  useViewerStore.getState().rotateDoc();
}

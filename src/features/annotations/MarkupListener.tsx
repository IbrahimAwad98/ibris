import { useEffect } from "react";
import { pageRotation, useViewerStore } from "../../state/viewer-store";
import { useToolStore } from "../../state/tool-store";
import { markupFromSelection } from "./annotate";

/**
 * Mounted once per viewer: with a markup tool active, releasing the mouse
 * turns the current text selection into highlight/underline/strikethrough
 * annotations — one command per page the selection touches.
 */
export function MarkupListener() {
  useEffect(() => {
    const onPointerUp = () => {
      // Defer one tick so the browser finalises the selection first.
      setTimeout(() => {
        const tool = useToolStore.getState().tool;
        if (tool !== "highlight" && tool !== "underline" && tool !== "strikeout") {
          return;
        }
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const viewer = useViewerStore.getState();
        let created = false;
        document
          .querySelectorAll<HTMLElement>("[data-page-el]")
          .forEach((el) => {
            const pageIndex = Number(el.dataset.pageEl);
            const pagePt = viewer.pages[pageIndex];
            if (!pagePt) return;
            created =
              markupFromSelection(
                el,
                pageIndex,
                pagePt,
                viewer.scale,
                pageRotation(viewer, pageIndex),
                tool,
              ) || created;
          });
        if (created) sel.removeAllRanges();
      }, 0);
    };
    window.addEventListener("pointerup", onPointerUp);
    return () => window.removeEventListener("pointerup", onPointerUp);
  }, []);
  return null;
}

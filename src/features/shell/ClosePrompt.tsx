import { showError } from "../../ipc/dialog";
import { sidecarDelete } from "../../ipc/sidecar";
import { saveErrorMessage } from "../../lib/pdf-error";
import {
  cancelSidecarWrite,
  saveDocument,
} from "../../state/annotation-io";
import { useTabsStore } from "../../state/tabs-store";
import { useUiStore } from "../../state/ui-store";

/** Save / Discard / Cancel before closing a tab with unsaved changes. */
export function ClosePrompt() {
  const tabId = useUiStore((s) => s.closePrompt);
  const tabs = useTabsStore((s) => s.tabs);
  if (tabId === null) return null;
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) {
    useUiStore.getState().setClosePrompt(null);
    return null;
  }

  const dismiss = () => useUiStore.getState().setClosePrompt(null);
  const save = async () => {
    dismiss();
    const saved = await saveDocument(tab.path).catch((e: unknown) => {
      void showError(saveErrorMessage(e), "Save failed");
      return false; // the tab stays open; nothing was written
    });
    if (saved) void useTabsStore.getState().closeTab(tabId);
  };
  const discard = () => {
    dismiss();
    cancelSidecarWrite();
    void sidecarDelete(tab.path).catch(() => undefined);
    void useTabsStore.getState().closeTab(tabId);
  };

  return (
    <div className="palette-backdrop" onMouseDown={dismiss}>
      <div
        className="palette close-prompt"
        role="alertdialog"
        aria-label="Unsaved changes"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <p>
          <strong>{tab.title}</strong> has unsaved changes.
        </p>
        <div className="close-prompt-actions">
          <button className="btn-primary" onClick={() => void save()}>
            Save
          </button>
          <button className="btn-secondary" onClick={discard}>
            Discard changes
          </button>
          <button className="btn-secondary" onClick={dismiss}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

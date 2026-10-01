/** Keep browser commands from bypassing the workbench's save/leave coordination. */
export function installDesktopBehavior() {
  function handleKeyDown(event: KeyboardEvent) {
    if (event.isComposing) return;
    const key = event.key.toLowerCase();
    const browserCommand = (event.ctrlKey || event.metaKey) && !event.altKey
      && ["r", "p", "u", "s"].includes(key);
    const navigation = event.altKey && !event.ctrlKey && !event.metaKey
      && ["arrowleft", "arrowright"].includes(key);
    if (key === "f5" || key === "browserback" || key === "browserforward" || browserCommand || navigation) {
      // Do not stop propagation: editor Ctrl+S handlers still own saving.
      event.preventDefault();
    }
  }

  function handleContextMenu(event: MouseEvent) {
    const target = event.target;
    // Preserve the platform's editing menu, including IME/spelling and clipboard
    // actions. Read-only document text remains selectable and copyable with Ctrl+C.
    const textControl = target instanceof Element && target.closest("input, textarea");
    const editable = target instanceof HTMLElement && target.isContentEditable;
    if (!textControl && !editable) event.preventDefault();
  }

  window.addEventListener("keydown", handleKeyDown, true);
  document.addEventListener("contextmenu", handleContextMenu);
  return () => {
    window.removeEventListener("keydown", handleKeyDown, true);
    document.removeEventListener("contextmenu", handleContextMenu);
  };
}

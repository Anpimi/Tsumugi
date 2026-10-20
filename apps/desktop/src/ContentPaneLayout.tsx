import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Group, Panel, Separator, type GroupImperativeHandle, type Layout, type LayoutChangedMeta } from "react-resizable-panels";
import { useWorkbenchState } from "./WorkbenchFrame";
import "./ContentPaneLayout.css";

type Mode = "wide" | "compact" | "narrow";
type Pane = "list" | "editor";
type Gesture = { group: GroupImperativeHandle; element: HTMLDivElement; layout: Layout; pointer: number; mode: Mode; cancelled: boolean };
const gutter = 24;

/** Group layouts use percentages of panel space, excluding the separator. */
function availableSize(element: HTMLDivElement | null, horizontal: boolean) {
  if (!element) return 0;
  const rect = element.getBoundingClientRect(), extent = horizontal ? rect.width : rect.height;
  if (extent <= 0) return 0;
  const separators = Array.from(element.children).filter(child => child.hasAttribute("data-separator"));
  return extent - separators.reduce((total, child) => {
    const rect = child.getBoundingClientRect(); return total + (horizontal ? rect.width : rect.height);
  }, 0);
}

export interface ContentPaneLayoutHandle {
  editorVisible: () => boolean;
  focusVisible: () => void;
}

/** Kept with the workbench even when its import tab has no content layout mounted. */
export function useContentPaneIntent() {
  const [pane, setPane] = useWorkbenchState<Pane>("translation", "paneLayout.narrow.pane", "list");
  const choiceVersion = useRef(0), alive = useRef(false);
  const [revealVersion, setRevealVersion] = useState(0);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const choosePane = useCallback((next: Pane) => { choiceVersion.current++; setPane(next); }, [setPane]);
  const retainEditor = useCallback(() => setPane("editor"), [setPane]);
  const captureEditorReveal = useCallback(() => {
    const version = choiceVersion.current;
    return () => {
      if (!alive.current || version !== choiceVersion.current) return;
      setPane("editor"); setRevealVersion(value => value + 1);
    };
  }, [setPane]);
  return { pane, choosePane, retainEditor, captureEditorReveal, revealVersion };
}

/** View geometry only. Business reads, editor identity and drafts stay with their original owners. */
export function ContentPaneLayout({ list, editor, references, hasEditor, referencesOpen, composing, active,
  editorFocus, onEditorVisibilityChange, intent, ref }: {
  list: ReactNode; editor: ReactNode; references: ReactNode; hasEditor: boolean; referencesOpen: boolean;
  composing: boolean; active: boolean; editorFocus: RefObject<HTMLTextAreaElement | null>;
  onEditorVisibilityChange: (visible: boolean) => void; intent: ReturnType<typeof useContentPaneIntent>; ref?: Ref<ContentPaneLayoutHandle>;
}) {
  const { t } = useTranslation(), id = useId();
  const [wideList, setWideList] = useWorkbenchState("translation", "paneLayout.wide.listWidth", 288);
  const [wideReferences, setWideReferences] = useWorkbenchState("translation", "paneLayout.wide.referenceWidth", 288);
  const [compactList, setCompactList] = useWorkbenchState("translation", "paneLayout.compact.listWidth", 240);
  const [compactReferences, setCompactReferences] = useWorkbenchState<number | null>("translation", "paneLayout.compact.referenceHeight", null);
  const [narrowReferences, setNarrowReferences] = useWorkbenchState<number | null>("translation", "paneLayout.narrow.referenceHeight", null);
  const columns = useRef<HTMLDivElement>(null), listPane = useRef<HTMLDivElement>(null), detail = useRef<HTMLDivElement>(null), referenceGroup = useRef<HTMLDivElement>(null);
  const editorPane = useRef<HTMLDivElement>(null), referencePane = useRef<HTMLDivElement>(null), paneButtons = useRef<HTMLDivElement>(null);
  const listSeparator = useRef<HTMLDivElement>(null), outer = useRef<GroupImperativeHandle>(null), inner = useRef<GroupImperativeHandle>(null);
  const alive = useRef(false), focusRequested = useRef(false), gesture = useRef<Gesture | null>(null);
  const measured = useRef({ width: 0, height: 0 });
  const [size, setSize] = useState(measured.current);
  const [detailSize, setDetailSize] = useState({ width: 0, height: 0 }), [closedReferenceHeight, setClosedReferenceHeight] = useState(0);
  const [gestureCancelled, setGestureCancelled] = useState(false);
  const mode: Mode = size.width >= 1100 ? "wide" : size.width > 0 && size.width < 660 ? "narrow" : "compact";
  const pane = hasEditor && (composing || intent.pane === "editor") ? "editor" : "list";
  const editorVisible = mode !== "narrow" || pane === "editor", listVisible = mode !== "narrow" || pane === "list";
  const previouslyVisible = useRef(editorVisible), seenReveal = useRef(intent.revealVersion);
  const referenceSide = mode === "wide" && hasEditor && referencesOpen;
  const hasReferences = hasEditor && references !== null, disabled = !active || composing || gestureCancelled;
  const height = detailSize.height || size.height;
  const editorMinimum = referenceSide ? 360 : Math.min(240, height * .6);
  const referenceMaximum = referenceSide ? 400 : Math.max(0, Math.min(280, Math.floor(height * .4), height - gutter - editorMinimum));
  const referenceMinimum = referenceSide ? 200 : Math.min(96, referenceMaximum);
  const preferredList = mode === "wide" ? wideList : compactList;
  const preferredReference = referenceSide ? wideReferences : (mode === "compact" ? compactReferences : narrowReferences) ?? Math.round(height * .25);

  // The library ends cancelled gestures at their current size. Preserve this
  // product's rollback by restoring its starting layout, without sizing math.
  const cancelGesture = useCallback(() => {
    const captured = gesture.current;
    if (!captured) return;
    captured.cancelled = true;
    if (alive.current && captured.element.isConnected) {
      captured.group.setLayout(captured.layout);
      // Disable the library interaction as well: a resize alone does not end it.
      setGestureCancelled(true);
    }
  }, []);
  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; gesture.current = null; };
  }, []);
  useLayoutEffect(() => {
    const element = columns.current, nested = referenceGroup.current;
    if (!element || !nested) return;
    const measure = (width: number, height: number) => {
      if (width <= 0 || height <= 0 || (width === measured.current.width && height === measured.current.height)) return;
      cancelGesture(); measured.current = { width, height }; setSize(measured.current);
    };
    const rect = element.getBoundingClientRect(); measure(rect.width, rect.height);
    const observer = new ResizeObserver(entries => {
      const entry = entries.find(value => value.target === element);
      if (entry) measure(entry.contentRect.width, entry.contentRect.height);
      const inner = entries.find(value => value.target === nested)?.contentRect;
      if (inner && inner.width > 0 && inner.height > 0) setDetailSize(before => before.width === inner.width && before.height === inner.height ? before : { width: inner.width, height: inner.height });
    });
    observer.observe(element); observer.observe(nested);
    return () => observer.disconnect();
  }, [cancelGesture]);
  useLayoutEffect(() => { cancelGesture(); }, [mode, active, composing, referencesOpen, cancelGesture]);
  useLayoutEffect(() => {
    const element = referencePane.current?.querySelector<HTMLElement>(".editor-references");
    if (!element || !hasReferences || referencesOpen) return;
    const measure = () => { const height = element.getBoundingClientRect().height; if (height > 0) setClosedReferenceHeight(height); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [hasReferences, referencesOpen]);
  useLayoutEffect(() => {
    const available = availableSize(columns.current, true);
    if (available <= 0) return;
    const list = mode === "narrow" ? listVisible ? 100 : 0 : preferredList / available * 100;
    outer.current?.setLayout({ [`${id}-list`]: list, [`${id}-detail`]: 100 - list });
  }, [id, mode, listVisible, preferredList, size.width, referenceSide, gestureCancelled]);
  useLayoutEffect(() => {
    const available = availableSize(referenceGroup.current, referenceSide);
    if (available <= 0) return;
    const reference = !hasReferences ? 0 : (referencesOpen ? preferredReference : closedReferenceHeight) / available * 100;
    inner.current?.setLayout({ [`${id}-editor`]: 100 - reference, [`${id}-references`]: reference });
  }, [id, mode, editorVisible, referenceSide, hasReferences, referencesOpen, closedReferenceHeight, preferredReference, detailSize.width, detailSize.height, size.height, gestureCancelled]);
  useLayoutEffect(() => {
    const element = columns.current, win = element?.ownerDocument.defaultView;
    if (!element || !win) return;
    const begin = (event: globalThis.PointerEvent) => {
      if (disabled || gesture.current || event.button !== 0 || event.isPrimary === false || !(event.target instanceof Element)) return;
      const separator = event.target.closest("[data-separator]"), groupElement = separator?.closest<HTMLDivElement>("[data-group]");
      const group = groupElement === columns.current ? outer.current : groupElement === referenceGroup.current ? inner.current : null;
      if (!separator || !group || !groupElement || availableSize(groupElement, groupElement === columns.current || referenceSide) <= 0) return;
      gesture.current = { group, element: groupElement, pointer: event.pointerId, mode, layout: group.getLayout(), cancelled: false };
    };
    const finish = (event: globalThis.PointerEvent) => {
      const captured = gesture.current;
      if (!captured || captured.pointer !== event.pointerId) return;
      if (captured.cancelled && captured.element.isConnected) captured.group.setLayout(captured.layout);
      queueMicrotask(() => { if (gesture.current === captured) { gesture.current = null; if (alive.current) setGestureCancelled(false); } });
    };
    const cancel = (event: globalThis.PointerEvent) => { if (gesture.current?.pointer === event.pointerId) { cancelGesture(); finish(event); } };
    const endWindowGesture = () => {
      const captured = gesture.current;
      cancelGesture();
      queueMicrotask(() => { if (gesture.current === captured) { gesture.current = null; if (alive.current) setGestureCancelled(false); } });
    };
    const blur = (event: Event) => { if (event.target === event.currentTarget) endWindowGesture(); };
    // Window capture precedes the library's document capture completion callback.
    win.addEventListener("pointerdown", begin, true); win.addEventListener("pointerup", finish, true);
    win.addEventListener("pointercancel", cancel, true); win.addEventListener("lostpointercapture", cancel, true);
    win.addEventListener("blur", blur, true); win.addEventListener("pagehide", endWindowGesture, true);
    return () => {
      win.removeEventListener("pointerdown", begin, true); win.removeEventListener("pointerup", finish, true);
      win.removeEventListener("pointercancel", cancel, true); win.removeEventListener("lostpointercapture", cancel, true);
      win.removeEventListener("blur", blur, true); win.removeEventListener("pagehide", endWindowGesture, true);
    };
  }, [mode, disabled, referenceSide, cancelGesture]);
  // Composition already derives a visible editor. Retain that choice after the
  // workbench owner's layout effects have made its memory setter available.
  useEffect(() => { if (composing && hasEditor) intent.retainEditor(); }, [composing, hasEditor, intent.retainEditor]);
  useLayoutEffect(() => { onEditorVisibilityChange(editorVisible); }, [editorVisible, onEditorVisibilityChange]);

  function focusVisible() {
    if (!active) return;
    if (editorVisible) (editorFocus.current ?? editorPane.current)?.focus({ preventScroll: true });
    else {
      const current = listPane.current?.querySelector<HTMLElement>(".translation-entry[aria-current='true']:not(:disabled)")
        ?? listPane.current?.querySelector<HTMLElement>(".translation-entry:not(:disabled), button:not(:disabled)");
      (current ?? listPane.current)?.focus({ preventScroll: true });
    }
  }
  useLayoutEffect(() => {
    const revealFocus = seenReveal.current !== intent.revealVersion && !previouslyVisible.current;
    seenReveal.current = intent.revealVersion; previouslyVisible.current = editorVisible;
    if (!active) return;
    const focused = document.activeElement;
    const hiddenFocus = (!editorVisible && !!focused && detail.current?.contains(focused))
      || (!listVisible && !!focused && listPane.current?.contains(focused))
      || (mode === "narrow" && focused === listSeparator.current)
      || (mode !== "narrow" && !!focused && paneButtons.current?.contains(focused));
    if (focusRequested.current || hiddenFocus || revealFocus) { focusRequested.current = false; focusVisible(); }
  }, [active, editorVisible, listVisible, mode, hasEditor, intent.revealVersion]);
  useImperativeHandle(ref, () => ({
    editorVisible: () => active && editorVisible,
    focusVisible,
  }));
  function choosePane(next: Pane) {
    if (composing || (next === "editor" && !hasEditor)) return;
    intent.choosePane(next); cancelGesture();
    if (next === pane) { focusRequested.current = false; focusVisible(); }
    else focusRequested.current = true;
  }
  function changed(boundary: "list" | "references", layout: Layout, meta: LayoutChangedMeta) {
    if (!alive.current || disabled || !meta.isUserInteraction || gesture.current?.cancelled || gesture.current && gesture.current.mode !== mode) return;
    if (boundary === "list" && mode === "narrow" || boundary === "references" && (!hasReferences || !referencesOpen)) return;
    const available = availableSize(boundary === "list" ? columns.current : referenceGroup.current, boundary === "list" || referenceSide);
    const percentage = (meta.requestedLayout ?? layout)[`${id}-${boundary}`];
    if (available <= 0 || percentage === undefined) return;
    const pixels = Math.round(percentage / 100 * available);
    if (boundary === "list") (mode === "wide" ? setWideList : setCompactList)(pixels);
    else if (referenceSide) setWideReferences(pixels);
    else (mode === "compact" ? setCompactReferences : setNarrowReferences)(pixels);
  }
  return <div className="content-pane-layout" data-mode={mode}>
    <div className="content-pane-modes" ref={paneButtons} hidden={mode !== "narrow"} role="group" aria-label={t("contentPaneLayout.views")}>
      <button type="button" className="secondary-button" disabled={composing} aria-pressed={pane === "list"} aria-controls={`${id}-list`} onClick={() => choosePane("list")}>{t("contentPaneLayout.list")}</button>
      <button type="button" className="secondary-button" disabled={composing || !hasEditor} aria-pressed={pane === "editor"} aria-controls={`${id}-editor`} onClick={() => choosePane("editor")}>{t("contentPaneLayout.editor")}</button>
    </div>
    <Group elementRef={columns} groupRef={outer} className="translation-columns" disabled={disabled || mode === "narrow"}
      onKeyDownCapture={event => {
        if (event.nativeEvent.isComposing && event.target instanceof Element && event.target.closest("[data-separator]")) {
          event.preventDefault(); event.stopPropagation();
        }
      }}
      onLayoutChanged={(layout, meta) => changed("list", layout, meta)}>
      <Panel id={`${id}-list`} elementRef={listPane} tabIndex={-1} className="content-pane-list" hidden={!listVisible}
        minSize={mode === "narrow" ? listVisible ? "100%" : 0 : 200} maxSize={mode === "narrow" ? listVisible ? "100%" : 0 : 400}
        defaultSize={preferredList} groupResizeBehavior="preserve-pixel-size">{list}</Panel>
      <Separator elementRef={listSeparator} className="content-pane-separator" hidden={mode === "narrow"} disabled={disabled || mode === "narrow"} disableDoubleClick
        aria-label={t("contentPaneLayout.resizeList")}/>
      <Panel id={`${id}-detail`} elementRef={detail} hidden={!editorVisible} className="translation-detail-panel"
        minSize={mode === "narrow" ? editorVisible ? "100%" : 0 : referenceSide ? 360 + 200 + gutter : 360}
        maxSize={mode === "narrow" && !editorVisible ? 0 : "100%"}>
        <Group elementRef={referenceGroup} groupRef={inner} className="translation-detail" orientation={referenceSide ? "horizontal" : "vertical"} disabled={disabled || !hasReferences || !referencesOpen}
          data-reference-side={referenceSide} data-reference-open={hasReferences && referencesOpen} onLayoutChanged={(layout, meta) => changed("references", layout, meta)}>
          <Panel id={`${id}-editor`} elementRef={editorPane} tabIndex={-1} className="content-pane-editor" minSize={referencesOpen && hasReferences ? editorMinimum : 0}>{editor}</Panel>
          <Separator className="content-pane-separator" hidden={!hasReferences || !referencesOpen} disabled={disabled || !hasReferences || !referencesOpen} disableDoubleClick
            aria-label={t(referenceSide ? "contentPaneLayout.resizeReferenceWidth" : "contentPaneLayout.resizeReferenceHeight")}/>
          <Panel id={`${id}-references`} elementRef={referencePane} className="content-pane-references" hidden={!hasReferences} groupResizeBehavior="preserve-pixel-size"
            defaultSize={preferredReference} minSize={!hasReferences ? 0 : referencesOpen ? referenceMinimum : closedReferenceHeight}
            maxSize={!hasReferences ? 0 : referencesOpen ? referenceMaximum : closedReferenceHeight}>{references}</Panel>
        </Group>
      </Panel>
    </Group>
  </div>;
}

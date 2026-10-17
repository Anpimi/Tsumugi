import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type Ref, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbenchState } from "./WorkbenchFrame";
import "./ContentPaneLayout.css";

type Mode = "wide" | "compact" | "narrow";
type Pane = "list" | "editor";
type Boundary = "list" | "references";
type Bounds = { min: number; max: number; value: number };
type Drag = { boundary: Boundary; mode: Mode; pointer: number; element: HTMLDivElement; start: number; initial: number; value: number; direction: number; bounds: Bounds };
const gutter = 24;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

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
  const { t, i18n } = useTranslation(), id = useId();
  const [wideList, setWideList] = useWorkbenchState("translation", "paneLayout.wide.listWidth", 288);
  const [wideReferences, setWideReferences] = useWorkbenchState("translation", "paneLayout.wide.referenceWidth", 288);
  const [compactList, setCompactList] = useWorkbenchState("translation", "paneLayout.compact.listWidth", 240);
  const [compactReferences, setCompactReferences] = useWorkbenchState<number | null>("translation", "paneLayout.compact.referenceHeight", null);
  const [narrowReferences, setNarrowReferences] = useWorkbenchState<number | null>("translation", "paneLayout.narrow.referenceHeight", null);
  const columns = useRef<HTMLDivElement>(null), listPane = useRef<HTMLDivElement>(null), detail = useRef<HTMLDivElement>(null);
  const editorPane = useRef<HTMLDivElement>(null), referencePane = useRef<HTMLDivElement>(null), paneButtons = useRef<HTMLDivElement>(null);
  const listSeparator = useRef<HTMLDivElement>(null), referenceSeparator = useRef<HTMLDivElement>(null);
  const alive = useRef(false), focusRequested = useRef(false), drag = useRef<Drag | null>(null);
  const measured = useRef({ width: 0, height: 0 });
  const [size, setSize] = useState(measured.current);
  const [preview, setPreview] = useState<{ boundary: Boundary; mode: Mode; value: number } | null>(null);
  // An unmeasured or hidden container retains the previous valid geometry.
  const width = size.width || 800, height = size.height || 600;
  const mode: Mode = size.width >= 1100 ? "wide" : size.width > 0 && size.width < 660 ? "narrow" : "compact";
  const pane = hasEditor && (composing || intent.pane === "editor") ? "editor" : "list";
  const editorVisible = mode !== "narrow" || pane === "editor", listVisible = mode !== "narrow" || pane === "list";
  const previouslyVisible = useRef(editorVisible), seenReveal = useRef(intent.revealVersion);
  const referenceSide = mode === "wide" && hasEditor && referencesOpen;
  const temporary = (boundary: Boundary, preferred: number) => preview?.mode === mode && preview.boundary === boundary ? preview.value : preferred;
  const listMax = Math.max(200, Math.min(400, width - gutter - 360 - (referenceSide ? 200 + gutter : 0)));
  const listWidth = clamp(temporary("list", mode === "wide" ? wideList : compactList), 200, listMax);
  const referenceMax = referenceSide ? Math.max(200, Math.min(400, width - listWidth - 2 * gutter - 360))
    : Math.max(0, Math.min(280, Math.floor(height * .4), height - gutter - Math.min(240, height * .6)));
  const referenceMin = referenceSide ? 200 : Math.min(96, referenceMax);
  const preferredReference = mode === "wide" ? wideReferences : (mode === "compact" ? compactReferences : narrowReferences) ?? Math.round(height * .25);
  const referenceSize = clamp(temporary("references", preferredReference), referenceMin, referenceMax);
  const listBounds: Bounds = { min: 200, max: Math.max(200, Math.min(400, width - gutter - 360 - (referenceSide ? referenceSize + gutter : 0))), value: listWidth };
  const referenceBounds: Bounds = { min: referenceMin, max: referenceMax, value: referenceSize };

  const cancelDrag = useCallback(() => {
    const captured = drag.current;
    drag.current = null;
    if (captured?.element.hasPointerCapture(captured.pointer)) captured.element.releasePointerCapture(captured.pointer);
    if (alive.current) setPreview(null);
  }, []);
  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; cancelDrag(); };
  }, [cancelDrag]);
  useLayoutEffect(() => {
    const element = columns.current;
    if (!element) return;
    const measure = (width: number, height: number) => {
      if (width <= 0 || height <= 0 || (width === measured.current.width && height === measured.current.height)) return;
      cancelDrag(); measured.current = { width, height }; setSize(measured.current);
    };
    const rect = element.getBoundingClientRect(); measure(rect.width, rect.height);
    const observer = new ResizeObserver(entries => {
      const entry = entries.find(value => value.target === element);
      if (entry) measure(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [cancelDrag]);
  useLayoutEffect(() => { cancelDrag(); }, [mode, active, composing, referencesOpen, cancelDrag]);
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
    intent.choosePane(next); cancelDrag();
    if (next === pane) { focusRequested.current = false; focusVisible(); }
    else focusRequested.current = true;
  }
  function commit(boundary: Boundary, value: number) {
    if (boundary === "list") (mode === "wide" ? setWideList : setCompactList)(Math.round(value));
    else if (mode === "wide") setWideReferences(Math.round(value));
    else (mode === "compact" ? setCompactReferences : setNarrowReferences)(Math.round(value));
  }
  function start(event: PointerEvent<HTMLDivElement>, boundary: Boundary, bounds: Bounds) {
    if (!active || composing || drag.current || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    const horizontal = boundary === "list" || referenceSide;
    drag.current = { boundary, mode, pointer: event.pointerId, element: event.currentTarget, start: horizontal ? event.clientX : event.clientY,
      initial: bounds.value, value: bounds.value, bounds, direction: boundary === "list" ? 1 : -1 };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const captured = drag.current;
    if (!captured || captured.pointer !== event.pointerId) return;
    const horizontal = captured.boundary === "list" || captured.mode === "wide";
    captured.value = clamp(captured.initial + ((horizontal ? event.clientX : event.clientY) - captured.start) * captured.direction, captured.bounds.min, captured.bounds.max);
    setPreview({ boundary: captured.boundary, mode: captured.mode, value: captured.value });
  }
  function finish(event: PointerEvent<HTMLDivElement>) {
    const captured = drag.current;
    if (!captured || captured.pointer !== event.pointerId) return;
    move(event);
    drag.current = null;
    if (captured.mode === mode) commit(captured.boundary, captured.value);
    if (captured.element.hasPointerCapture(captured.pointer)) captured.element.releasePointerCapture(captured.pointer);
    setPreview(null);
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>, boundary: Boundary, bounds: Bounds) {
    if (!active || composing || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const horizontal = boundary === "list" || referenceSide, step = event.shiftKey ? 40 : 10;
    const direction = boundary === "list" ? 1 : -1;
    const change = event.key === (horizontal ? "ArrowRight" : "ArrowDown") ? step * direction
      : event.key === (horizontal ? "ArrowLeft" : "ArrowUp") ? -step * direction : null;
    if (change === null && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault(); cancelDrag();
    commit(boundary, event.key === "Home" ? bounds.min : event.key === "End" ? bounds.max : clamp(bounds.value + (change ?? 0), bounds.min, bounds.max));
  }
  function separator(boundary: Boundary, bounds: Bounds, hidden: boolean) {
    const horizontal = boundary === "list" || referenceSide;
    return <div ref={boundary === "list" ? listSeparator : referenceSeparator} className={`content-pane-separator content-pane-separator-${boundary}`}
      hidden={hidden} role="separator" tabIndex={composing || !active ? -1 : 0} aria-disabled={composing || !active}
      aria-label={t(boundary === "list" ? "contentPaneLayout.resizeList" : horizontal ? "contentPaneLayout.resizeReferenceWidth" : "contentPaneLayout.resizeReferenceHeight")}
      aria-orientation={horizontal ? "vertical" : "horizontal"} aria-controls={`${id}-${boundary}`}
      aria-valuemin={Math.round(bounds.min)} aria-valuemax={Math.round(bounds.max)} aria-valuenow={Math.round(bounds.value)}
      aria-valuetext={t("contentPaneLayout.pixels", { value: new Intl.NumberFormat(i18n.language).format(Math.round(bounds.value)) })}
      onPointerDown={event => start(event, boundary, bounds)} onPointerMove={move} onPointerUp={finish}
      onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag} onKeyDown={event => keyboard(event, boundary, bounds)} />;
  }
  const hasReferences = hasEditor && references !== null;
  return <div className="content-pane-layout" data-mode={mode}>
    <div className="content-pane-modes" ref={paneButtons} hidden={mode !== "narrow"} role="group" aria-label={t("contentPaneLayout.views")}>
      <button type="button" className="secondary-button" disabled={composing} aria-pressed={pane === "list"} aria-controls={`${id}-list`} onClick={() => choosePane("list")}>{t("contentPaneLayout.list")}</button>
      <button type="button" className="secondary-button" disabled={composing || !hasEditor} aria-pressed={pane === "editor"} aria-controls={`${id}-editor`} onClick={() => choosePane("editor")}>{t("contentPaneLayout.editor")}</button>
    </div>
    <div ref={columns} className="translation-columns" style={{ gridTemplateColumns: mode === "narrow" ? "minmax(0, 1fr)" : `${listWidth}px ${gutter}px minmax(0, 1fr)` }}>
      <div id={`${id}-list`} ref={listPane} tabIndex={-1} className="content-pane-list" hidden={!listVisible}>{list}</div>
      {separator("list", listBounds, mode === "narrow")}
      <div ref={detail} className="translation-detail" hidden={!editorVisible} data-reference-side={referenceSide} data-reference-open={hasReferences && referencesOpen}
        style={{ gridTemplateColumns: referenceSide ? `minmax(0, 1fr) ${gutter}px ${referenceSize}px` : "minmax(0, 1fr)",
          gridTemplateRows: referenceSide || !hasReferences ? "minmax(0, 1fr)" : referencesOpen ? `minmax(0, 1fr) ${gutter}px ${referenceSize}px` : "minmax(0, 1fr) auto" }}>
        <div id={`${id}-editor`} ref={editorPane} tabIndex={-1} className="content-pane-editor">{editor}</div>
        {separator("references", referenceBounds, !hasReferences || !referencesOpen)}
        <div id={`${id}-references`} ref={referencePane} className="content-pane-references" hidden={!hasReferences}>{references}</div>
      </div>
    </div>
  </div>;
}

import { useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import type { GroupImperativeHandle } from "react-resizable-panels";
import { Sheet, type DialogProps } from "../design-system/Dialog";
import { SplitHandle, SplitPanel, SplitView } from "../design-system/SplitView";
import type { WorkspaceView } from "./workspace/workspaceStore";
import styles from "./WorkspacePanes.module.css";

type PaneView = Pick<WorkspaceView, "id" | "conversationMode" | "dockSize" | "conversationViewSize">;

/** A fixed portal target keeps the Agent consumer mounted when its drawer closes. */
function PersistentDock({ children, compact, conversationMode, elementRef, label, drawer }: {
  children: ReactNode;
  compact: boolean;
  conversationMode: boolean;
  elementRef: Ref<HTMLDivElement>;
  label: string;
  drawer: Omit<DialogProps, "children">;
}) {
  const inlineHost = useRef<HTMLDivElement>(null);
  const [drawerHost, setDrawerHost] = useState<HTMLDivElement | null>(null);
  const [container] = useState(() => {
    const element = document.createElement("div");
    element.className = styles.portal;
    element.tabIndex = -1;
    return element;
  });
  useImperativeHandle(elementRef, () => container, [container]);
  useLayoutEffect(() => {
    const host = drawer.open && drawerHost ? drawerHost : inlineHost.current;
    if (host && container.parentElement !== host) host.appendChild(container);
  }, [container, drawer.open, drawerHost]);
  return <>
    <aside className={styles.dock} aria-label={label} hidden={compact && !conversationMode}>
      <div className={styles.inlineHost} ref={inlineHost}/>
    </aside>
    <Sheet {...drawer}><div className={styles.drawerHost} ref={setDrawerHost}/></Sheet>
    {createPortal(children, container)}
  </>;
}

/** Layout alone changes here; view, conversation, draft and execution owners stay put. */
export function WorkspacePanes({ view, compact, wide, disabled, dockRef, label, resizeLabel, drawer, dock, children, onResize }: {
  view: PaneView | null;
  compact: boolean;
  wide: boolean;
  disabled: boolean;
  dockRef: Ref<HTMLDivElement>;
  label: string;
  resizeLabel: string;
  drawer: Omit<DialogProps, "children">;
  dock: ReactNode;
  children: ReactNode;
  onResize: (patch: Pick<WorkspaceView, "dockSize"> | Pick<WorkspaceView, "conversationViewSize">) => void;
}) {
  const element = useRef<HTMLDivElement>(null), separator = useRef<HTMLDivElement>(null), group = useRef<GroupImperativeHandle>(null);
  const preferred = useRef(view);
  const conversationMode = view?.conversationMode ?? false;
  useLayoutEffect(() => { preferred.current = view; });
  useLayoutEffect(() => {
    const restore = () => {
      const available = (element.current?.clientWidth ?? 0) - (compact ? 0 : separator.current?.getBoundingClientRect().width ?? 0);
      if (available <= 0) return;
      if (compact) {
        group.current?.setLayout({ "workspace-main": conversationMode ? 0 : 100, "workspace-dock": conversationMode ? 100 : 0 });
        return;
      }
      const pixels = conversationMode ? preferred.current?.conversationViewSize ?? 340 : preferred.current?.dockSize ?? (wide ? 380 : 340);
      const secondary = Math.min(Math.max(pixels, 300), available * .45) / available * 100;
      group.current?.setLayout({ "workspace-main": conversationMode ? secondary : 100 - secondary, "workspace-dock": conversationMode ? 100 - secondary : secondary });
    };
    restore();
    const observer = new ResizeObserver(restore);
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, [view?.id, conversationMode, compact, wide]);
  const mainPanel = <SplitPanel key="current-view" id="workspace-main"
    minSize={conversationMode && !compact ? 300 : 0} maxSize={conversationMode ? compact ? 0 : "45%" : "100%"}
    groupResizeBehavior={conversationMode ? "preserve-pixel-size" : "preserve-relative-size"}>
    <div className={styles.current} hidden={compact && conversationMode} inert={compact && conversationMode}>{children}</div>
  </SplitPanel>;
  const dockPanel = <SplitPanel key="agent" id="workspace-dock"
    groupResizeBehavior={conversationMode ? "preserve-relative-size" : "preserve-pixel-size"}
    defaultSize={compact ? conversationMode ? "100%" : 0 : view?.dockSize ?? (wide ? 380 : 340)}
    minSize={!compact && !conversationMode ? 300 : 0} maxSize={compact && !conversationMode ? 0 : conversationMode ? "100%" : "45%"}>
    <PersistentDock compact={compact} conversationMode={conversationMode} elementRef={dockRef} label={label} drawer={drawer}>{dock}</PersistentDock>
  </SplitPanel>;
  const handle = <SplitHandle key="separator" label={resizeLabel} elementRef={separator} style={compact ? { display: "none" } : undefined} disabled={compact || disabled}/>;
  return <SplitView id={`workspace-panes-${view?.id ?? "empty"}-${conversationMode ? "conversation" : "workspace"}-${compact ? "narrow" : wide ? "wide" : "compact"}`}
    className={styles.group} elementRef={element} groupRef={group} data-conversation-mode={conversationMode || undefined} disabled={disabled || compact}
    onLayoutChanged={(layout, meta) => {
      if (!meta.isUserInteraction || !view || compact) return;
      const available = (element.current?.clientWidth ?? 0) - (separator.current?.getBoundingClientRect().width ?? 0);
      const percentage = (meta.requestedLayout ?? layout)[conversationMode ? "workspace-main" : "workspace-dock"];
      if (available <= 0 || percentage === undefined) return;
      const pixels = Math.round(percentage / 100 * available);
      if (conversationMode) { if (pixels !== view.conversationViewSize) onResize({ conversationViewSize: pixels }); }
      else if (pixels !== view.dockSize) onResize({ dockSize: pixels });
    }}>
    {conversationMode ? [dockPanel, handle, mainPanel] : [mainPanel, handle, dockPanel]}
  </SplitView>;
}

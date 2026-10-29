import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import { Button } from "../../../design-system/Button";
import { recentProjectName, type RecentProject } from "../../../recentProjects";
import type { InteractionGate } from "../../workspace/interactionGate";
import styles from "../../WorkbenchApp.module.css";

export default function Welcome({ recent, restoreCandidate, native, blocked, gate, onOpen, onChoose, onManual, onOpenExisting, onSettings, onExtensions }: {
  recent: RecentProject[]; restoreCandidate: RecentProject | null; native: boolean; blocked: boolean; gate: InteractionGate;
  onOpen: (locator: string) => void; onChoose: () => void; onManual: () => void; onOpenExisting: () => void; onSettings?: () => void; onExtensions?: () => void;
}) {
  const { t, i18n } = useTranslation(undefined, { keyPrefix: "startup" });
  const latest = recent[0] ?? restoreCandidate;
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Enter" || event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || blocked || !native || !latest || !(event.target instanceof HTMLElement)
        || event.target.closest("input, textarea, select, button, a, [contenteditable=true], [role=dialog]")
        || !gate.canDispatch({ viewId: null, source: "keyboard" })) return;
      event.preventDefault(); onOpen(latest.locator);
    };
    document.addEventListener("keydown", keydown); return () => document.removeEventListener("keydown", keydown);
  }, [blocked, native, latest?.locator, gate, onOpen]);
  const date = (value: number) => Number.isFinite(value) && Number.isFinite(new Date(value).getTime())
    ? new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: "medium", timeStyle: "short" }).format(value) : t("openedTimeUnknown");
  return <main className={styles.welcome} onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}>
    <span className={styles.brand}>紡 Tsumugi</span>
    <button type="button" className={styles.dropZone} aria-label={t("chooseAndPrepare")} disabled={!native || blocked} onClick={onChoose}>
      <FolderOpen aria-hidden="true"/><span>{t("dropFolder")}</span><small>{t("chooseAndPrepare")}</small>
    </button>
    {latest ? <p className={styles.resume}>{t("continueRecent", { name: recentProjectName(latest.locator) })} <kbd>⏎</kbd></p> : null}
    {recent.length ? <section className={styles.recent}><h2>{t("recentTitle")}</h2>{recent.map(item => <Button key={item.locator} disabled={!native || blocked} onClick={() => onOpen(item.locator)}>
      <span>{recentProjectName(item.locator)}</span><small title={item.locator}>{item.locator}</small><time dateTime={Number.isFinite(item.lastOpenedAt) && Number.isFinite(new Date(item.lastOpenedAt).getTime()) ? new Date(item.lastOpenedAt).toISOString() : undefined}>{t("lastOpened", { time: date(item.lastOpenedAt) })}</time>
    </Button>)}</section> : null}
    <div className={styles.welcomeActions}><Button disabled={!native || blocked} onClick={onOpenExisting}>{t("openExisting")}</Button><Button disabled={!native || blocked} onClick={onManual}>{t("manual")}</Button>{onSettings ? <Button disabled={blocked} onClick={onSettings}>{i18n.t("settingsWorkbench.title")}</Button> : null}{onExtensions ? <Button disabled={blocked || !native} onClick={onExtensions}>{i18n.t("plugins.title")}</Button> : null}</div>
  </main>;
}

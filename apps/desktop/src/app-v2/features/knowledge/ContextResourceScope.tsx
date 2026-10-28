import { useEffect, useId, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../design-system/Button";
import { Dialog } from "../../../design-system/Dialog";
import { Field, TextInput } from "../../../design-system/Field";
import { Banner, ErrorState, LoadingState } from "../../../design-system/Feedback";
import type { ContextResourceScope as Scope } from "../../../resourceCommands";
import type { ContentPage, ContentScope } from "../../../sourceCommands";
import type { ProjectView } from "../../../projectCommands";
import type { InteractionGate } from "../../workspace/interactionGate";
import TermScopePicker from "./TermScopePicker";
import { sameContentScope } from "./contextResourceReads";
import styles from "./Knowledge.module.css";
export { ContextResourceScopeText as ContextScopeText } from "../../../ContextResourceCapturePreview";
import { ContextResourceScopeText } from "../../../ContextResourceCapturePreview";

/** UTF-8 byte order matches the Core path contract, including non-BMP paths. */
export function compareResourcePaths(left: string, right: string) {
  const encoder = new TextEncoder(), a = encoder.encode(left), b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
}
export default function ContextResourceScope({ project, locale, value, basis, source, files, fresh, failed, onRefresh, disabled, gate, current, onChange, unselected = false }: {
  project: ProjectView; locale: string; value: Scope; basis: ContentScope; source: ContentScope | undefined; files: ContentPage | undefined;
  fresh: () => boolean; failed: boolean; onRefresh: () => void; disabled: boolean; gate: InteractionGate; current: (dialogId?: string) => boolean; onChange: (scope: Scope) => void;
  unselected?: boolean;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "knowledge" });
  const [open, setOpen] = useState(false), [paths, setPaths] = useState<string[]>([]), [search, setSearch] = useState("");
  const dialogId = useId(); useSyncExternalStore(gate.subscribe, gate.getSnapshot, gate.getSnapshot);
  useLayoutEffect(() => open ? gate.pushDialog(dialogId) : undefined, [open, gate, dialogId]);
  useEffect(() => () => gate.releaseOwner(dialogId), [gate, dialogId]);
  const available = () => !disabled && current(dialogId) && fresh() && !!source && !!files && sameContentScope(source, basis) && sameContentScope(files.scope, basis) && files.snapshotId === basis.currentSnapshot;
  const allPaths = [...new Set(files?.coverage.filter(file => file.role === "source").map(file => file.logicalPath) ?? [])].sort(compareResourcePaths);
  const byteSize = paths.reduce((sum, path) => sum + new TextEncoder().encode(path).length, 0);
  return <section><h3>{t("scope")}</h3>{unselected ? <p>{t("knowledgeScopeUnset")}</p> : <ContextResourceScopeText scope={value}/>}<p className={styles.meta}>{t("contextScopeRules")}</p>
    <div className={styles.actions}><Button disabled={disabled || !unselected && value.kind === "project" || !fresh()} onClick={() => { if (current() && fresh()) onChange({ kind: "project" }); }}>{t("changeScope")}</Button>
      <Button disabled={disabled} onClick={() => { if (current()) { setPaths(value.kind === "file-group" ? [...value.logicalPaths] : []); setOpen(true); } }}>{t("contextChooseFiles")}</Button>
      <TermScopePicker project={project} locale={locale} disabled={disabled} gate={gate} current={current} onSelect={unitId => onChange({ kind: "unit", unitId })}/></div>
    {value.kind === "file-group" ? <p className={styles.meta}>{t("contextFilesHelp")}</p> : null}
    <Dialog open={open} onOpenChange={next => { if (next || gate.getSnapshot().composingOwners.length === 0) setOpen(next); }} title={t("contextChooseFiles")} description={t("contextFilesHelp")} closeLabel={t("close")}>
      <div onCompositionStartCapture={() => gate.setComposing(dialogId, true)} onCompositionEndCapture={() => gate.setComposing(dialogId, false)} onFocusCapture={() => gate.setInputOwner(gate.getSnapshot().visibleViewId, dialogId)}>
        <Field label={t("contextFindFile")}><TextInput value={search} onChange={event => setSearch(event.target.value)}/></Field>
        {failed ? <ErrorState title={t("contextSourceFailed")} action={<Button onClick={() => { if (current(dialogId)) onRefresh(); }}>{t("refresh")}</Button>}/> : !files ? <LoadingState label={t("readingEntries")}/> : !available() ? <Banner tone="warning">{t("contextSourceChanged")}</Banner> : null}
        <ul className={styles.scopeResults}>{allPaths.filter(path => path.includes(search)).map(path => <li key={path}><Field label={path}><TextInput type="checkbox" disabled={!available()} checked={paths.includes(path)} onChange={event => { if (available()) setPaths(before => event.target.checked ? [...before, path] : before.filter(value => value !== path)); }}/></Field></li>)}</ul>
        {paths.some(path => !allPaths.includes(path)) ? <Banner tone="warning">{t("contextMissingFiles")}<ul>{paths.filter(path => !allPaths.includes(path)).map(path => <li key={path}>{path}<Button onClick={() => { if (current(dialogId)) setPaths(before => before.filter(value => value !== path)); }}>{t("contextRemoveFile")}</Button></li>)}</ul></Banner> : null}
        <p>{t("contextFilesCount", { count: paths.length })}</p>{paths.length > 128 || byteSize > 8192 ? <Banner tone="warning">{t("contextFilesLimit")}</Banner> : null}
        <Button variant="primary" disabled={!available() || paths.length === 0 || paths.length > 128 || byteSize > 8192 || paths.some(path => !allPaths.includes(path))} onClick={() => {
          if (!available() || !files) return; onChange({ kind: "file-group", namespace: files.namespace, logicalPaths: [...paths].sort(compareResourcePaths) }); setOpen(false);
        }}>{t("contextUseFiles")}</Button>
      </div>
    </Dialog>
  </section>;
}

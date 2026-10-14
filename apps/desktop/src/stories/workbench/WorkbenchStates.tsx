import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, CheckCheck, PackageCheck, Save, ShieldCheck, TriangleAlert } from "lucide-react";
import { i18n } from "../../i18n";
import brand from "../../../src-tauri/icons/icon.svg";
import "./workbench-states.css";

export type PreviewState = "ready" | "empty" | "no-results" | "loading" | "error" | "denied" | "dirty" | "saving" | "conflict" | "unknown" | "partial";
export interface WorkbenchStatesProps { view: "editor" | "delivery" | "plugins"; state: PreviewState; theme: "light" | "dark"; locale: "en-US" | "zh-CN"; scale: 1 | 2 }
// Public repository corpus: core/tests/fixtures/stardew-lookup/i18n/default.json.
const source = "For each pedestal, place the item dropped by gem birds in the corresponding island location when it rains. The items are randomized for each save.\n\n{{hayCount}} of {{maxHayInLocation}} hay in this location (max capacity in this building: {{maxHayInBuilding}})\n\nWhether to highlight item gift tastes which haven't been revealed in the NPC profile. When enabled, unrevealed gift tastes will be bold.";
const translation = "下雨时，将宝石鸟掉落的物品放到对应岛屿地点的石台上。每个存档中的物品都不同，请按照当前存档记录逐项核对。\n\n此地点有 {{hayCount}} / {{maxHayInLocation}} 份干草（建筑容量：{{maxHayInBuilding}}）。请保留变量、换行和源文件的键名。\n\n是否高亮尚未在 NPC 档案中发现的礼物偏好。启用后，未发现的偏好会以粗体显示。组合字符 é 与 👩🏽‍💻 保持原样。";
const keys = ["puzzle.island-shrine.solution", "building.stored-hay.summary", "config.highlight-unrevealed-gift-tastes.desc"];

/** Isolated presentation candidates; no application bridges, grants or persisted facts. */
export function WorkbenchStates({ view, state, theme, locale, scale }: WorkbenchStatesProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(state === "dirty" ? translation + "\n\n待核对的新输入。" : translation);
  const [saved, setSaved] = useState(translation), [pending, setPending] = useState(false), [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0), [consent, setConsent] = useState(false), [approvedPreview, setApprovedPreview] = useState(false);
  const [notice, setNotice] = useState<"saved" | "newer" | "none">("none");
  const [recoveryPreview, setRecoveryPreview] = useState(false), [buildPreview, setBuildPreview] = useState(false);
  const latestText = useRef(text), saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null), input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { void i18n.changeLanguage(locale); }, [locale]);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);
  const dirty = text !== saved;
  const busy = pending || state === "saving" || state === "loading";
  const blocked = state === "denied" || state === "conflict" || state === "unknown";
  const deliveryBlocked = state !== "ready";
  function save(next = false) {
    if (pending || blocked || busy || !dirty) return;
    const submitted = latestText.current; setPending(true); setNotice("none");
    saveTimer.current = setTimeout(() => {
      setSaved(submitted); setPending(false);
      if (latestText.current !== submitted) { setNotice("newer"); return; }
      setNotice("saved");
      if (next) { setSelected(index => Math.min(index + 1, keys.length - 1)); input.current?.focus({ preventScroll: true }); }
    }, 600);
  }
  const visibleKeys = state === "empty" || state === "no-results" ? [] : keys.filter(key => key.includes(query));
  const title = t(`statePreview.views.${view}`);
  const feedback = ["loading", "error", "denied", "conflict", "unknown", "partial"].includes(state);
  return <div className="state-workbench" data-theme={theme} data-scale={scale}>
    <div className="candidate-ribbon">{t("statePreview.candidate")}</div>
    <header className="sample-header"><div className="sample-brand"><img src={brand} alt="" /><strong>Tsumugi</strong></div>
      <span>{t("statePreview.project")}</span><span className="sample-language">{t("statePreview.language")}: 简体中文 · zh-CN</span>
      <span className="state-label" role="status">{t(`statePreview.states.${state}`)}</span></header>
    <div className="sample-frame"><nav aria-label={t("statePreview.navigation")}>
      {(["editor", "delivery", "plugins"] as const).map((area, index) => {
        const Icon = [BookOpen, PackageCheck, ShieldCheck][index];
        return <a key={area} href={`iframe.html?id=workbench-states--${area}-ready&viewMode=story`} aria-current={area === view ? "page" : undefined}><Icon aria-hidden="true" size={18} /><span>{t(`statePreview.views.${area}`)}</span></a>;
      })}
    </nav><main className="sample-main"><div className="sample-title"><h1>{title}</h1><span>{t("statePreview.exampleScope")}</span></div>
      {feedback ? <div className="sample-feedback" role={state === "loading" ? "status" : "alert"} data-tone={state === "loading" ? "neutral" : "warning"}>
        <TriangleAlert aria-hidden="true" size={18} /><div><strong>{t(`statePreview.states.${state}`)}</strong><p>{t(`statePreview.help.${state as "loading" | "error" | "denied" | "conflict" | "unknown" | "partial"}`)}</p></div>
        {state !== "loading" ? <button className="sample-button" onClick={() => setRecoveryPreview(value => !value)}>{t("statePreview.recoveryPreview")}</button> : null}</div> : null}
      {recoveryPreview ? <section className="sample-feedback" role="status"><strong>{t("statePreview.recoveryPreview")}</strong><p>{t("statePreview.recoveryHelp")}</p></section> : null}
      {view === "editor" ? <><div className="sample-toolbar"><label>{t("statePreview.find")}<input value={query} onChange={event => setQuery(event.target.value)} /></label><span role="status">{t("statePreview.matches", { count: visibleKeys.length })}</span><button className="sample-button" onClick={() => setQuery("")}>{t("statePreview.clear")}</button></div>
        <div className="sample-content"><section className="sample-list" aria-label={t("statePreview.entries")}>
          {visibleKeys.map(key => <button key={key} className="sample-entry" aria-current={keys[selected] === key ? "true" : undefined} onClick={() => { setSelected(keys.indexOf(key)); input.current?.focus({ preventScroll: true }); }}><span>{source.slice(0, 104)}</span><code>{key}</code><small>{t("statePreview.candidateOnly")}</small></button>)}
          {!visibleKeys.length ? <p className="sample-empty">{t(state === "empty" ? "statePreview.empty" : "statePreview.noResults")}</p> : null}
        </section><div className="sample-detail"><section className="sample-editor"><div className="sample-key"><code>{keys[selected]}</code><span role="status">{t(pending || state === "saving" ? "statePreview.states.saving" : dirty ? "statePreview.states.dirty" : "statePreview.localSaved")}</span></div>
          <div className="sample-editor-scroll"><h2>{t("statePreview.source")}</h2><pre className="natural-text">{source}</pre><label className="sample-draft">{t("statePreview.draft")}<textarea ref={input} value={text} readOnly={state === "denied"} onChange={event => { latestText.current = event.target.value; setText(event.target.value); setNotice("none"); }} /></label></div>
          <footer className="sample-editor-actions"><p role="status">{notice === "newer" ? t("statePreview.newer") : notice === "saved" ? t("statePreview.savedPreview") : t("statePreview.saveHelp")}</p><div><button className="sample-button primary" disabled={busy || blocked || !dirty} onClick={() => save()}><Save aria-hidden="true" size={16} />{t("statePreview.save")}</button><button className="sample-button" disabled={busy || blocked || !dirty} onClick={() => save(true)}>{t("statePreview.saveNext")}</button></div></footer>
        </section><details className="sample-references" open><summary>{t("statePreview.references")}</summary><div><h2>{t("statePreview.terms")}</h2><dl><dt>hay</dt><dd>干草</dd><dt>gem bird</dt><dd>宝石鸟</dd></dl><h2>{t("statePreview.variables")}</h2><p>{t("statePreview.variableHelp")}</p><code>{"{{hayCount}} · {{maxHayInLocation}} · {{maxHayInBuilding}}"}</code><h2>{t("statePreview.history")}</h2><p>{t("statePreview.historyHelp")}</p><pre className="natural-text">{translation}</pre></div></details></div></div></> : null}
      {view === "delivery" ? <section className="sample-delivery"><ol className="delivery-stages">{["readiness", "build", "verify", "publish", "export"].map((step, index) => <li key={step} aria-current={index === 0 ? "step" : undefined}><span>{index + 1}</span>{t(`statePreview.steps.${step as "readiness" | "build" | "verify" | "publish" | "export"}`)}</li>)}</ol>
        <h2>{t(deliveryBlocked ? "statePreview.blockers" : "statePreview.readyRelease")}</h2><p>{t("statePreview.deliveryHelp")}</p><div className="sample-table-wrap"><table><thead><tr>{["entry", "selection", "human", "qa", "action"].map(column => <th key={column}>{t(`statePreview.columns.${column as "entry" | "selection" | "human" | "qa" | "action"}`)}</th>)}</tr></thead><tbody><tr><th><code>building.stored-hay.summary</code></th><td>{t("statePreview.selected")}</td><td>{t(deliveryBlocked ? "statePreview.needsReview" : "statePreview.approvedExample")}</td><td>{deliveryBlocked ? <><span className="diagnostic"><TriangleAlert aria-hidden="true" size={16} />{t("statePreview.missingVariable")}</span><p>{"{{maxHayInBuilding}}"}</p></> : t("statePreview.checkPassedExample")}</td><td>{deliveryBlocked ? <a className="sample-button" href="iframe.html?id=workbench-states--editor-dirty&viewMode=story">{t("statePreview.openEntry")}</a> : t("statePreview.readyEntry")}</td></tr><tr><th><code>puzzle.island-shrine.solution</code></th><td>{t("statePreview.selected")}</td><td>{t("statePreview.approvedExample")}</td><td><CheckCheck aria-hidden="true" size={16} />{t("statePreview.checkPassedExample")}</td><td>{t("statePreview.readyEntry")}</td></tr></tbody></table></div>
        <details className="sample-history"><summary>{t("statePreview.oldRelease")}</summary><p>{t("statePreview.oldReleaseHelp")}</p><code>zh-CN.vtt · 138 bytes</code></details>{buildPreview ? <p role="status">{t("statePreview.buildPreviewHelp")}</p> : null}<footer className="sample-bottom"><p>{t(deliveryBlocked ? "statePreview.buildBlocked" : "statePreview.readyRelease")}</p><button className="sample-button primary" disabled={deliveryBlocked} onClick={() => setBuildPreview(true)}><PackageCheck aria-hidden="true" size={16} />{t("statePreview.buildPreview")}</button></footer></section> : null}
      {view === "plugins" ? <section className="sample-plugins"><h2>{t("statePreview.installPlan")}</h2><p>{t("statePreview.installHelp")}</p><dl className="package-plan"><dt>{t("statePreview.publisher")}</dt><dd>Tsumugi</dd><dt>{t("statePreview.package")}</dt><dd>WebVTT · 0.1.0</dd><dt>{t("statePreview.runtime")}</dt><dd>Node.js · 26.10</dd><dt>{t("statePreview.purpose")}</dt><dd>{t("statePreview.pluginPurpose")}</dd><dt>{t("statePreview.versionChange")}</dt><dd>0.1.0 → 0.1.1</dd></dl>
        <div className="sample-permission"><ShieldCheck aria-hidden="true" size={20} /><div><h2>{t("statePreview.permissions")}</h2><p>{t("statePreview.permissionHelp")}</p><ul><li>{t("statePreview.permissionFiles")}</li><li>{t("statePreview.permissionProcess")}</li><li>{t("statePreview.permissionNetwork")}</li></ul></div></div>
        <label className="sample-consent"><input type="checkbox" checked={consent} disabled={busy || state === "denied"} onChange={event => setConsent(event.target.checked)} />{t("statePreview.consent")}</label>
        {approvedPreview ? <p className="sample-feedback" role="status">{t("statePreview.approvedLayout")}</p> : null}
        <footer className="sample-bottom"><p>{t("statePreview.installPreserves")}</p><button className="sample-button primary" disabled={!consent || busy || blocked} onClick={() => setApprovedPreview(true)}>{t("statePreview.permissionPreview")}</button></footer>
      </section> : null}
    </main></div>
  </div>;
}

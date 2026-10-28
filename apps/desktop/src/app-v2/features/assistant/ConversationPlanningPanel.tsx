import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AiBudgetInputs, AiConnectionEditor } from "../../../AiConnectionFields";
import { connectionConfigCurrent, useConnectionFacts } from "../../../ApplicationReadProvider";
import { connectionAiConfig, isChatGptSubscription, validAiLimits } from "../../../aiCommands";
import { CommandFailureDetails } from "../../../CommandFailure";
import { ModelConnectionPicker } from "../../../ModelConnectionPicker";
import { Button } from "../../../design-system/Button";
import { TextInput } from "../../../design-system/Field";
import { Banner } from "../../../design-system/Feedback";
import type { InteractionGate } from "../../workspace/interactionGate";
import type { ConversationInput, ConversationSession } from "./ConversationSession";
import styles from "./ConversationPanel.module.css";

export function ConversationPlanningPanel({ owner, input, visible, disabled, gate, viewId, parentDialogId }: {
  owner: ConversationSession; input: ConversationInput; visible: boolean; disabled: boolean;
  gate: InteractionGate; viewId: string | null; parentDialogId?: string;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" }), { t: global } = useTranslation();
  const facts = useConnectionFacts(), planning = input.planning, conversationId = input.key.conversationId;
  const [connectionOpen, setConnectionOpen] = useState(false), [presetName, setPresetName] = useState("custom"), [materialOpen, setMaterialOpen] = useState(false);
  const id = useId(), inputOwner = `conversation-planning-${id}`;
  const root = useRef<HTMLElement>(null), previewRegion = useRef<HTMLElement>(null);
  const live = useRef({ visible, disabled, mounted: true });
  useLayoutEffect(() => { live.current = { visible, disabled, mounted: true }; return () => { live.current.mounted = false; }; }, [disabled, visible]);
  const focus = useRef<{ origin: HTMLElement; preview: boolean } | null>(null);
  const blocked = disabled || !visible || !!input.busy || !!input.value.pending || !!input.failure || !!planning.busy;
  const allowed = () => !blocked && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId });
  const current = () => live.current.mounted && live.current.visible && !live.current.disabled && !owner.getSnapshot().retired
    && owner.getSnapshot().activeId === conversationId && gate.canDispatch({ viewId, source: "button", dialogId: parentDialogId })
    && connectionConfigCurrent(facts.current(), owner.getSnapshot().inputs.get(conversationId)?.planning.config ?? planning.config);
  const valid = validAiLimits(planning.config) && !!planning.config.endpoint.trim() && !!planning.config.model.trim();
  const connectionCurrent = connectionConfigCurrent(facts.current(), planning.config);
  useEffect(() => { if (!connectionCurrent) owner.invalidatePlanning(conversationId); }, [connectionCurrent, conversationId, owner]);
  useEffect(() => () => gate.releaseOwner(inputOwner), [gate, inputOwner]);
  useEffect(() => { if (!visible) { gate.releaseOwner(inputOwner); owner.setPlanningConsent(conversationId, false); } }, [conversationId, gate, inputOwner, owner, visible]);
  useEffect(() => {
    const ticket = focus.current; if (!ticket || planning.busy || input.busy) return;
    focus.current = null;
    if (visible && (document.activeElement === ticket.origin || document.activeElement === document.body))
      (ticket.preview && planning.prepared ? previewRegion.current : root.current)?.focus();
  }, [input.busy, planning.busy, planning.prepared, visible]);
  const prepared = planning.prepared;
  return <section ref={root} tabIndex={-1} className={styles.planning} aria-label={t("askTitle")}
    onFocusCapture={() => gate.setInputOwner(viewId, inputOwner)}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) gate.releaseOwner(inputOwner); }}
    onCompositionStartCapture={() => gate.setComposing(inputOwner, true)} onCompositionEndCapture={() => gate.setComposing(inputOwner, false)}>
    <h3>{t("askTitle")}</h3><p>{t("askHelp")}</p>
    <p role="status">{t("askSelection", { count: planning.messageIds.length })}</p>
    <fieldset className={styles.configuration} disabled={blocked}><legend>{t("askDestination")}</legend>
      <ModelConnectionPicker config={planning.config} label={global("connections.choose")} active={visible} disabled={blocked} editSeq={planning.sequence}
        onSelect={(view, profileId, sequence) => {
          if (!allowed() || sequence !== owner.getSnapshot().inputs.get(conversationId)?.planning.sequence) return false;
          if (!profileId) { owner.setPlanningConfig(conversationId, before => ({ ...before, connectionProfile: null })); return true; }
          if (!view || facts.current() !== view) return false;
          const profile = view.snapshot.profiles.find(value => value.id === profileId && !value.archived), reference = view.references.find(value => value.profileId === profileId);
          if (!profile || !reference) return false;
          owner.setPlanningConfig(conversationId, before => connectionAiConfig(before, profile.connection, reference)); return true;
        }}/>
      <AiConnectionEditor config={planning.config} setConfig={change => owner.setPlanningConfig(conversationId, change)} presetName={presetName} setPresetName={setPresetName}
        connectionOpen={connectionOpen} setConnectionOpen={setConnectionOpen} failure={null} idPrefix={id}/>
      <AiBudgetInputs config={planning.config} setConfig={change => owner.setPlanningConfig(conversationId, change)} fields={["maxOutputTokens", "timeoutSeconds"]} idPrefix={id}/>
      <p>{t(isChatGptSubscription(planning.config) ? "askSubscriptionBudget" : "askBudget", { tokens: planning.config.maxOutputTokens, seconds: planning.config.timeoutSeconds })}</p>
      <p>{t("askCost")}</p>
    </fieldset>
    {!valid ? <p>{t("askConfigHelp")}</p> : null}
    {planning.failure ? <Banner tone="error"><p>{t("askFailed")}</p><CommandFailureDetails failure={planning.failure}/></Banner> : null}
    <Button size="sm" pending={planning.busy === "prepare"} disabled={blocked || !valid || !connectionCurrent || planning.messageIds.length === 0}
      onClick={event => { if (!allowed()) return; focus.current = { origin: event.currentTarget, preview: true }; void owner.preparePlanning(conversationId, current); }}>{t("askPrepare")}</Button>
    {prepared ? <section ref={previewRegion} tabIndex={-1} className={styles.preview} aria-label={t("askPreview")}>
      <h4>{t("askPreview")}</h4><p className={styles.text}>{prepared.preview.config.model} · {prepared.preview.config.endpoint}</p>
      <p>{t(isChatGptSubscription(prepared.preview.config) ? "askSubscriptionBudget" : "askBudget", { tokens: prepared.preview.config.maxOutputTokens, seconds: prepared.preview.config.timeoutSeconds })}</p>
      <p>{t("askMaterialSummary", { count: prepared.preview.selectedMessages.length, bytes: prepared.preview.byteLength })}</p>
      {prepared.preview.selectedMessages.map(message => <div className={styles.previewMessage} key={message.messageId}><p className={styles.text}>{message.body}</p></div>)}
      <Button size="sm" aria-expanded={materialOpen} aria-controls={`${id}-material`} onClick={() => setMaterialOpen(value => !value)}>{t("askFullMaterial")}</Button>
      {materialOpen ? <div id={`${id}-material`}><pre className={styles.text}>{prepared.preview.system}</pre><pre className={styles.text}>{prepared.preview.input}</pre></div> : null}
      <label className={styles.check}><TextInput className={styles.checkbox} type="checkbox" checked={planning.consent} disabled={blocked || !connectionCurrent}
        onChange={event => { if (allowed()) owner.setPlanningConsent(conversationId, event.target.checked); }}/><span>{t("askConsent")}</span></label>
      <Button variant="primary" size="sm" pending={planning.busy === "start"} disabled={blocked || !connectionCurrent || !planning.consent}
        onClick={event => { if (!allowed()) return; focus.current = { origin: event.currentTarget, preview: false }; void owner.startPlanning(conversationId, current); }}>{t("askSend")}</Button>
    </section> : null}
  </section>;
}

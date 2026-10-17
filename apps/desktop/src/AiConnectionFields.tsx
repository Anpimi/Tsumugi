import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { defaultAiConfig, type AiConfig } from "./aiCommands";

const numeric = [["maxItems", 1, 100], ["concurrency", 1, 2], ["maxRequests", 1, 300],
  ["maxOutputTokens", 1, 16384], ["maxRetries", 0, 2], ["timeoutSeconds", 1, 120]] as const;

/** The connection and budget editor shared by independently authorized AI operations. */
export function AiConnectionFields({ config, setConfig, presetName, setPresetName, connectionOpen, setConnectionOpen,
  failure, idPrefix = "ai", maxItemsLabel }: {
  config: AiConfig; setConfig: Dispatch<SetStateAction<AiConfig>>;
  presetName: string; setPresetName: (value: string) => void;
  connectionOpen: boolean; setConnectionOpen: (value: boolean) => void;
  failure: string | null; idPrefix?: string; maxItemsLabel?: string;
}) {
  const { t } = useTranslation();
  function change<K extends keyof AiConfig>(key: K, value: AiConfig[K]) { setConfig(before => ({ ...before, [key]: value })); }
  function preset(value: string) {
    setPresetName(value);
    setConfig(before => ({ ...before, connectionProfile: null,
      endpoint: value === "openai" ? "https://api.openai.com/v1/chat/completions" : value === "local" ? "http://127.0.0.1:11434/v1/chat/completions" : "",
      credentialEnv: value === "local" ? "" : "OPENAI_API_KEY", tokenField: value === "openai" ? "max_completion_tokens" : "max_tokens" }));
  }
  const fieldFailure = (key: string) => failure === `ai-${key === "credentialEnv" ? "credential" : key}`;
  return <><details open={connectionOpen} onToggle={event => setConnectionOpen(event.currentTarget.open)}><summary>{t("ai.connection")}</summary>
    <label className="field">{t("ai.preset")}<select value={presetName} onChange={event => preset(event.target.value)}><option value="custom">{t("ai.custom")}</option><option value="openai">OpenAI</option><option value="local">{t("ai.local")}</option></select></label>
    {([["endpoint", "url"], ["model", "text"], ["credentialEnv", "text"]] as const).map(([key, type]) => <label className="field" key={key}>{t(`ai.${key}`)}<input type={type} value={config[key]} aria-label={t(`ai.${key}`)} aria-invalid={fieldFailure(key) || undefined} aria-describedby={fieldFailure(key) ? `${idPrefix}-error-${key}` : undefined} onChange={event => change(key, event.target.value)} />
      {fieldFailure(key) ? <span id={`${idPrefix}-error-${key}`} className="field-error">{t(`ai.errors.${failure}`, { defaultValue: t("ai.errors.failed") })}</span> : null}</label>)}
    <p>{t("ai.credentialHelp")}</p><label className="field">{t("ai.tokenField")}<select value={config.tokenField} onChange={event => change("tokenField", event.target.value)}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label>
  </details><details open={failure === "ai-limits" ? true : undefined}><summary>{t("ai.budget")}</summary>
    {failure === "ai-limits" ? <p id={`${idPrefix}-error-limits`} className="field-error">{t("ai.errors.ai-limits")}</p> : null}
    {numeric.map(([key, min, max]) => <label className="field" key={key}>{key === "maxItems" && maxItemsLabel ? maxItemsLabel : t(`ai.${key}`)}<input type="number" min={min} max={max} value={Number.isFinite(config[key]) ? config[key] : ""} aria-invalid={failure === "ai-limits" && (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) || undefined} aria-describedby={failure === "ai-limits" ? `${idPrefix}-error-limits` : undefined} onChange={event => change(key, event.target.valueAsNumber)} /></label>)}
    <button className="secondary-button" type="button" onClick={() => setConfig(before => ({ ...before, maxItems: defaultAiConfig.maxItems, concurrency: defaultAiConfig.concurrency, maxRequests: defaultAiConfig.maxRequests, maxOutputTokens: defaultAiConfig.maxOutputTokens, maxRetries: defaultAiConfig.maxRetries, timeoutSeconds: defaultAiConfig.timeoutSeconds }))}>{t("ai.reset")}</button>
  </details></>;
}

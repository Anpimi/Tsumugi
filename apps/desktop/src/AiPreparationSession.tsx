import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { defaultAiConfig, type AiConfig, type AiPrepared, type AiStart } from "./aiCommands";
import type { PrepareRequest } from "./executionCommands";
import { useSessionReads } from "./SessionReadProvider";

function usePreparation(initialLocale: string, targetLocales: readonly string[]) {
  const reads = useSessionReads();
  const [presetName, setPresetName] = useState("custom");
  const [config, setConfig] = useState<AiConfig>(() => ({ ...defaultAiConfig }));
  const [locale, setLocale] = useState(initialLocale);
  const [selected, setSelected] = useState<string[]>([]);
  const [prepared, setPrepared] = useState<AiPrepared | null>(null);
  const [consent, setConsent] = useState(false);
  const [staleReason, setStaleReason] = useState<"source" | "preview" | null>(null);
  const [pendingStart, setPendingStart] = useState<AiStart | null>(null);
  const [pendingAdopt, setPendingAdopt] = useState<PrepareRequest | null>(null);
  const [dirty, setDirty] = useState(false);
  const [sourceGeneration, setSourceGeneration] = useState(0);
  const basisGeneration = useRef(0);

  function invalidatePreview(reason: "source" | "preview" | null = null) {
    basisGeneration.current++;
    setPrepared(null);
    setConsent(false);
    setStaleReason(reason);
  }
  function reset() {
    invalidatePreview();
    setPresetName("custom");
    setConfig({ ...defaultAiConfig });
    setLocale(initialLocale);
    setSelected([]);
    setPendingStart(null);
    setPendingAdopt(null);
    setDirty(false);
  }
  function clearSelectedRange() {
    setSelected([]);
    invalidatePreview();
    setDirty(true);
  }

  useEffect(() => reads.subscribeChanges(scopes => {
    if (scopes.includes("project") || scopes.includes("source") || scopes.includes("resources")) {
      invalidatePreview(scopes.includes("source") ? "source" : "preview");
      if (scopes.includes("project") || scopes.includes("source")) setSourceGeneration(value => value + 1);
    }
  }), [reads]);
  const targetAvailable = locale !== "" && targetLocales.includes(locale);
  useEffect(() => { if (!targetAvailable) invalidatePreview(); }, [targetAvailable]);

  return { presetName, setPresetName, config, setConfig, locale, setLocale, selected, setSelected,
    prepared, setPrepared, consent, setConsent, staleReason, setStaleReason,
    pendingStart, setPendingStart, pendingAdopt, setPendingAdopt,
    dirty, setDirty, sourceGeneration, basisGeneration, invalidatePreview, clearSelectedRange, reset, targetAvailable };
}

type Preparation = ReturnType<typeof usePreparation>;
const PreparationContext = createContext<Preparation | null>(null);

export function AiPreparationSession({ initialLocale, targetLocales, children }: {
  initialLocale: string; targetLocales: readonly string[]; children: ReactNode;
}) {
  const preparation = usePreparation(initialLocale, targetLocales);
  return <PreparationContext.Provider value={preparation}>{children}</PreparationContext.Provider>;
}

export function useAiPreparation() {
  const preparation = useContext(PreparationContext);
  if (!preparation) throw new Error("AI preparation requires a project session owner");
  return preparation;
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, type QueryKey } from "@tanstack/react-query";
import type { SessionRequest } from "./executionCommands";
import { useSessionReads } from "./SessionReadProvider";
import type { SessionReads } from "./sessionReads";

interface ExchangeFilePreview {
  projectId: string;
  preview: { sourceLocale: string; targetLocale: string; profile: string; digest: string };
}

interface Attempt { id: number; scope: string; visible: boolean }
let nextAttemptId = 0;
const PROFILES = { tmx: "tmx-1.4b-plain-text-preview", tbx: "tbx-basic-dca-subset-preview" } as const;

// Native file choosers outlive a cancelled JavaScript wait or an unmounted panel.
// Keep one transient chooser gate across both exchange panels until it settles.
let pickerOpen = false;
const pickerListeners = new Set<() => void>();
const pickerSnapshot = () => pickerOpen;
const subscribePicker = (notify: () => void) => {
  pickerListeners.add(notify);
  return () => { pickerListeners.delete(notify); };
};
function acquirePicker() {
  if (pickerOpen) return false;
  pickerOpen = true;
  pickerListeners.forEach(notify => notify());
  return true;
}
function releasePicker() {
  if (!pickerOpen) return;
  pickerOpen = false;
  pickerListeners.forEach(notify => notify());
}

function useInvalidated(reads: SessionReads, queryKey: QueryKey) {
  const identity = JSON.stringify(queryKey);
  const subscribe = useCallback((notify: () => void) => reads.client.getQueryCache().subscribe(event => {
    if (JSON.stringify(event.query.queryKey) === identity) notify();
  }), [reads, identity]);
  const snapshot = useCallback(() => reads.client.getQueryState(queryKey)?.isInvalidated ?? true, [reads, identity]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** An explicit, read-only file selection backed only by the session Query cache. */
export function useExchangePreview<T extends ExchangeFilePreview>({ format, context, sourceLocale, locale, enabled, preview }: {
  format: "tmx" | "tbx";
  context: SessionRequest;
  sourceLocale: string;
  locale: string;
  enabled: boolean;
  preview: (request: SessionRequest & { locale: string }) => Promise<T | null>;
}) {
  const reads = useSessionReads();
  const scope = JSON.stringify([context.projectId, context.sessionToken, sourceLocale, locale]);
  const current = useRef({ scope, enabled });
  const mounted = useRef(false);
  const currentAttempt = useRef<Attempt | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const pickerBusy = useSyncExternalStore(subscribePicker, pickerSnapshot, pickerSnapshot);
  const attemptKey = useCallback((value: Attempt) => reads.key([`${format}-exchange-preview`, value.scope, value.id]), [reads, format]);
  const queryKey = useMemo(() => reads.key(attempt
    ? [`${format}-exchange-preview`, attempt.scope, attempt.id]
    : [`${format}-exchange-preview`, "idle"]), [reads, format, attempt?.scope, attempt?.id]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    current.current = { scope, enabled };
    setAttempt(value => value ? { ...value, visible: false } : null);
    return () => {
      const last = currentAttempt.current;
      if (last) void reads.client.cancelQueries({ queryKey: attemptKey(last), exact: true });
    };
  }, [reads, scope, enabled, attemptKey]);
  useEffect(() => reads.subscribeChanges(scopes => {
    if (!scopes.some(value => value === "project" || value === "source" || value === "resources")) return;
    const last = currentAttempt.current;
    if (last) void reads.client.cancelQueries({ queryKey: attemptKey(last), exact: true });
    setAttempt(value => value ? { ...value, visible: false } : null);
  }), [reads, attemptKey]);

  // Disabled Query is only an observer. The chooser runs solely from choose().
  const query = useQuery<T | null>({ queryKey, enabled: false, retry: false,
    refetchOnMount: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
    meta: { scopes: ["source", "resources"] },
    queryFn: () => { throw new Error(`${format.toUpperCase()} preview requires an explicit file selection`); },
  });
  const visible = enabled && attempt?.visible === true && attempt.scope === scope && !reads.retired;
  const invalidated = useInvalidated(reads, queryKey);
  const result = visible && query.isSuccess && !query.isFetching && !invalidated ? query.data : undefined;

  function choose() {
    if (!enabled || !sourceLocale || !locale || reads.retired || !acquirePicker()) return;
    const next: Attempt = { id: ++nextAttemptId, scope, visible: true };
    const request = { ...context, locale };
    let commandStarted = false;
    currentAttempt.current = next;
    setAttempt(next);
    void reads.client.fetchQuery<T | null>({
      queryKey: attemptKey(next), meta: { scopes: ["source", "resources"] }, retry: false, staleTime: Infinity,
      queryFn: async ({ signal }) => {
        commandStarted = true;
        try {
          if (signal.aborted || reads.retired || !mounted.current || current.current.scope !== next.scope || !current.current.enabled) {
            throw new Error(`${format.toUpperCase()} preview cancelled`);
          }
          const selected = await preview(request);
          if (signal.aborted || reads.retired || !mounted.current || current.current.scope !== next.scope || !current.current.enabled) {
            throw new Error(`${format.toUpperCase()} preview cancelled`);
          }
          if (selected && (selected.projectId !== request.projectId || selected.preview.sourceLocale !== sourceLocale
            || selected.preview.targetLocale !== locale || !selected.preview.digest
            || selected.preview.profile !== PROFILES[format])) {
            throw new Error(`${format.toUpperCase()} preview does not match the current project and languages`);
          }
          return selected;
        } finally {
          releasePicker();
        }
      },
    }).catch(() => { /* Query owns the visible error; cancellation only hides the wait. */ })
      .finally(() => { if (!commandStarted) releasePicker(); });
  }

  function cancelWait() {
    const last = currentAttempt.current;
    if (!last) return;
    void reads.client.cancelQueries({ queryKey: attemptKey(last), exact: true });
    setAttempt(value => value && value.id === last.id ? { ...value, visible: false } : value);
  }

  return { choose, cancelWait, pickerBusy, canChoose: enabled && !!sourceLocale && !!locale && !pickerBusy && !reads.retired,
    visible, invalidated, result,
    isFetching: visible && query.isFetching,
    isSuccess: visible && query.isSuccess,
    error: visible && query.isError ? query.error : null,
  };
}

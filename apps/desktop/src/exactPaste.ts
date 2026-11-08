import { textareaDisplayText } from "./reviewDiagnosticNavigation";

export interface ExactPasteResult { text: string; matches: boolean }

/** Start during the paste gesture: WebKit's event text may already be normalized. */
export function readExactPaste(clipboardData: Pick<DataTransfer, "getData">): Promise<ExactPasteResult> | null {
  const eventText = clipboardData.getData("text/plain");
  if (typeof navigator.clipboard?.readText !== "function") return null;
  return navigator.clipboard.readText().then(text => ({ text,
    matches: textareaDisplayText(text).normalize("NFC") === textareaDisplayText(eventText).normalize("NFC") }));
}

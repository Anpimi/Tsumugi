import { writeFile } from "node:fs/promises";

// Build-time registry snapshot; language display never sends user input online.
const source = "https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry";
const response = await fetch(source);
if (!response.ok) throw new Error(`Registry download failed: ${response.status}`);
const registry = await response.text();
const names = {};
for (const record of registry.split("%%")) {
  if (!/^Type: language$/m.test(record)) continue;
  const code = record.match(/^Subtag: (.+)$/m)?.[1].trim();
  const name = record.match(/^Description: (.+)$/m)?.[1].trim();
  if (code && name) names[code] = name;
}
if (Object.keys(names).length < 7000) throw new Error("Incomplete language registry");
await writeFile(new URL("../src/i18n/language-names.json", import.meta.url), JSON.stringify({
  source,
  fileDate: registry.match(/^File-Date: (.+)$/m)?.[1].trim(),
  names,
}, null, 2) + "\n");

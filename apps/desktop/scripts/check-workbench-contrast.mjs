import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../src/design-system/tokens.css", import.meta.url), "utf8");
const themes = [...css.matchAll(/(?:\[data-theme="(light|dark)"\])\s*\{([^}]+)\}/g)];
if (themes.length !== 2) throw new Error("Expected light and dark workbench tokens.");
function luminance(channels) {
  const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
const checks = [];
for (const [, theme, body] of themes) {
  const colors = Object.fromEntries([...body.matchAll(/--color-([\w-]+):\s*([^;]+);/gi)].map(([, name, value]) => [name, value.trim()]));
  function channels(name) {
    const value = colors[name];
    if (!value) throw new Error(`Missing token: ${theme} ${name}`);
    if (/^#[a-f\d]{6}$/i.test(value)) return value.match(/[a-f\d]{2}/gi).map(part => parseInt(part, 16) / 255);
    const rgba = value.match(/^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/);
    if (!rgba) throw new Error(`Unsupported color: ${name} ${value}`);
    const surface = channels("bg-surface"), alpha = Number(rgba[4]);
    return rgba.slice(1, 4).map((part, index) => Number(part) / 255 * alpha + surface[index] * (1 - alpha));
  }
  const pairs = [
    ...["text-primary", "text-secondary"].flatMap(foreground => ["bg-surface", "bg-canvas", "bg-raised", "bg-subtle", "bg-muted", "accent-soft", "success-soft", "warning-soft", "danger-soft"].map(background => [foreground, background, 4.5])),
    // Tertiary text is used on plain surfaces. Hovered/selected row text uses secondary.
    ...["bg-surface", "bg-canvas", "bg-raised"].map(background => ["text-tertiary", background, 4.5]),
    // Untranslated circles also appear on hovered/selected rows; these are non-text marks.
    ...["bg-subtle", "accent-soft"].map(background => ["text-tertiary", background, 3]),
    ...["accent-text", "success", "warning", "danger", "ai-solid"].flatMap(foreground => ["bg-surface", "bg-canvas", "bg-raised", "bg-subtle"].map(background => [foreground, background, 4.5])),
    ["accent-on-solid", "accent-solid", 4.5], ["ai-solid", "ai-soft", 4.5],
    ...["bg-surface", "bg-raised"].map(background => ["border-strong", background, 3]),
    ...["bg-surface", "bg-raised", "bg-subtle"].map(background => ["accent-solid", background, 3]),
  ];
  for (const [foreground, background, minimum] of pairs) {
    if (!colors[foreground] || !colors[background]) throw new Error(`Missing token: ${theme} ${foreground}/${background}`);
    const values = [luminance(channels(foreground)), luminance(channels(background))].sort((a, b) => b - a);
    const ratio = (values[0] + 0.05) / (values[1] + 0.05);
    checks.push({ theme, foreground, background, ratio: Number(ratio.toFixed(2)), minimum, passed: ratio >= minimum });
  }
}
const failures = checks.filter(check => !check.passed);
console.log(JSON.stringify({ checked: checks.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;

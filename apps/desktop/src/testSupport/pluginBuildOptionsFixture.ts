import { createHash } from "node:crypto";
import { pluginBuildView } from "./pluginBuildFixture";
import type { PluginBuildView, PluginBuildConfigurationRequest } from "../pluginCommands";
import type { EncodedPayload } from "../generated/plugins.responses";

export const buildOptionSchema = { id: "example.output-options", schemaVersion: 1, behaviorVersion: 1 };
export function buildOptionsView(): PluginBuildView {
  const view = structuredClone(pluginBuildView);
  view.declaration.configuration = [{ schema: buildOptionSchema, displayName: "Output settings", options: [
    { id: "loading-language", displayName: "Loading language", choices: [
      { id: "english", displayName: "English" }, { id: "french", displayName: "French" },
    ] },
  ] }];
  return view;
}
export function buildOptionSelections(value: string): PluginBuildConfigurationRequest["locales"][number]["configuration"] {
  return [{ schema: buildOptionSchema, selections: [{ id: "loading-language", value }] }];
}
export function buildOptionPayload(value: string): EncodedPayload {
  const utf8 = JSON.stringify({ selections: [{ id: "loading-language", value }] });
  return { schema: buildOptionSchema, utf8, sha256: createHash("sha256").update(utf8, "utf8").digest("hex") };
}

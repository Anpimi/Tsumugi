import { useTranslation } from "react-i18next";
import { Field, Select } from "./design-system/Field";
import { Banner } from "./design-system/Feedback";
import type { PluginBuildView, PluginBuildConfigurationRequest } from "./pluginCommands";
import type { EncodedPayload } from "./generated/plugins.responses";
import { validateResponseBuildConfigurationValues } from "./generated/plugins.validators";

type Declarations = NonNullable<PluginBuildView["declaration"]["configuration"]>;
type Selections = PluginBuildConfigurationRequest["locales"][number]["configuration"];
const sameSchema = (left: Declarations[number]["schema"], right: Declarations[number]["schema"]) => left.id === right.id && left.schemaVersion === right.schemaVersion && left.behaviorVersion === right.behaviorVersion;
function selected(group: Declarations[number], selections: Selections, id: string) {
  return selections.find(value => sameSchema(value.schema, group.schema))?.selections.find(value => value.id === id)?.value ?? "";
}
export function buildOptionsReady(declarations: Declarations, selections: Selections) {
  return declarations.every(group => group.options.every(option => option.choices.some(choice => choice.id === selected(group, selections, option.id))));
}
export function PluginBuildOptions({ declarations, selections, disabled, onChange }: {
  declarations: Declarations; selections: Selections; disabled: boolean;
  onChange: (schema: Declarations[number]["schema"], id: string, value: string) => void;
}) {
  const { t } = useTranslation();
  return declarations.map(group => <section key={JSON.stringify(group.schema)} aria-label={group.displayName}>
    <p>{group.displayName}</p>
    {group.options.map(option => <Field key={option.id} label={option.displayName}>
      <Select value={selected(group, selections, option.id)} required disabled={disabled}
        onChange={event => onChange(group.schema, option.id, event.target.value)}>
        <option value="">{t("releasePlugin.chooseOption")}</option>
        {option.choices.map(choice => <option key={choice.id} value={choice.id}>{choice.displayName}</option>)}
      </Select>
    </Field>)}
  </section>);
}
export function CapturedBuildOptions({ declarations, configuration }: { declarations: Declarations; configuration: EncodedPayload[] }) {
  const { t } = useTranslation();
  return declarations.map(group => {
    const payload = configuration.find(value => sameSchema(value.schema, group.schema));
    let values: unknown = null;
    try { if (payload) values = JSON.parse(payload.utf8); } catch { /* Display cannot reinterpret an invalid saved payload. */ }
    if (!validateResponseBuildConfigurationValues(values)) return <Banner key={JSON.stringify(group.schema)} tone="warning">{t("releasePlugin.configurationUnavailable")}</Banner>;
    const selections = values.selections;
    return <section key={JSON.stringify(group.schema)} aria-label={group.displayName}><p>{group.displayName}</p><ul>
      {group.options.map(option => <li key={option.id}>{t("releasePlugin.configurationValue", { name: option.displayName,
        value: option.choices.find(choice => choice.id === selections.find(value => value.id === option.id)?.value)?.displayName ?? t("releasePlugin.configurationUnavailable") })}</li>)}
    </ul></section>;
  });
}

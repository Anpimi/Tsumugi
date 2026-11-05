import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import fixture from "../../../../test/fixtures/reviewCommands.contract.json";
import { TranslationScopeChoices } from "../../../ReleaseTranslationScope";
import { validateResponsePage } from "../../../generated/review.validators";
import { fixtureIdentity } from "../../../testSupport/executionFixture";
import styles from "../../../design-system/Stories.module.css";

const page = structuredClone(fixture.responses.page);
if (!validateResponsePage(page)) throw new Error("Invalid source scope fixture");
page.rows.push({ ...structuredClone(page.rows[0]), unitId: fixtureIdentity(333), nativeKey: "Long source / full text",
  sourceText: "Synthetic <script>alert('literal')</script> — 世界 👩🏽‍💻\nA long source paragraph remains available without changing the saved translation. ".repeat(8) });
page.total = page.rows.length;
const meta = {
  title: "Workbench/Staged translation scope",
  component: TranslationScopeChoices,
  parameters: { layout: "padded", controls: { exclude: ["selected", "onChange", "retry"] } },
  args: { locale: "zh-CN", selected: [], disabled: false, page, loading: false, failed: false, onChange: () => {}, retry: () => {} },
  render: function ScopeSample(args) {
    const [selected, setSelected] = useState<string[] | undefined>(() => args.selected);
    return <div className={styles.stack}><TranslationScopeChoices {...args} selected={selected} onChange={value => setSelected(value ?? undefined)}/></div>;
  },
} satisfies Meta<typeof TranslationScopeChoices>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SelectTranslations: Story = {};
export const ReadFailure: Story = { args: { failed: true, selected: [page.rows[0].unitId] } };
export const LockedScope: Story = { args: { disabled: true } };

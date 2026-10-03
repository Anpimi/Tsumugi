import fixture from "../../test/fixtures/sourceCommands.contract.json";
import type { ContentPage, ContentRow, IntegrationDescriptor, SourceOccurrence } from "../sourceCommands";

/** Complete synthetic wire data shared with Rust; override identities explicitly. */
export function sourceRowFixture(row: Partial<ContentRow> = {}, occurrence: Partial<SourceOccurrence> = {}): ContentRow {
  const base = fixture.page.rows[0];
  return { ...base, ...row, occurrence: { ...base.occurrence,
    keyByteRange: [base.occurrence.keyByteRange[0], base.occurrence.keyByteRange[1]],
    valueByteRange: [base.occurrence.valueByteRange[0], base.occurrence.valueByteRange[1]],
    ...occurrence } };
}

export function sourcePageFixture(overrides: Partial<ContentPage> = {}): ContentPage {
  return { ...fixture.page, rows: [sourceRowFixture()], ...overrides };
}

export const sourceIntegrationFixture: IntegrationDescriptor = fixture.integration;
export const captionIntegrationFixture: IntegrationDescriptor = { ...fixture.integration,
  id: "webvtt", capabilityId: "webvtt.extract", formatProfiles: ["webvtt-captions"],
  requiredFiles: ["source.vtt"], permissions: ["captured-input-only"] };

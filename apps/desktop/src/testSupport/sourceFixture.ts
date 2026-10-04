import fixture from "../../test/fixtures/sourceCommands.contract.json";
import type { ContentPage, ContentRow, IntegrationDescriptor, SourceOccurrence } from "../sourceCommands";
import { validateResponsePage } from "../generated/source.validators";

function contractPage(): ContentPage {
  if (!validateResponsePage(fixture.page)) throw new Error("Invalid synthetic source contract fixture");
  return structuredClone(fixture.page);
}

/** Complete synthetic wire data shared with Rust; override identities explicitly. */
export function sourceRowFixture(row: Partial<ContentRow> = {}, occurrence: Partial<SourceOccurrence> = {}): ContentRow {
  const base = contractPage().rows[0];
  const source = occurrence.source ?? { ...base.occurrence.source, artifactId: occurrence.artifactId ?? base.occurrence.source.artifactId };
  // A presentation override does not invent a new canonical matching value.
  const nativeIdentity = occurrence.nativeIdentity === undefined && base.occurrence.nativeIdentity
    ? { ...base.occurrence.nativeIdentity, display: { ...base.occurrence.nativeIdentity.display,
      value: occurrence.key ?? base.occurrence.nativeIdentity.display.value,
      source: base.occurrence.nativeIdentity.display.source ? { ...base.occurrence.nativeIdentity.display.source, artifactId: occurrence.artifactId ?? base.occurrence.nativeIdentity.display.source.artifactId } : null } }
    : occurrence.nativeIdentity === undefined ? base.occurrence.nativeIdentity : occurrence.nativeIdentity;
  return { ...base, ...row, occurrence: { ...base.occurrence, ...occurrence, source, nativeIdentity } };
}

export function sourcePageFixture(overrides: Partial<ContentPage> = {}): ContentPage {
  return { ...contractPage(), rows: [sourceRowFixture()], ...overrides };
}

export const sourceIntegrationFixture: IntegrationDescriptor = fixture.integration;
export const captionIntegrationFixture: IntegrationDescriptor = { ...fixture.integration,
  id: "webvtt", capabilityId: "webvtt.extract", formatProfiles: ["webvtt-captions"],
  requiredFiles: ["source.vtt"], permissions: ["captured-input-only"] };

/** Deterministic synthetic UUIDs; never use a developer's project identities. */
export const fixtureIdentity = (ordinal: number) => `20000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;

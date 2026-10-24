import type { AiConfig } from "../aiCommands";
import type { ConnectionReadView } from "../connectionCommands";
import { fixtureIdentity } from "./executionFixture";

/** Synthetic Core-supplied opaque identities; the client does not compute hashes. */
export function connectionFixture(configs: AiConfig[]): ConnectionReadView {
  const linked = configs.filter(config => config.connectionProfile != null);
  const profiles = linked.map(config => ({ id: config.connectionProfile!.profileId, revision: config.connectionProfile!.revision, name: `Synthetic ${config.model}`,
    connection: { endpoint: config.endpoint, model: config.model, credentialEnv: config.credentialEnv, tokenField: config.tokenField }, archived: false })).sort((a,b)=>a.id.localeCompare(b.id));
  const storeId = linked[0]?.connectionProfile?.storeId ?? null;
  return { snapshot: { storeId, revision: linked.length ? "1" : "0", lastActionId: linked.length ? fixtureIdentity(703) : null, profiles },
    basis: { storeId, revision: linked.length ? "1" : "0", digest: "c".repeat(64) }, references: profiles.map(profile => structuredClone(linked.find(config=>config.connectionProfile!.profileId===profile.id)!.connectionProfile!)) };
}

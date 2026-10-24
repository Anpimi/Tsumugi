import type { CheckKey, ReviewCheckerKey } from "./generated/review.responses";

export function contractIdentity(contract: ReviewCheckerKey["profile"]): string {
  return JSON.stringify([contract.id, contract.schemaVersion, contract.behaviorVersion]);
}

export function providerIdentity(provider: ReviewCheckerKey["provider"]): string {
  return JSON.stringify([provider.plugin.publisher, provider.plugin.id, provider.plugin.version,
    provider.packageDigest, provider.componentId, provider.contributionId]);
}
export function checkerIdentity(key: ReviewCheckerKey): string {
  return JSON.stringify([providerIdentity(key.provider), key.profile.id, key.profile.schemaVersion, key.profile.behaviorVersion]);
}
export function ruleIdentity(key: CheckKey): string {
  const implementation = key.implementation;
  return JSON.stringify([key.rule.id, key.rule.schemaVersion, key.rule.behaviorVersion, implementation.kind,
    implementation.kind === "plugin" ? providerIdentity(implementation.provider)
      : [implementation.validator.id, implementation.validator.schemaVersion, implementation.validator.behaviorVersion]]);
}

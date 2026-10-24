import { expect, it } from "vitest";
import { approvedPluginEnvironments, matchingPluginEnvironments, pluginEnvironmentVersion } from "./pluginEnvironments";
import { pluginSourceInventory, pluginSourceView } from "./testSupport/pluginSourceFixture";
import { pluginBuildView } from "./testSupport/pluginBuildFixture";
import { translationView } from "./testSupport/pluginTranslationFixture";
import { nativeDigest, nativeEnvironment, nativeInventory, nativeOrigin } from "./testSupport/pluginNativeFixture";
import { validateResponseSource, validateResponseBuild, validateResponseTranslation, validateResponseInventory } from "./generated/plugins.validators";

it("offers sealed Node bytes only with the exact independent approval and origin", () => {
  expect(approvedPluginEnvironments(pluginSourceInventory)).toHaveLength(1);
  for (const kind of ["unapproved", "foreign-origin", "unsealed"] as const) {
    const view = structuredClone(pluginSourceInventory);
    if (kind === "unapproved") view.runtimeDecisions = [];
    if (kind === "foreign-origin") view.runtimeDecisions[0].origin = { ...view.runtimeDecisions[0].origin, publisherId: "other-publisher" };
    if (kind === "unsealed") view.runtimes[0].state = "recovery-required";
    expect(approvedPluginEnvironments(view)).toEqual([]);
  }
});
it("offers the exact current approved Native Host without creating an installed tree", () => {
  const view = nativeInventory(pluginSourceInventory);
  expect(view.runtimes).toEqual(pluginSourceInventory.runtimes);
  expect(approvedPluginEnvironments(view).map(choice => choice.environment.profile)).toEqual(["node-system-libraries-v1", "native-application-host-v1"]);
  expect(matchingPluginEnvironments(approvedPluginEnvironments(view), ["native-worker", "data"])).toEqual([{ environment: nativeEnvironment, environmentDigest: nativeDigest, origin: nativeOrigin }]);
});
it.each(["unapproved", "obsolete", "foreign-origin", "unavailable"] as const)("does not offer a %s Native environment", kind => {
  const view = nativeInventory(pluginSourceInventory, kind !== "unapproved");
  const decision = view.runtimeDecisions.find(item => item.environment.profile === "native-application-host-v1");
  if (kind === "obsolete") decision!.environmentDigest = "c".repeat(64);
  if (kind === "foreign-origin") decision!.origin = { ...decision!.origin, sourceId: "different-host-origin" };
  if (kind === "unavailable") view.nativeHostOffer = { availability: "unavailable", reason: "identity-unavailable" };
  expect(approvedPluginEnvironments(view).every(choice => choice.environment.profile === "node-system-libraries-v1")).toBe(true);
});
it("does not treat a data component as an executable or a Node approval as Native", () => {
  expect(matchingPluginEnvironments(approvedPluginEnvironments(pluginSourceInventory), ["native-worker", "data"])).toEqual([]);
  expect(matchingPluginEnvironments(approvedPluginEnvironments(nativeInventory(pluginSourceInventory)), ["data"])).toEqual([]);
});
it("uses Host version for Native presentation and tool version for Node", () => {
  expect(pluginEnvironmentVersion(nativeEnvironment)).toBe(nativeEnvironment.hostVersion);
  expect(pluginEnvironmentVersion(pluginSourceView.environment)).toBe("26.10.0");
});
it("accepts both strict environment variants in source/build/translation and refuses a fake Node installation", () => {
  for (const [value, validate] of [[pluginSourceView, validateResponseSource], [pluginBuildView, validateResponseBuild], [translationView, validateResponseTranslation]] as const) {
    expect(validate(value)).toBe(true);
    const native = { ...value, environment: nativeEnvironment, environmentDigest: nativeDigest, runtimeOrigin: nativeOrigin };
    expect(validate(native)).toBe(true);
    expect(validate({ ...native, environment: { ...nativeEnvironment, toolVersion: "26.10.0" } })).toBe(false);
    expect(validate({ ...native, environment: { ...nativeEnvironment, executable: undefined } })).toBe(false);
  }
  const view = nativeInventory(pluginSourceInventory);
  expect(validateResponseInventory({ ...view, runtimes: [{ environment: nativeEnvironment, environmentDigest: nativeDigest, origin: nativeOrigin, state: "sealed" }] })).toBe(false);
});

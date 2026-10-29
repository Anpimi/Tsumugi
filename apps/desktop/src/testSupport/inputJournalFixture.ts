import { installResourceDraftPortsFixture } from "./resourceDraftFixture";
import { installSourceDraftPortsFixture } from "./sourceDraftFixture";
import { installStrategyDraftFixture } from "./strategyDraftFixture";

/** Legacy owner/navigation tests isolate local disk behind the existing CAS
 * fixtures. Domain commands still use their original transport and assertions.
 * Journal wire and native persistence tests install their own explicit ports. */
export function installWorkbenchInputJournalFixtures() {
  installResourceDraftPortsFixture();
  installSourceDraftPortsFixture();
  installStrategyDraftFixture();
}

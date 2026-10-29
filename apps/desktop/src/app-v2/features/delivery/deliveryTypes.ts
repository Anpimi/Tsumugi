import type { useReleaseDraftSession } from "../../../ReleaseDraftSession";

/** Build preparation, original requests and export recovery stay in the release session. */
export type DeliveryOwnerHandle = ReturnType<typeof useReleaseDraftSession>;

import { invoke } from "@tauri-apps/api/core";
import type { SessionRequest } from "./executionCommands";

export interface BuildLocaleChoice { locale: string; fileName: string }
export interface ReleasedArtifact { locale: string; fileName: string; sha256: string; entryCount: number }
export interface ReleaseException { locale: string; nativeKey: string; kind: "source-fallback" | "qa-waiver" }
export interface ReleaseSourceFile { logicalPath: string; sha256: string }
export interface ReleaseView { releaseId: string; actionId: string; attemptId: string; sourceSnapshotId: string; policyVersion: string; eligibilityBasis: string; manifestSha256: string; builderVersion: string; validatorVersion: string; sourceFiles: ReleaseSourceFile[]; exceptions: ReleaseException[]; artifacts: ReleasedArtifact[]; createdAt: string }
export interface DeliverySelection { selectionId: string; folderName: string }
export interface PreviewFile { locale: string; fileName: string; expectedSha256: string; currentSha256: string | null; state: "absent" | "same" | "conflict" }
export interface DeliveryPreview { previewId: string; releaseId: string; selectionId: string; folderName: string; files: PreviewFile[] }
export interface DeliveryFile { locale: string; fileName: string; expectedSha256: string; actualSha256: string | null; state: "pending" | "succeeded" | "failed" | "unknown" }
export interface DeliveryView { deliveryId: string; actionId: string; releaseId: string; directory: string; overwriteConflicts: boolean; state: "pending" | "succeeded" | "partial" | "failed" | "unknown"; files: DeliveryFile[]; createdAt: string }

export const releaseCommands = {
  start: (request: SessionRequest & { attemptId: string; choices: BuildLocaleChoice[]; expectedEligibilityBasis: string }) => invoke<string>("start_locale_build", { request }),
  releases: (request: SessionRequest) => invoke<ReleaseView[]>("list_releases", { request }),
  choose: (request: SessionRequest) => invoke<DeliverySelection | null>("choose_delivery_folder", { request }),
  preview: (request: SessionRequest & { releaseId: string; selectionId: string }) => invoke<DeliveryPreview>("preview_delivery", { request }),
  export: (request: SessionRequest & { releaseId: string; selectionId: string; previewId: string; actionId: string; overwriteConflicts: boolean }) => invoke<DeliveryView>("export_release", { request }),
  deliveries: (request: SessionRequest & { releaseId: string }) => invoke<DeliveryView[]>("list_deliveries", { request }),
  reconcile: (request: SessionRequest & { actionId: string; selectionId: string }) => invoke<DeliveryView>("reconcile_delivery", { request }),
};

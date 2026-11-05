// Generated from the Rust SDK. Run pnpm generate:contracts; do not edit.

/**
 * Source coordinates are separate from ranges in decoded unit/target text.
 *
 * This interface was referenced by `SourceCaptureSummary`'s JSON-Schema
 * via the `definition` "SourceEncoding".
 */
export type SourceEncoding = "utf8-byte" | "utf16" | "grapheme" | "raw-byte";

export interface SourceCaptureSummary {
  materials: SourceCaptureMaterial[];
}
/**
 * This interface was referenced by `SourceCaptureSummary`'s JSON-Schema
 * via the `definition` "SourceCaptureMaterial".
 */
export interface SourceCaptureMaterial {
  counts: SourceCaptureCounts;
  /**
   * When supplied, the disjoint groups must sum to the material counts.
   */
  groups: SourceCaptureGroup[];
  properties: SourceCaptureProperty[];
  source: SourceReference;
}
/**
 * This interface was referenced by `SourceCaptureSummary`'s JSON-Schema
 * via the `definition` "SourceCaptureCounts".
 */
export interface SourceCaptureCounts {
  declaredFields: number;
  items: number;
  itemsWithFields: number;
  nonEmptyFields: number;
}
/**
 * This interface was referenced by `SourceCaptureSummary`'s JSON-Schema
 * via the `definition` "SourceCaptureGroup".
 */
export interface SourceCaptureGroup {
  counts: SourceCaptureCounts;
  label: string;
}
/**
 * Labels and values are literal plugin-authored data, rendered as plain text.
 * An empty values list explicitly reports no values, rather than missing data.
 *
 * This interface was referenced by `SourceCaptureSummary`'s JSON-Schema
 * via the `definition` "SourceCaptureProperty".
 */
export interface SourceCaptureProperty {
  label: string;
  values: string[];
}
/**
 * Captured parse-input evidence, not a filesystem path or read permission.
 */
export interface SourceReference {
  artifactId: string;
  range: SourceRange;
}
/**
 * This interface was referenced by `SourceCaptureSummary`'s JSON-Schema
 * via the `definition` "SourceRange".
 */
export interface SourceRange {
  encoding: SourceEncoding;
  end: number;
  start: number;
}
/**
 * This interface was referenced by `SourceCaptureSummary`'s JSON-Schema
 * via the `definition` "SourceReference".
 */
export interface SourceReference1 {
  artifactId: string;
  range: SourceRange;
}

// Generated from the Rust SDK. Run pnpm generate:contracts; do not edit.

/**
 * Classification for presentation, without interpreting a format's syntax or
 * normalizing its literal text. Other source-associated information uses Note.
 *
 * This interface was referenced by `SourceContextFacts`'s JSON-Schema
 * via the `definition` "SourceContextFactKind".
 */
export type SourceContextFactKind = "speaker" | "role" | "scene" | "time" | "location" | "note";
/**
 * References are observations in captured source, not proof of an inference.
 * Human project decisions remain in the project's independent revision owner.
 *
 * This interface was referenced by `SourceContextFacts`'s JSON-Schema
 * via the `definition` "SourceContextFactOrigin".
 */
export type SourceContextFactOrigin =
  | {
      kind: "extracted";
      /**
       * @minItems 1
       * @maxItems 8
       */
      sources:
        | [SourceReference]
        | [SourceReference, SourceReference]
        | [SourceReference, SourceReference, SourceReference]
        | [SourceReference, SourceReference, SourceReference, SourceReference]
        | [SourceReference, SourceReference, SourceReference, SourceReference, SourceReference]
        | [SourceReference, SourceReference, SourceReference, SourceReference, SourceReference, SourceReference]
        | [
            SourceReference,
            SourceReference,
            SourceReference,
            SourceReference,
            SourceReference,
            SourceReference,
            SourceReference
          ]
        | [
            SourceReference,
            SourceReference,
            SourceReference,
            SourceReference,
            SourceReference,
            SourceReference,
            SourceReference,
            SourceReference
          ];
    }
  | {
      kind: "inferred";
      rationale: string;
      /**
       * @minItems 1
       * @maxItems 8
       */
      sources:
        | [SourceReference]
        | [SourceReference, SourceReference]
        | [SourceReference, SourceReference, SourceReference]
        | [SourceReference, SourceReference, SourceReference, SourceReference]
        | [SourceReference, SourceReference, SourceReference, SourceReference, SourceReference]
        | [SourceReference, SourceReference, SourceReference, SourceReference, SourceReference, SourceReference]
        | [
            SourceReference,
            SourceReference,
            SourceReference,
            SourceReference,
            SourceReference,
            SourceReference,
            SourceReference
          ]
        | [
            SourceReference,
            SourceReference,
            SourceReference,
            SourceReference,
            SourceReference,
            SourceReference,
            SourceReference,
            SourceReference
          ];
    };
/**
 * Source coordinates are separate from ranges in decoded unit/target text.
 *
 * This interface was referenced by `SourceContextFacts`'s JSON-Schema
 * via the `definition` "SourceEncoding".
 */
export type SourceEncoding = "utf8-byte" | "utf16" | "grapheme" | "raw-byte";

/**
 * The surrounding DomainBlock supplies Snapshot/Unit/Occurrence applicability.
 * Empty facts report an explicit empty observation; absence is not that report.
 */
export interface SourceContextFacts {
  /**
   * @maxItems 32
   */
  facts: SourceContextFact[];
}
/**
 * This interface was referenced by `SourceContextFacts`'s JSON-Schema
 * via the `definition` "SourceContextFact".
 */
export interface SourceContextFact {
  /**
   * Unique only inside this block; it is not a project revision or entity ID.
   */
  id: string;
  kind: SourceContextFactKind;
  origin: SourceContextFactOrigin;
  text: string;
}
/**
 * This interface was referenced by `SourceContextFacts`'s JSON-Schema
 * via the `definition` "SourceReference".
 */
export interface SourceReference {
  artifactId: string;
  range: SourceRange;
}
/**
 * This interface was referenced by `SourceContextFacts`'s JSON-Schema
 * via the `definition` "SourceRange".
 */
export interface SourceRange {
  encoding: SourceEncoding;
  end: number;
  start: number;
}

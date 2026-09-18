import type { enUS } from "./en-US";

type WidenStrings<T> = T extends string
  ? string
  : T extends readonly unknown[]
    ? { [K in keyof T]: WidenStrings<T[K]> }
    : T extends object
      ? { [K in keyof T]: WidenStrings<T[K]> }
      : T;

/** The English resource is the canonical key and interpolation shape source. */
export type UiMessages = WidenStrings<typeof enUS>;

type TranslationKeyOf<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K
    : T[K] extends object
      ? `${K}.${TranslationKeyOf<T[K]>}`
      : never;
}[keyof T & string];

export type TranslationKey = TranslationKeyOf<UiMessages>;

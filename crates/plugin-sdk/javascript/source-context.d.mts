import type { SourceContextFacts } from './source-context.d.ts';

/** Data validation only; source associations and authority remain receiver-owned. */
export function validateSourceContextFacts(value: unknown): value is SourceContextFacts;
export function encodeSourceContextFacts(value: SourceContextFacts): string;

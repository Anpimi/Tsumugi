import type { SourceCaptureSummary } from './source-capture.d.ts';

/** Data validation only; source associations and authority remain receiver-owned. */
export function validateSourceCaptureSummary(value: unknown): value is SourceCaptureSummary;
export function encodeSourceCaptureSummary(value: SourceCaptureSummary): string;

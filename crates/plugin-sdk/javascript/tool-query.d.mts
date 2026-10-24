import type { CapabilityToolBinding, ToolQueryDeclaration } from './tool.js';
export class ToolQueryError extends Error {
  constructor(code: string, field: string);
  readonly code: string;
  readonly field: string;
}
export interface ToolQueryInput { text: string; target: string; selections: string[]; }
export interface ToolQueryPresentation {
  readonly query: ToolQueryDeclaration;
  prepare(input: ToolQueryInput): unknown;
  entries(output: unknown): string[][];
}
export function createToolQuery(binding: CapabilityToolBinding): ToolQueryPresentation;

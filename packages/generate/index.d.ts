/**
 * Type declarations for @shiftgraph/generate.
 *
 * Hand-written rather than emitted, because the source is plain JavaScript and
 * stays that way: this package must run from `npx` on a cold machine with no
 * build step and no dependencies, and adding a compiler to a type generator to
 * make it typed is a trade nobody asked for.
 *
 * Written after trying to consume this package from a TypeScript-strict
 * codebase and being rejected. A package that generates TypeScript and ships no
 * types of its own is a fair thing to be criticised for.
 */

/**
 * A structural profile: what an interface was observed to return, with values
 * stripped. Recursive by construction, so it is described rather than enumerated.
 */
export interface ShapeProfile {
  type: string;
  /** Present when `type` is "object". A key named "{key}" means a map keyed by data. */
  keys?: Record<string, ShapeProfile>;
  /** Present when `type` is "array". */
  element?: ShapeProfile;
  /** Present when `type` is "union". */
  variants?: string[];
  /**
   * True only where the interface was actually watched omitting this field.
   * Absence of the flag is not a claim that the field is required, it is the
   * absence of evidence either way.
   */
  optional?: boolean;
  [key: string]: unknown;
}

/** A TypeScript type expression for a profile. `depth` controls indentation only. */
export function toTypeScript(node: ShapeProfile | null | undefined, depth?: number): string;

/** A Zod schema expression for a profile. */
export function toZod(node: ShapeProfile | null | undefined, depth?: number): string;

/**
 * Fields observed ONLY as null, which are the one place this generator can be
 * confidently wrong: a field null in every observation is typed `null` and
 * cannot hold a value, which is what was seen but not necessarily the contract.
 * Returns JSONPath-style paths.
 */
export function nullOnlyFields(node: ShapeProfile | null | undefined, path?: string, out?: string[]): string[];

/** Total and optional field counts, recursive. */
export function countFields(
  node: ShapeProfile | null | undefined,
  acc?: { total: number; optional: number },
): { total: number; optional: number };

export interface GenerateModuleOptions {
  /** Becomes the exported interface name, pascal-cased. */
  name: string;
  profile: ShapeProfile;
  /** Where the observations came from, printed in the header. */
  source: string;
  observations: number;
  observedFrom: string;
  observedTo?: string;
  /** The exact command that regenerates this file. */
  command: string;
  /** Limits that apply to this specific file. They belong in the artifact, not beside it. */
  notes?: string[];
}

/** The full generated module: provenance header, interface, and Zod schema. */
export function generateModule(options: GenerateModuleOptions): string;

export interface RegenerationChange {
  change: "added" | "removed" | "now optional" | "now required" | "type changed";
  path: string;
  detail: string;
}

/**
 * A field-level description of what changed between two observed profiles,
 * written to be legible to a reviewer who has never heard of this tool.
 */
export function describeRegeneration(
  before: ShapeProfile | null | undefined,
  after: ShapeProfile | null | undefined,
  basePath?: string,
): RegenerationChange[];

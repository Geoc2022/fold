import type { JsonValue, PolicyValue } from './engine'

// Small builders for the Rust `Value` serde shape (`{ kind, value }`), shared
// by policy environment builders. See `engine.ts` for the `PolicyValue` type.

export function num(v: number): PolicyValue {
  return { kind: 'Num', value: v }
}

export function bool(v: boolean): PolicyValue {
  return { kind: 'Bool', value: v }
}

export function str(v: string): PolicyValue {
  return { kind: 'Str', value: v }
}

export function dur(secs: number): PolicyValue {
  return { kind: 'Dur', value: secs }
}

export function list(values: PolicyValue[]): PolicyValue {
  return { kind: 'List', value: values }
}

export function tuple(values: PolicyValue[]): PolicyValue {
  return { kind: 'Tuple', value: values }
}

export function variant(type: string, name: string, values: PolicyValue[]): PolicyValue {
  return { kind: 'Variant', value: { type, name, values } }
}

export function record(type: string, fields: Record<string, PolicyValue>): PolicyValue {
  return { kind: 'Record', value: { type, fields } }
}

/** Wrap a `{ name: PolicyValue }` map as the top-level env object the WASM
 * boundary expects (`EvalEnv { vars }`). */
export function envFromVars(vars: Record<string, PolicyValue>): JsonValue {
  return { vars } as unknown as JsonValue
}

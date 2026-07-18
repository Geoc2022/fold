type PolicyWasmModule = {
  default: (moduleOrPath?: RequestInfo | URL | Response | BufferSource | WebAssembly.Module) => Promise<unknown>
  compile_policy_json: (source: string) => string
  evaluate_policy_json: (policyJson: string, envJson: string) => string
  highlight_policy_json: (source: string) => string
  eval_expr_json: (source: string, envJson: string) => string
  policy_docs: () => string
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [k: string]: JsonValue }
  | JsonValue[]

/** A runtime value, matching the Rust `Value` serde shape (`{ kind, value }`). */
export type PolicyValue =
  | { kind: 'Num'; value: number }
  | { kind: 'Bool'; value: boolean }
  | { kind: 'Dur'; value: number }
  | { kind: 'Str'; value: string }
  | { kind: 'List'; value: PolicyValue[] }
  | { kind: 'Tuple'; value: PolicyValue[] }
  | { kind: 'Record'; value: { type: string; fields: Record<string, PolicyValue> } }
  | { kind: 'Variant'; value: { type: string; name: string; values: PolicyValue[] } }

/** The structured effect program produced by evaluating a policy action. */
export type Effect =
  | { op: 'notify'; message: string }
  | { op: 'state'; state: string; eta_delta_secs?: number }
  | { op: 'sleep'; secs: number }
  | { op: 'seq'; steps: Effect[] }
  | { op: 'noop' }

export interface Span {
  start: number
  end: number
}

export interface Diagnostic {
  span: Span
  message: string
}

export interface CompileResult {
  policy: JsonValue | null
  diagnostics: Diagnostic[]
}

export interface EvaluateResult {
  fired: Effect | null
  error: string | null
}

export interface EvalExprResult {
  output: string | null
  ty: string | null
  error: string | null
}

export interface HighlightToken {
  kind: string
  start: number
  end: number
}

export interface HighlightResult {
  tokens: HighlightToken[]
  diagnostics: Diagnostic[]
}

let cachedModule: Promise<PolicyWasmModule> | null = null
const POLICY_WASM_IMPORT_PATH = '/policy-wasm/policy.js'

async function loadPolicyWasm(): Promise<PolicyWasmModule> {
  if (cachedModule) return cachedModule
  cachedModule = (async () => {
    const mod = (await import(/* @vite-ignore */ POLICY_WASM_IMPORT_PATH)) as PolicyWasmModule
    await mod.default()
    return mod
  })()
  return cachedModule
}

export async function warmPolicyEngine(): Promise<void> {
  try {
    await loadPolicyWasm()
  } catch (error) {
    console.warn('policy wasm unavailable; run scripts/build-policy-web.sh', error)
  }
}

export async function compilePolicy(source: string): Promise<CompileResult> {
  try {
    const wasm = await loadPolicyWasm()
    const raw = wasm.compile_policy_json(source)
    return JSON.parse(raw) as CompileResult
  } catch (error) {
    return {
      policy: null,
      diagnostics: [{ span: { start: 0, end: 0 }, message: `policy compile failed: ${String(error)}` }],
    }
  }
}

export async function evaluatePolicy(policy: JsonValue, env: JsonValue): Promise<EvaluateResult> {
  try {
    const wasm = await loadPolicyWasm()
    const raw = wasm.evaluate_policy_json(JSON.stringify(policy), JSON.stringify(env))
    return JSON.parse(raw) as EvaluateResult
  } catch (error) {
    return { fired: null, error: `policy evaluate failed: ${String(error)}` }
  }
}

export async function compileAndEvaluate(source: string, env: JsonValue): Promise<EvaluateResult> {
  const compiled = await compilePolicy(source)
  if (!compiled.policy || compiled.diagnostics.length > 0) {
    return { fired: null, error: compiled.diagnostics[0]?.message ?? 'compile failed' }
  }
  return evaluatePolicy(compiled.policy, env)
}

export async function evaluateExpression(source: string, env: JsonValue): Promise<EvalExprResult> {
  try {
    const wasm = await loadPolicyWasm()
    const raw = wasm.eval_expr_json(source, JSON.stringify(env))
    return JSON.parse(raw) as EvalExprResult
  } catch (error) {
    return { output: null, ty: null, error: `expression eval failed: ${String(error)}` }
  }
}

let cachedDocs: string | null = null

export async function policyDocs(): Promise<string> {
  if (cachedDocs != null) return cachedDocs
  try {
    const wasm = await loadPolicyWasm()
    cachedDocs = wasm.policy_docs()
    return cachedDocs
  } catch (error) {
    return `Failed to load documentation: ${String(error)}`
  }
}

export async function highlightPolicy(source: string): Promise<HighlightResult> {
  try {
    const wasm = await loadPolicyWasm()
    const raw = wasm.highlight_policy_json(source)
    return JSON.parse(raw) as HighlightResult
  } catch (error) {
    return {
      tokens: [],
      diagnostics: [{ span: { start: 0, end: 0 }, message: `policy highlight failed: ${String(error)}` }],
    }
  }
}

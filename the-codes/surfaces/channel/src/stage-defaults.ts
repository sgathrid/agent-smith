/** Default providers and the default implement/review/moderate pipeline, chosen from what is installed. */
import { STAGE_PROMPTS } from '../../../forge/modes.ts';
import { getCatalogs } from '../../../providers/catalog.ts';
import { resolveRequest, type ModelConfig } from '../../../providers/aliases.ts';
import type { ModelCatalog } from '../../../providers/types.ts';
import type { Effort, PipelineSpec, Stage } from '../../../pipeline/types.ts';
import { PROVIDERS } from './tool-defs.ts';

export type CatalogSource = () => Promise<ModelCatalog[]>;
const STAGE_PREFERENCE = [['implement', 'agy'], ['review', 'codex'], ['moderate', 'claude']] as const;
export async function installedCatalogs(ctx: { catalogs?: CatalogSource }, refresh = false): Promise<ModelCatalog[]> {
  try { return await (ctx.catalogs ?? (() => getCatalogs({ refresh })))(); } catch { return []; }
}
/** Pick a provider per stage from what is installed: preferred if present, else an unused one, else any. */
function assignStageProviders(installed: readonly string[]): Record<string, string> {
  if (installed.length === 0) throw new Error(`No providers installed. Install at least one of: ${PROVIDERS.join(', ')}.`);
  const out: Record<string, string> = {}; const used = new Set<string>();
  for (const [stage, preferred] of STAGE_PREFERENCE) {
    const pick = installed.includes(preferred) ? preferred : (installed.find(p => !used.has(p)) ?? installed[0]!);
    out[stage] = pick; used.add(pick);
  }
  return out;
}
export function defaultProvider(installed: readonly string[]): string {
  if (installed.length === 0) throw new Error(`No providers installed. Install at least one of: ${PROVIDERS.join(', ')}.`);
  return installed.includes('agy') ? 'agy' : installed[0]!;
}
export interface MixedSpecInput {
  readonly name: string; readonly task: string; readonly workDir?: string;
  readonly concurrency?: number; readonly models?: Readonly<Partial<Record<string, string>>>;
  readonly efforts?: Readonly<Partial<Record<string, Effort>>>; readonly stages?: readonly Stage[]; readonly modelConfig?: ModelConfig;
}
/** Default implement/review/moderate pipeline from installed providers; explicit `stages` pass through unchanged. */
export async function defaultMixedPipeline(input: MixedSpecInput, catalogs?: CatalogSource): Promise<PipelineSpec> {
  if (input.stages) {
    const stages = input.modelConfig
      ? input.stages.map(st => { const r = resolveRequest({ provider: st.provider, model: st.model, effort: st.effort, mode: st.role ?? st.name }, input.modelConfig!); return { ...st, provider: r.provider ?? st.provider, model: r.model, effort: r.effort as Effort | undefined }; })
      : input.stages;
    return { name: input.name, stages, workDir: input.workDir, concurrency: input.concurrency };
  }
  const cats = await installedCatalogs({ catalogs });
  const assign = assignStageProviders(cats.map(c => c.provider));
  const stage = (name: string, extra: Partial<Stage>): Stage => {
    const rd = input.modelConfig ? resolveRequest({ mode: name }, input.modelConfig) : undefined;
    if (rd?.source === 'roleDefault' && rd.provider) {
      return { name, provider: rd.provider, model: input.models?.[name] ?? rd.model, effort: input.efforts?.[name] ?? rd.effort as Effort | undefined, role: name, routingPinned: true, ...extra } as Stage;
    }
    const provider = assign[name]!; const cat = cats.find(c => c.provider === provider);
    const cfg = cat?.defaultSource === 'harness-config';
    return { name, provider, model: input.models?.[provider] ?? input.models?.[name] ?? (cfg ? cat?.defaultModel : undefined),
      effort: input.efforts?.[name] ?? (cfg ? cat?.defaultEffort as Effort | undefined : undefined), role: name, routingPinned: true, ...extra } as Stage;
  };
  const stages: Stage[] = [
    stage('implement', { prompt: input.task }),
    stage('review', { dependsOn: ['implement'], prompt: STAGE_PROMPTS.review }),
    stage('moderate', { dependsOn: ['implement', 'review'], prompt: STAGE_PROMPTS.moderate }),
  ];
  return { name: input.name, stages, workDir: input.workDir, concurrency: input.concurrency };
}

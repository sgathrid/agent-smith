/** Default providers and the default implement/review/moderate pipeline, chosen from what is installed. */
import { STAGE_PROMPTS } from '../../../forge/modes.ts';
import { getCatalogs } from '../../../providers/catalog.ts';
import { resolveRequest, type ModelConfig } from '../../../providers/aliases.ts';
import type { ModelCatalog } from '../../../providers/types.ts';
import type { Effort, PipelineSpec, Stage } from '../../../pipeline/types.ts';
import { PROVIDERS } from './tool-defs.ts';

export type CatalogSource = () => Promise<ModelCatalog[]>;
export interface CatalogDiscovery {
  readonly catalogs: ModelCatalog[];
  readonly error?: string;
}
export async function discoverCatalogs(ctx: { catalogs?: CatalogSource }, refresh = false): Promise<CatalogDiscovery> {
  try {
    const catalogs = await (ctx.catalogs ?? (() => getCatalogs({ refresh })))();
    const failedAll = catalogs.length === 1 && catalogs[0]?.provider === '*' ? catalogs[0] : undefined;
    if (failedAll) return { catalogs: [], error: failedAll.error ?? 'provider discovery failed' };
    return { catalogs };
  } catch (err) {
    return { catalogs: [], error: err instanceof Error ? err.message : String(err) };
  }
}
export async function installedCatalogs(ctx: { catalogs?: CatalogSource }, refresh = false): Promise<ModelCatalog[]> {
  return (await discoverCatalogs(ctx, refresh)).catalogs;
}
/** The provider to use when none is configured: the only installed one. Never a guess between several. */
export function defaultProvider(installed: readonly string[], onMany?: (list: string) => string, discoveryError?: string): string {
  if (installed.length === 0) {
    if (discoveryError !== undefined) {
      throw new Error(`Provider discovery failed (${discoveryError}).`);
    }
    throw new Error(`No coding agent installed: install one of ${PROVIDERS.join(', ')}.`);
  }
  if (installed.length > 1) { const list = installed.join(', '); throw new Error(onMany ? onMany(list) : `provider is required: installed are ${list}.`); }
  return installed[0]!;
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
  const { catalogs: cats, error: discoveryError } = await discoverCatalogs({ catalogs });
  const installed = cats.map(c => c.provider);
  const stage = (name: string, extra: Partial<Stage>): Stage => {
    const rd = input.modelConfig ? resolveRequest({ mode: name }, input.modelConfig) : undefined;
    if (rd?.source === 'roleDefault' && rd.provider) {
      return { name, provider: rd.provider, model: input.models?.[name] ?? rd.model, effort: input.efforts?.[name] ?? rd.effort as Effort | undefined, role: name, routingPinned: true, ...extra } as Stage;
    }
    const provider = defaultProvider(installed, list => `pass stages with a provider each: installed are ${list}.`, discoveryError); const cat = cats.find(c => c.provider === provider);
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

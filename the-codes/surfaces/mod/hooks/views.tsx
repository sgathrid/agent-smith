/** Terminal views use host controls and scrolling; no filesystem or timers here. */
import type { UiComponents } from 'claude-code';
import type { RadarJob, DetailTab } from '../types/index.d.ts';
import type { ForgeDetail } from './canonical.ts';
import { acceptanceLabel } from './canonical.ts';
import { activeJob, belongsToRepo, needsAttention, rosterJobs, rosterSummary, scopedJobKey, workerHeading, workerStatus, statusLine, groupWorkers } from './dashboard.ts';
import { isTerminal, oneLine, pickColor, pickGlyph } from './format.ts';

export interface ViewActions {
  pick(job: RadarJob): Promise<void>;
  roster(tab: 'active' | 'history'): Promise<void>;
  page(value: number): Promise<void>;
  tab(value: DetailTab): Promise<void>;
  back(): Promise<void>;
  follow(): Promise<void>;
  preamble(): Promise<void>;
  tool(key: string): Promise<void>;
  check(index: number): Promise<void>;
  clear(): Promise<void>;
  acknowledge(): Promise<void>;
  restore(): Promise<void>;
  inspector(): Promise<void>;
  close(): Promise<void>;
}
export interface ViewOptions {
  width: number; rows: number; now: number; colour: boolean; bottom: boolean; repo: string; acknowledged: readonly string[];
  rosterTab: 'active' | 'history'; page: number; tab: DetailTab; following: boolean;
  preamble: boolean; tools: readonly string[]; checks: readonly number[];
}

export function renderRoster(W: UiComponents, jobs: readonly RadarJob[], hidden: readonly string[], o: ViewOptions, a: ViewActions): JSX.Element {
  const {Box,Text,Button} = W;
  const sorted = groupWorkers(rosterJobs(jobs,o.rosterTab,hidden,o.acknowledged,o.repo));
  const pageSize = o.bottom ? Math.max(1,Math.min(9,Math.floor((o.rows - 6) / 2))) : 9;
  const pages = Math.max(1,Math.ceil(sorted.length/pageSize));
  const page = Math.min(o.page,pages-1);
  const shown = sorted.slice(page*pageSize,(page+1)*pageSize);
  return <Box flexDirection="column">
    <Text bold wrap="truncate-end">{rosterSummary(jobs,o.acknowledged,o.repo)}</Text>
    <Box flexDirection="row" gap={2}>
      <Button key="roster-active" plain label="Active" hotkey="a" dimColor={o.rosterTab!=='active'} onPress={() => a.roster('active')} />
      <Button key="roster-history" plain label="History" hotkey="h" dimColor={o.rosterTab!=='history'} onPress={() => a.roster('history')} />
    </Box>
    {shown.length===0 && <Text dimColor wrap="wrap">{o.rosterTab==='active'?'No active workers. Open History for finished work.':'No finished workers in this view.'}</Text>}
    {shown.map((job,i) => <Box key={`worker-${job.id}`} flexDirection="column">
      <Button key={`job-${job.id}`} plain hotkey={String(i+1)} label={`${pickGlyph(job.status)} ${oneLine(workerHeading(job),Math.max(1,o.width-5))}`} onPress={() => a.pick(job)} />
      <Text dimColor={!activeJob(job)} color={o.colour&&job.status==='failed'?'red':undefined} wrap="truncate-end">{statusLine(job,o.now,Math.max(1,o.width-2))}</Text>
    </Box>)}
    {pages>1 && <Box flexDirection="row" gap={2}>
      {page>0 && <Button key="previous-page" plain label="Previous" hotkey="p" onPress={() => a.page(page-1)} />}
      <Text dimColor wrap="truncate-end">{`${page+1}/${pages}`}</Text>
      {page+1<pages && <Button key="next-page" plain label="Next" hotkey="n" onPress={() => a.page(page+1)} />}
    </Box>}
    <Box flexDirection="row" gap={2}>
      <Button key="clear" plain label="Acknowledge / clear" hotkey="c" onPress={a.clear} />
      {(hidden.some(key=>belongsToRepo(key,o.repo))||o.acknowledged.some(key=>belongsToRepo(key,o.repo))) && <Button key="restore" plain label="Restore dismissed" hotkey="u" onPress={a.restore} />}
    </Box>
    {viewFooter(W,o,a)}
  </Box>;
}

export function renderWorker(W: UiComponents, d: ForgeDetail, o: ViewOptions, a: ViewActions, runs: readonly RadarJob[] = []): JSX.Element {
  const {Box,Text,Button,Markdown} = W;
  const job=d.job;
  const tabs: [DetailTab,string,string][]=[['activity','Activity','a'],['task','Task','t'],['result','Result','r'],['checks','Checks','k']];
  return <Box flexDirection="column">
    <Text bold color={o.colour?pickColor(job.status):undefined} wrap="truncate-end">{workerHeading(job)}</Text>
    <Text wrap="truncate-end">{workerStatus(job)}</Text>
    {isTerminal(job.status)&&!job.acceptance?.pending&&needsAttention(job)&&!o.acknowledged.includes(scopedJobKey(o.repo,job.id))&&
      <Button key="acknowledge" plain label="Acknowledge" hotkey="y" onPress={a.acknowledge} />}
    <Text dimColor wrap="truncate-end">{`${job.toolCount??'?'} tool calls${job.lastEventAt==null?'':` · last event ${Math.max(0,Math.floor((o.now-job.lastEventAt)/1000))}s ago`}`}</Text>
    <Box flexDirection={o.width<48?'column':'row'} gap={1}>{tabs.map(([tab,label,key]) => <Button key={`tab-${tab}`} plain label={label} hotkey={key} dimColor={o.tab!==tab} onPress={() => a.tab(tab)} />)}</Box>
    {job.warnings.map((warning,i) => <Text key={`warning-${i}`} color={o.colour?'yellow':undefined} wrap="wrap">{warning.message}</Text>)}
    {o.tab==='activity' && <Box flexDirection="column">
      {d.timeline===null && <Text dimColor wrap="wrap">Older snapshot: output and tools are separate; their original order is unavailable.</Text>}
      {d.timeline?.map(event => event.kind==='assistant'
        ? <Markdown key={`event-${event.sequence}`} text={event.text} />
        : toolRow(W,`event-${event.sequence}`,event.tool,event.input,event.output,event.state,o,a))}
      {d.timeline===null && <>
        {d.transcript.length>0 && <Markdown text={d.transcript.join('\n\n')} />}
        {d.history.map((tool,i) => toolRow(W,`legacy-tool-${i}`,tool.tool,tool.label,tool.output,tool.state,o,a))}
      </>}
      {(d.timeline?.length??d.transcript.length+d.history.length)===0 && <Text dimColor wrap="wrap">{job.latestSummary??'No worker activity recorded yet.'}</Text>}
      <Text key="forge-stream-end" dimColor wrap="truncate-end">{isTerminal(job.status)?'Execution ended.':'Waiting for the next worker event.'}</Text>
    </Box>}
    {o.tab==='task' && <Box flexDirection="column">
      <Markdown text={o.preamble&&job.preamble?`${job.preamble}\n\n${job.prompt??job.task}`:job.prompt??job.task} />
      {job.preamble && <Button key="preamble" plain label={o.preamble?'Hide preamble':'Show preamble'} hotkey="p" onPress={a.preamble} />}
      <Text dimColor wrap="wrap">{`${job.id}\nWorker: ${job.workerId??job.id}${job.provider?`\nProvider: ${job.provider}`:''}${job.model?`\nModel: ${job.model}`:''}${job.pipeline?`\nPipeline: ${job.pipeline} · ${job.stage??'stage unknown'}`:''}${job.attempt!=null?`\nAttempt: ${job.attempt}`:''}`}</Text>
      {runs.length>0 && <Text bold wrap="truncate-end">Earlier runs</Text>}
      {runs.map(run => <Button key={`run-${run.id}`} plain label={oneLine(`${run.id} · ${run.status}`,o.width)} onPress={() => a.pick(run)} />)}
    </Box>}
    {o.tab==='result' && (job.report?.trim()?<Markdown text={job.report}/>:<Text dimColor wrap="wrap">{isTerminal(job.status)?'No report was written.':'No report yet. The worker is still running.'}</Text>)}
    {o.tab==='checks' && <Box flexDirection="column">
      <Text wrap="wrap">{`Acceptance: ${acceptanceLabel(job.acceptance)}`}</Text>
      {job.acceptance?.checks.map((check,i) => <Box key={`check-row-${i}`} flexDirection="column">
        <Button key={`check-${i}`} plain label={`${check.ok?'✓':'✗'} ${check.name}${o.checks.includes(i)?' · expanded':''}`} onPress={() => a.check(i)} />
        {(check.reason||check.timedOut||check.signal||check.skipped) && <Text dimColor wrap="wrap">{[
          check.timedOut?'timed out':null,
          check.signal?`signal ${check.signal}`:null,
          check.skipped?`skipped: ${check.skipped}`:null,
          check.reason,
        ].filter(Boolean).join(' · ')}</Text>}
        {(!check.ok||o.checks.includes(i)) && check.outputTail && <Text dimColor wrap="wrap">{check.outputTail}</Text>}
      </Box>)}
      {job.acceptance?.checks.length===0 && <Text dimColor wrap="wrap">{job.acceptance.pending?'Waiting for check results.':'No executable check results were recorded.'}</Text>}
    </Box>}
    <Box flexDirection={o.width<60?'column':'row'} gap={1}>
      <Button key="back" plain label="Back" hotkey="b" onPress={a.back} />
      {o.tab==='activity' && <Button key="follow" plain label={o.following?'Follow on':'Follow paused'} hotkey="f" onPress={a.follow} />}
      {viewFooter(W,o,a)}
    </Box>
  </Box>;
}

function toolRow(W: UiComponents,key:string,tool:string,input:string,output:string,state:string,o:ViewOptions,a:ViewActions): JSX.Element {
  const {Box,Text,Button}=W;
  const expanded=o.tools.includes(key)||state==='error';
  return <Box key={`row-${key}`} flexDirection="column">
    <Button key={key} plain label={`${state==='active'?'›':state==='error'?'✗':'✓'} ${oneLine(`${tool} ${input}`,Math.max(1,o.width-3))}`} onPress={() => a.tool(key)} />
    {expanded&&<Text dimColor wrap="wrap">{`${input}${output?`\n${output}`:''}`}</Text>}
  </Box>;
}
function viewFooter(W:UiComponents,o:ViewOptions,a:ViewActions):JSX.Element {
  const {Box,Button,Text}=W;
  return <Box flexDirection={o.width<48?'column':'row'} gap={1}>
    {o.bottom && <Button key="inspector" plain label="Open inspector" hotkey="e" onPress={a.inspector} />}
    <Button key="close" plain label={o.bottom?'Collapse':'Close inspector'} hotkey="x" onPress={a.close}/>
    <Text dimColor wrap="truncate-end">Ctrl+X then Tab: focus pane hotkeys</Text>
  </Box>;
}

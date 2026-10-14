/** Forge sidebar views: the worker list and one worker's live view. No filesystem or timers here. */
import type { UiComponents } from 'claude-code';
import type { RadarJob } from '../types/index.d.ts';
import type { ForgeDetail } from './canonical.ts';
import { checksLabel, forgeList, isLive, needsAttention, scopeLine, statusLine, workerHeading, workerStatus } from './dashboard.ts';
import { elapsed, isTerminal, oneLine, pickColor, pickGlyph } from './format.ts';

export interface ViewActions {
  pick(job: RadarJob): Promise<void>;
  page(value: number): Promise<void>;
  back(): Promise<void>;
  task(): Promise<void>;
  tool(key: string): Promise<void>;
  close(): Promise<void>;
  /** Switch the list between this session and the repository; absent when there is no session view. */
  scope?(next: 'session' | 'all'): Promise<void>;
}
export interface ViewOptions {
  width: number; now: number; colour: boolean; page: number; scope: 'session' | 'all';
  following: boolean; taskOpen: boolean; tools: readonly string[];
}

/** Rows per page: one per digit hotkey. */
const PAGE_SIZE = 9;

export function renderList(W: UiComponents, jobs: readonly RadarJob[], o: ViewOptions, a: ViewActions): JSX.Element {
  const {Box,Text,Button} = W;
  const all = forgeList(jobs);
  const live = all.filter(isLive).length;
  const pages = Math.max(1,Math.ceil(all.length/PAGE_SIZE));
  const page = Math.min(o.page,pages-1);
  const start = page*PAGE_SIZE;
  return <Box flexDirection="column">
    <Text bold wrap="truncate-end">{`Forge · ${scopeLine(jobs,o.scope)}`}</Text>
    {all.length===0 && <Text dimColor wrap="wrap">{o.scope==='session'
      ? 'Agents you start here appear in this list. /forge all shows the repository\'s history.'
      : 'No workers yet. Running workers appear here and above the prompt.'}</Text>}
    {all.slice(start,start+PAGE_SIZE).map((job,i) => <Box key={`worker-${job.id}`} flexDirection="column">
      {start+i===live && <Text bold wrap="truncate-end">Recent</Text>}
      <Button key={`job-${job.id}`} plain hotkey={String(i+1)} label={workerHeading(job)} onPress={() => a.pick(job)}>
        <Text color={o.colour&&(isLive(job)||needsAttention(job,o.now))?pickColor(job.status):undefined} wrap="truncate-end">{pickGlyph(job.status)}</Text>
        {` ${oneLine(workerHeading(job),Math.max(1,o.width-5))}`}
      </Button>
      <Text dimColor={!isLive(job)&&!needsAttention(job,o.now)} color={o.colour&&job.status==='failed'&&needsAttention(job,o.now)?'red':undefined} wrap="truncate-end">{statusLine(job,o.now,Math.max(1,o.width-2))}</Text>
    </Box>)}
    <Box flexDirection="row" gap={2}>
      {page>0 && <Button key="previous-page" plain label="Previous" hotkey="p" onPress={() => a.page(page-1)} />}
      {pages>1 && <Text dimColor wrap="truncate-end">{`${page+1}/${pages}`}</Text>}
      {page+1<pages && <Button key="next-page" plain label="Next" hotkey="n" onPress={() => a.page(page+1)} />}
      {a.scope && (o.scope==='session'
        ? <Button key="scope-all" plain label="All" hotkey="a" onPress={() => a.scope!('all')} />
        : <Button key="scope-session" plain label="This session" hotkey="s" onPress={() => a.scope!('session')} />)}
      <Button key="close" plain label="Close" hotkey="x" onPress={a.close} />
    </Box>
  </Box>;
}

/** One scrolling view: header, task, live transcript, then the result and failing checks. */
export function renderWorker(W: UiComponents, d: ForgeDetail, o: ViewOptions, a: ViewActions, runs: readonly RadarJob[] = []): JSX.Element {
  const {Box,Text,Button,Markdown} = W;
  const job=d.job;
  const prompt=job.prompt??job.task;
  const span=job.startedAt===null?null:(job.endedAt??o.now)-job.startedAt;
  const meta=[[job.provider,job.model].filter(Boolean).join('·'),span===null?'':elapsed(span),checksLabel(job.acceptance)].filter(Boolean).join(' · ');
  const failing=job.acceptance?.checks.filter(check => !check.ok) ?? [];
  return <Box flexDirection="column">
    <Text bold color={o.colour?pickColor(job.status):undefined} wrap="truncate-end">{`${pickGlyph(job.status)} ${workerHeading(job)}`}</Text>
    {meta!=='' && <Text dimColor wrap="truncate-end">{meta}</Text>}
    <Text wrap="truncate-end">{workerStatus(job)}</Text>
    {job.warnings.map((warning,i) => <Text key={`warning-${i}`} color={o.colour?'yellow':undefined} wrap="wrap">{warning.message}</Text>)}
    <Button key="task" plain hotkey="t" label={o.taskOpen?'Task (as sent)':`Task: ${oneLine(prompt,Math.max(1,o.width-12))}`} onPress={a.task} />
    {o.taskOpen && <Markdown text={job.preamble?`${job.preamble}\n\n${prompt}`:prompt} />}
    {o.taskOpen && <Text dimColor wrap="wrap">{`${job.id}\nWorker: ${job.workerId??job.id}${job.pipeline?`\nPipeline: ${job.pipeline} · ${job.stage??'stage unknown'}`:''}${job.attempt!=null?`\nAttempt: ${job.attempt}`:''}`}</Text>}
    {d.timeline===null && <Text dimColor wrap="wrap">Older snapshot: output and tools are separate; their original order is unavailable.</Text>}
    {d.timeline?.map(event => event.kind==='assistant'
      ? <Markdown key={`event-${event.sequence}`} text={event.text} />
      : toolRow(W,`event-${event.sequence}`,event.tool,event.input,event.output,event.state,o,a))}
    {d.timeline===null && <>
      {d.transcript.length>0 && <Markdown text={d.transcript.join('\n\n')} />}
      {d.history.map((tool,i) => toolRow(W,`legacy-tool-${i}`,tool.tool,tool.label,tool.output,tool.state,o,a))}
    </>}
    {(d.timeline?.length??d.transcript.length+d.history.length)===0 && <Text dimColor wrap="wrap">{job.latestSummary??'No worker activity recorded yet.'}</Text>}
    {isTerminal(job.status)
      ? <Box flexDirection="column">
        <Text bold wrap="truncate-end">Result</Text>
        {job.report?.trim()?<Markdown text={job.report}/>:<Text dimColor wrap="wrap">No report was written.</Text>}
      </Box>
      : <Text dimColor wrap="truncate-end">{o.following?'Following live output.':'Paused. Scroll to the bottom to follow again.'}</Text>}
    {failing.map((check,i) => <Box key={`check-${i}`} flexDirection="column">
      <Text color={o.colour?'red':undefined} wrap="wrap">{[`✗ ${check.name}`,check.timedOut?'timed out':null,check.signal?`signal ${check.signal}`:null,
        check.skipped?`skipped: ${check.skipped}`:null,check.reason].filter(Boolean).join(' · ')}</Text>
      {check.outputTail && <Text dimColor wrap="wrap">{check.outputTail}</Text>}
    </Box>)}
    {runs.length>0 && <Text bold wrap="truncate-end">Earlier runs</Text>}
    {runs.map(run => <Button key={`run-${run.id}`} plain label={oneLine(`${run.id} · ${run.status}`,o.width)} onPress={() => a.pick(run)} />)}
    <Box flexDirection="row" gap={2}>
      <Button key="back" plain label="Back" hotkey="b" onPress={a.back} />
      <Button key="close" plain label="Close" hotkey="x" onPress={a.close} />
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

/** Forge sidebar views: the worker list and one worker's live view. No filesystem or timers here. */
import type { UiComponents } from 'claude-code';
import type { RadarJob } from '../types/index.d.ts';
import type { ForgeDetail } from './canonical.ts';
import { checksLabel, condenseTimeline, forgeList, isLive, needsAttention, scopeLine, statusLine, timelineGroupLabel, workerHeading, workerStatus, type TimelineItem } from './dashboard.ts';
import { elapsed, isTerminal, oneLine, pickColor, pickGlyph, sanitizeText } from './format.ts';
import { classify, progressLines } from './progress.ts';

/** A running worker this long without a new event is called out as quiet. */
const QUIET_MS = 60_000;

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
    <Text bold wrap="truncate-end">{`Workers · ${scopeLine(jobs,o.scope)}`}</Text>
    {all.length===0 && <Text dimColor wrap="wrap">{o.scope==='session'
      ? 'Workers you start here appear in this list. /forge all shows the repository\'s history.'
      : 'No workers yet.'}</Text>}
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
  const meta=oneLine([[job.provider,job.model].filter(Boolean).join('·'),runs.length>0?`turn ${runs.length+1}`:'',span===null?'':elapsed(span),checksLabel(job.acceptance)].filter(Boolean).join(' · '));
  const failing=job.acceptance?.checks.filter(check => !check.ok) ?? [];
  // A live worker's own words, one line, when it wrote any and the timeline
  // below does not already show them in full.
  const timelineProse=d.timeline?.some(event => event.kind==='assistant')??false;
  const note=(job.status==='running'||job.status==='attention')&&!timelineProse
    ? (job.reasoning?oneLine(job.reasoning,Math.max(1,o.width-6)):'') : '';
  // A running worker's progress block opens with the same phase and test verdict
  // `workerStatus` would print, so the status row only stands alone without it.
  const statusRow=!(job.status==='running'&&job.progress);
  // A shell-edited worker (codex) has no edit tool calls to count, so its
  // changedFiles manifest is the only evidence of what it touched.
  const changedFiles=isTerminal(job.status)&&job.changedFileCount!=null&&job.changedFileCount>0&&(job.progress?.editedCount??0)===0
    ? job.changedFileCount : 0;
  return <Box flexDirection="column">
    <Text bold color={o.colour?pickColor(job.status):undefined} wrap="truncate-end">{`${pickGlyph(job.status)} ${workerHeading(job)}`}</Text>
    {meta!=='' && <Text dimColor wrap="truncate-end">{meta}</Text>}
    {statusRow && <Text wrap="truncate-end">{workerStatus(job)}</Text>}
    {changedFiles>0 && <Text dimColor wrap="truncate-end">{`Changed: ${changedFiles} ${changedFiles===1?'file':'files'}`}</Text>}
    {(job.progress||note!=='') && <Box flexDirection="column">
      {job.progress && progressLines(job.progress, job.toolCount).map((line,i) => <Text key={`progress-${i}`} dimColor={i>0} wrap="truncate-end">{sanitizeText(line)}</Text>)}
      {note!=='' && <Text dimColor wrap="truncate-end">{`Note: ${note}`}</Text>}
      {job.status==='running' && job.lastEventAt!=null && o.now-job.lastEventAt>QUIET_MS &&
        <Text color={o.colour?'yellow':undefined} wrap="truncate-end">{`Stalled ${elapsed(o.now-job.lastEventAt)}`}</Text>}
    </Box>}
    {job.warnings.map((warning,i) => <Text key={`warning-${i}`} color={o.colour?'yellow':undefined} wrap="wrap">{sanitizeText(warning.message)}</Text>)}
    <Button key="task" plain hotkey="t" label={o.taskOpen?'Task (as sent)':`Task: ${oneLine(prompt,Math.max(1,o.width-12))}`} onPress={a.task} />
    {o.taskOpen && <Markdown text={sanitizeText(job.preamble?`${job.preamble}\n\n${prompt}`:prompt)} />}
    {o.taskOpen && <Text dimColor wrap="wrap">{sanitizeText(`${oneLine(job.id)}\nWorker: ${oneLine(job.workerId??job.id)}${job.pipeline?`\nPipeline: ${oneLine(job.pipeline)} · ${oneLine(job.stage??'stage unknown')}`:''}${job.attempt!=null?`\nAttempt: ${job.attempt}`:''}`)}</Text>}
    {d.timeline===null && <Text dimColor wrap="wrap">Older snapshot: output and tools are separate; their original order is unavailable.</Text>}
    {d.timeline && condenseTimeline(d.timeline).flatMap((item,i,items) => {
      const row=item.kind==='group'
        ? timelineGroup(W,item,o,a)
        : item.event.kind==='assistant'
          ? <Markdown key={`event-${item.event.sequence}`} text={proseText(item.event.text)} />
          : toolRow(W,`event-${item.event.sequence}`,item.event.tool,item.event.input,item.event.output,item.event.state,o,a);
      // A blank row where the worker turns from talking to working or back;
      // a run of tool rows stays one tight block.
      return i>0&&isProse(items[i-1]!)!==isProse(item)
        ? [<Box key={`gap-${timelineKey(item)}`}><Text> </Text></Box>,row] : [row];
    })}
    {d.timeline===null && <>
      {d.transcript.length>0 && <Markdown text={sanitizeText(d.transcript.join('\n\n'))} />}
      {d.history.map((tool,i) => toolRow(W,`legacy-tool-${i}`,tool.tool,tool.label,tool.output,tool.state,o,a))}
    </>}
    {(d.timeline?.length??d.transcript.length+d.history.length)===0 && <Text dimColor wrap="wrap">{sanitizeText(job.latestSummary??'No worker activity recorded yet.')}</Text>}
    {isTerminal(job.status)
      ? <Box flexDirection="column">
        <Text bold wrap="truncate-end">Result</Text>
        {job.report?.trim()?<Markdown text={sanitizeText(job.report)}/>:<Text dimColor wrap="wrap">No report was written.</Text>}
      </Box>
      : <Text dimColor wrap="truncate-end">{o.following?'Following live output.':'Paused. Scroll to the bottom to follow again.'}</Text>}
    {failing.map((check,i) => <Box key={`check-${i}`} flexDirection="column">
      <Text color={o.colour?'red':undefined} wrap="wrap">{sanitizeText([`✗ ${oneLine(check.name)}`,check.timedOut?'timed out':null,check.signal?`signal ${oneLine(check.signal)}`:null,
        check.skipped?`skipped: ${oneLine(check.skipped)}`:null,check.reason?oneLine(check.reason):null].filter(Boolean).join(' · '))}</Text>
      {check.outputTail && <Text dimColor wrap="wrap">{sanitizeText(check.outputTail)}</Text>}
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
    <Button key={key} plain dimColor={state!=='error'} label={`${state==='active'?activeGlyph(o.now):state==='error'?'✗':'✓'} ${oneLine(classify(tool,input).label,Math.max(1,o.width-3))}`} onPress={() => a.tool(key)} />
    {expanded&&<Text dimColor wrap="wrap">{sanitizeText(`${oneLine(tool)} ${input}${output?`\n${output}`:''}`)}</Text>}
  </Box>;
}

/**
 * A condensed run of completed read/search calls: one summary row, expanded into
 * the individual rows on press. Nothing is dropped — the same keys the rows
 * would have had are used inside the group.
 */
function timelineGroup(W: UiComponents, item: Extract<TimelineItem,{kind:'group'}>, o: ViewOptions, a: ViewActions): JSX.Element {
  const {Box,Button,Markdown}=W;
  return <Box key={`row-${item.key}`} flexDirection="column">
    <Button key={item.key} plain dimColor label={`✓ ${timelineGroupLabel(item.reads,item.searches,item.commands)}`} onPress={() => a.tool(item.key)} />
    {o.tools.includes(item.key) && item.events.map(event => event.kind==='tool'
      ? toolRow(W,`event-${event.sequence}`,event.tool,event.input,event.output,event.state,o,a)
      : <Markdown key={`event-${event.sequence}`} text={proseText(event.text)} />)}
  </Box>;
}

/**
 * The in-progress call's marker: a dim `●` that is on one second and off the
 * next, like Claude Code's own running tool. The pane already redraws every
 * second while open, so the blink needs no timer of its own; the blank keeps
 * the label from shifting.
 */
export const activeGlyph=(now: number): string => Math.floor(now/1000)%2===0?'●':' ';

const isProse=(item: TimelineItem): boolean => item.kind==='event'&&item.event.kind==='assistant';
const timelineKey=(item: TimelineItem): string => item.kind==='group'?item.key:`event-${item.event.sequence}`;

/**
 * The worker's words, marked `●` like Claude Code's own transcript so they stand
 * apart from the dimmed tool rows. A text that opens with a heading, list, quote,
 * fence or table is left unmarked: a prefix would break its markdown.
 */
export function proseText(text: string): string {
  const clean=sanitizeText(text).replace(/^\s+/,'');
  return /^(?:#|[-*+]\s|\d+[.)]\s|>|`{3}|~{3}|\|)/.test(clean) ? clean : `● ${clean}`;
}

import type { UiComponents } from 'claude-code';
import type { RadarJob } from '../types/index.d.ts';
import type { ForgeDetail } from './canonical.ts';
import { checksLabel, condenseTimeline, forgeList, isLive, needsAttention, priorTurnSummary, scopeLine, statusLine, timelineGroupLabel, workerHead, workerHeading, workerLivenessLine, workerStatus, type TimelineItem } from './dashboard.ts';
import { effectiveStart, elapsed, isTerminal, oneLine, pendingSteersLabel, pickColor, pickGlyph, sanitizeText } from './format.ts';
import { classify, progressLines } from './progress.ts';
import { extractSteerMessage } from './turns.ts';

export interface ViewActions {
  pick(job: RadarJob): Promise<void>;
  pickTurn(jobId: string | null): Promise<void>;
  page(value: number): Promise<void>;
  back(): Promise<void>;
  task(): Promise<void>;
  tool(key: string): Promise<void>;
  close(): Promise<void>;
  scope?(next: 'session' | 'all'): Promise<void>;
}
export interface ViewOptions {
  width: number; now: number; colour: boolean; page: number; scope: 'session' | 'all';
  following: boolean; taskOpen: boolean; tools: readonly string[];
  pinnedTurnId: string | null;
}

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
    {all.slice(start,start+PAGE_SIZE).map((job,i) => <Box key={`worker-${job.workerId}`} flexDirection="column">
      {start+i===live && <Text bold wrap="truncate-end">Recent</Text>}
      <Button key={`job-${job.workerId}`} plain hotkey={String(i+1)} label={workerHeading(job)} onPress={() => a.pick(job)}>
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

export function renderWorker(W: UiComponents, d: ForgeDetail, o: ViewOptions, a: ViewActions, turns: readonly RadarJob[] = []): JSX.Element {
  const {Box,Text,Button,Markdown} = W;
  const job=d.job;
  const prompt=job.prompt??job.task;
  const taskMessage=extractSteerMessage(prompt);
  const head=workerHead(turns,job.workerId);
  const isPinned=o.pinnedTurnId!==null&&head!==undefined&&head.id!==job.id;
  const headerStart=isPinned?job.startedAt:effectiveStart(job);
  const span=headerStart===null?null:(job.endedAt??o.now)-headerStart;
  const turnNum=job.turn??1;
  const modelPart=oneLine(job.model||(job.role?job.provider:'')||'');
  const header=oneLine([`${pickGlyph(job.status)} ${workerHeading(job)}`,modelPart,(turnNum>1||turns.length>1)?`turn ${turnNum}`:'',span===null?'':elapsed(span),checksLabel(job.acceptance)].filter(Boolean).join(' · '));
  const failing=job.acceptance?.checks.filter(check => !check.ok) ?? [];
  const timelineProse=d.timeline.some(event => event.kind==='assistant');
  const note=(job.status==='running'||job.status==='attention')&&!timelineProse
    ? (job.reasoning?oneLine(job.reasoning,Math.max(1,o.width-6)):'') : '';
  const statusText=workerStatus(job);
  const statusRow=!(job.status==='running'&&job.progress)&&!(job.status==='running'&&statusText==='Running');
  const queuedSteers=!statusRow?pendingSteersLabel(job.pendingSteers):'';
  const changedFiles=isTerminal(job.status)&&job.changedFileCount!=null&&job.changedFileCount>0&&(job.progress?.editedCount??0)===0
    ? job.changedFileCount : 0;
  const livenessLine=workerLivenessLine(job);
  const showProgress=Boolean(job.progress)&&!(job.progress!.phase==='starting'&&(job.toolCount??0)===0&&job.progress!.filesRead===0&&job.progress!.searches===0&&job.progress!.commands===0&&job.progress!.editedCount===0&&job.progress!.testRuns===0&&job.progress!.repeat===null);
  const taskOneLine=oneLine(taskMessage);
  let suppressedFirstTaskMsg=false;
  const visibleTimeline=d.timeline.filter(event => {
    if (!suppressedFirstTaskMsg&&event.kind==='message'&&taskOneLine!==''&&oneLine(event.text)===taskOneLine) {
      suppressedFirstTaskMsg=true;
      return false;
    }
    return true;
  });
  return <Box flexDirection="column">
    <Text bold color={o.colour?pickColor(job.status):undefined} wrap="truncate-end">{header}</Text>
    {statusRow && <Text wrap="truncate-end">{statusText}</Text>}
    {queuedSteers!=='' && <Text color={o.colour?'cyan':undefined} wrap="truncate-end">{queuedSteers}</Text>}
    {changedFiles>0 && <Text dimColor wrap="truncate-end">{`Changed: ${changedFiles} ${changedFiles===1?'file':'files'}`}</Text>}
    {(showProgress||note!==''||livenessLine!==null) && <Box flexDirection="column">
      {showProgress && progressLines(job.progress!, job.toolCount).map((line,i) => <Text key={`progress-${i}`} dimColor={i>0} wrap="truncate-end">{sanitizeText(line)}</Text>)}
      {note!=='' && <Text dimColor wrap="truncate-end">{`Note: ${note}`}</Text>}
      {livenessLine!==null && <Text dimColor={livenessLine.tone==='dim'} color={o.colour&&livenessLine.tone!=='dim'?livenessLine.tone:undefined} wrap="truncate-end">{livenessLine.text}</Text>}
    </Box>}
    {job.warnings.map((warning,i) => <Text key={`warning-${i}`} color={o.colour?'yellow':undefined} wrap="wrap">{sanitizeText(warning.message)}</Text>)}
    {isPinned && head && <Button key="return-live" plain label={oneLine(`↩ Back to Turn ${head.turn} (${isLive(head)?'live':'latest'})`,Math.max(1,o.width-2))} onPress={() => a.pickTurn(null)} />}
    {turns.length>1
      ? <Box flexDirection="column">
        {turns.map((turn,i) => turn.id===job.id
          ? <Text key={`turn-${turn.id}`} bold wrap="truncate-end">{priorTurnSummary(turn,i+1,o.now,{width:Math.max(1,o.width-2),open:true,prompt})}</Text>
          : <Button key={`turn-${turn.id}`} plain dimColor label={priorTurnSummary(turn,i+1,o.now,{width:Math.max(1,o.width-2)})} onPress={() => a.pickTurn(turn.id)} />)}
      </Box>
      : <Text dimColor wrap="truncate-end">{`Task: ${oneLine(taskMessage,Math.max(1,o.width-8))}`}</Text>}
    {o.taskOpen && <Markdown text={sanitizeText(job.preamble?`${job.preamble}\n\n${prompt}`:prompt)} />}
    {o.taskOpen && <Text dimColor wrap="wrap">{sanitizeText(`${oneLine(job.id)}\nWorker: ${oneLine(job.workerId)}${job.pipeline?`\nPipeline: ${oneLine(job.pipeline)} · ${oneLine(job.stage??'stage unknown')}`:''}${job.attempt!=null?`\nAttempt: ${job.attempt}`:''}`)}</Text>}
    {condenseTimeline(visibleTimeline).flatMap((item,i,items) => {
      const row=item.kind==='group'
        ? timelineGroup(W,item,o,a)
        : item.event.kind==='assistant'
          ? <Markdown key={`event-${item.event.sequence}`} text={proseText(item.event.text)} />
          : item.event.kind==='message'
          ? <Text key={`event-${item.event.sequence}`} color={o.colour?'cyan':undefined} wrap="truncate-end">{messageLine(item.event.sender,item.event.text,o.width)}</Text>
          : toolRow(W,`event-${item.event.sequence}`,item.event.tool,item.event.input,item.event.output,item.event.state,o,a);
      return i>0&&isProse(items[i-1]!)!==isProse(item)
        ? [<Box key={`gap-${timelineKey(item)}`}><Text> </Text></Box>,row] : [row];
    })}
    {visibleTimeline.length===0 && <Text dimColor wrap="wrap">{sanitizeText(job.latestSummary??'No worker activity recorded yet.')}</Text>}
    {isTerminal(job.status)
      ? <Box flexDirection="column">
        <Text bold wrap="truncate-end">Result</Text>
        {job.report?.trim()?<Markdown text={sanitizeText(job.report)}/>:<Text dimColor wrap="wrap">No report was written.</Text>}
      </Box>
      : !o.following && <Text dimColor wrap="truncate-end">Paused. Scroll to the bottom to follow again.</Text>}
    {failing.map((check,i) => <Box key={`check-${i}`} flexDirection="column">
      <Text color={o.colour?'red':undefined} wrap="wrap">{sanitizeText([`✗ ${oneLine(check.name)}`,check.timedOut?'timed out':null,check.signal?`signal ${oneLine(check.signal)}`:null,
        check.skipped?`skipped: ${oneLine(check.skipped)}`:null,check.reason?oneLine(check.reason):null].filter(Boolean).join(' · '))}</Text>
      {check.outputTail && <Text dimColor wrap="wrap">{sanitizeText(check.outputTail)}</Text>}
    </Box>)}
    <Box flexDirection="row" gap={2}>
      <Button key="task" plain label="Task" hotkey="t" onPress={a.task} />
      <Button key="back" plain label="Back" hotkey="b" onPress={a.back} />
      <Button key="close" plain label="Close" hotkey="x" onPress={a.close} />
    </Box>
  </Box>;
}

function toolRow(W: UiComponents,key:string,tool:string,input:string,output:string,state:string,o:ViewOptions,a:ViewActions): JSX.Element {
  const {Box,Text,Button}=W;
  const expanded=o.tools.includes(key)||state==='error';
  const glyph=state==='active'?activeGlyph(o.now):state==='error'?'✗':expanded?'▾':'✓';
  return <Box key={`row-${key}`} flexDirection="column">
    <Button key={key} plain dimColor={state!=='error'&&!expanded} label={`${glyph} ${oneLine(classify(tool,input).label,Math.max(1,o.width-3))}`} onPress={() => a.tool(key)} />
    {expanded&&<Box key={`body-${key}`} flexDirection="row">
      <Text>{'  '}</Text>
      <Box flexDirection="column">
        <Text dimColor wrap="wrap">{sanitizeText(`${oneLine(tool)} ${input}${output?`\n${output}`:''}`)}</Text>
      </Box>
    </Box>}
  </Box>;
}

function timelineGroup(W: UiComponents, item: Extract<TimelineItem,{kind:'group'}>, o: ViewOptions, a: ViewActions): JSX.Element {
  const {Box,Text,Button,Markdown}=W;
  const expanded=o.tools.includes(item.key);
  const childOpts={...o,width:Math.max(1,o.width-2)};
  return <Box key={`row-${item.key}`} flexDirection="column">
    <Button key={item.key} plain dimColor={!expanded} label={`${expanded?'▾':'✓'} ${oneLine(timelineGroupLabel(item.reads,item.searches,item.commands),Math.max(1,o.width-3))}`} onPress={() => a.tool(item.key)} />
    {expanded && <Box key={`body-${item.key}`} flexDirection="row">
      <Text>{'  '}</Text>
      <Box flexDirection="column">
        {item.events.map(event => event.kind==='tool'
          ? toolRow(W,`event-${event.sequence}`,event.tool,event.input,event.output,event.state,childOpts,a)
          : event.kind==='message'
          ? <Text key={`event-${event.sequence}`} wrap="truncate-end">{messageLine(event.sender,event.text,childOpts.width)}</Text>
          : <Markdown key={`event-${event.sequence}`} text={proseText(event.text)} />)}
      </Box>
    </Box>}
  </Box>;
}

export function messageLine(sender: 'follow_up' | 'steer', text: string, width: number): string {
  const first=sanitizeText(text).split('\n').map(l => l.trim()).find(l => l!=='')??'';
  return oneLine(`↳ ${sender==='steer'?'steer':'follow-up'} read: ${first}`,Math.max(1,width));
}

export const activeGlyph=(now: number): string => Math.floor(now/1000)%2===0?'●':' ';

const isProse=(item: TimelineItem): boolean => item.kind==='event'&&item.event.kind==='assistant';
const timelineKey=(item: TimelineItem): string => item.kind==='group'?item.key:`event-${item.event.sequence}`;

export function proseText(text: string): string {
  const clean=sanitizeText(text).replace(/^(?:[ \t]*\n)+/,'');
  if (/^(?: {4}|\t)/.test(clean)) return clean;
  const body=clean.replace(/^\s+/,'');
  const firstLine=body.split('\n',1)[0]!;
  return /^(?:#|[-*+]\s|\d+[.)]\s|>|`{3}|~{3}|\||<)/.test(body) || /^(?:[-*_][ \t]*){3,}$/.test(firstLine) ? body : `● ${body}`;
}

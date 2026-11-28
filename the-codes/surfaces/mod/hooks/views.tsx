import type { UiComponents } from 'claude-code';
import type { ActivityEvent, MemberView, RadarJob, TeamMember, TeamMemberState } from '../types/index.d.ts';
import type { ForgeDetail } from './canonical.ts';
import { changedFilesPhrase, condenseTimeline, forgeList, isLive, needsAttention, paneChecksLabel, priorTurnSummary, scopeLine, statusLine, timelineGroupLabel, workerHead, workerHeading, workerLivenessLine, workerStatus, type TimelineItem } from './dashboard.ts';
import { effectiveStart, elapsed, failureWords, isTerminal, oneLine, pendingSteersLabel, pickColor, pickGlyph, prettyJson, sanitizeText } from './format.ts';
import { classify, progressSummaryLine } from './progress.ts';
import { hasTeam, sortMembers, teamHeaderLine } from './team.ts';
import { memberDetailLine, memberHeading, memberRow, nameWidth, TEAM_KEYS, TEAM_ROWS } from './team-view.ts';

export interface ViewActions {
  pick(job: RadarJob): Promise<void>;
  pickTurn(jobId: string | null): Promise<void>;
  page(value: number): Promise<void>;
  back(): Promise<void>;
  task(): Promise<void>;
  tool(key: string): Promise<void>;
  close(): Promise<void>;
  member(id: string): Promise<void>;
  team(): Promise<void>;
  memberBack(): Promise<void>;
  scope?(next: 'session' | 'all'): Promise<void>;
}
export interface ViewOptions {
  width: number; now: number; colour: boolean; page: number; scope: 'session' | 'all';
  following: boolean; taskOpen: boolean; tools: readonly string[];
  pinnedTurnId: string | null; teamOpen: boolean;
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
      {start+i===live && i>0 && <Box key="recent-gap"><Text> </Text></Box>}
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
  const taskMessage=job.messages&&job.messages.length>0?job.messages[0]!.text:prompt;
  const head=workerHead(turns,job.workerId);
  const isPinned=o.pinnedTurnId!==null&&head!==undefined&&head.id!==job.id;
  const headerStart=isPinned?job.startedAt:effectiveStart(job);
  const span=headerStart===null?null:(job.endedAt??o.now)-headerStart;
  const turnNum=job.turn??1;
  const provider=oneLine(job.provider??'');
  const model=oneLine(job.model??'');
  const modelAlreadyPrefixed=provider!==''&&model.toLowerCase().startsWith(provider.toLowerCase())&&/^[-/:_.\s]/.test(model.slice(provider.length));
  const modelPart=provider!==''&&model!==''?(modelAlreadyPrefixed?model:`${provider} ${model}`):(model||provider);
  const line1=oneLine([`${pickGlyph(job.status)} ${workerHeading(job)}`,(turnNum>1||turns.length>1)?`turn ${turnNum}`:'',span===null?'':elapsed(span)].filter(Boolean).join(' · '));
  const reasonPart=job.status==='failed'?failureWords(job):'';
  const filesPart=isTerminal(job.status)?changedFilesPhrase(job):'';
  const line2=oneLine([modelPart,paneChecksLabel(job.acceptance),reasonPart,pendingSteersLabel(job.pendingSteers),filesPart].filter(Boolean).join(' · '));
  const failing=job.acceptance?.checks.filter(check => !check.ok) ?? [];
  const timelineProse=d.timeline.some(event => event.kind==='assistant');
  const note=(job.status==='running'||job.status==='attention')&&!timelineProse
    ? (job.reasoning?oneLine(job.reasoning,Math.max(1,o.width-6)):'') : '';
  const livenessLine=workerLivenessLine(job);
  const showProgress=(job.status==='running'||job.status==='attention')&&Boolean(job.progress)&&!(job.progress!.phase==='starting'&&(job.toolCount??0)===0&&job.progress!.filesRead===0&&job.progress!.searches===0&&job.progress!.commands===0&&job.progress!.editedCount===0&&job.progress!.testRuns===0&&job.progress!.repeat===null);
  const line3=showProgress?progressSummaryLine(job.progress!):'';
  const storedTexts=new Set((job.messages??[]).map(m => oneLine(m.text)).filter(Boolean));
  const taskOneLine=oneLine(taskMessage);
  let suppressedFirstTaskMsg=false;
  const visibleTimeline=d.timeline.filter(event => {
    if (event.kind==='message') {
      const eventLine=oneLine(event.text);
      if (storedTexts.size>0) {
        if (event.delivery==='turn-start'&&storedTexts.has(eventLine)) return false;
      } else if (!suppressedFirstTaskMsg&&taskOneLine!==''&&eventLine===taskOneLine) {
        suppressedFirstTaskMsg=true;
        return false;
      }
    }
    return true;
  });
  return <Box flexDirection="column">
    <Text bold color={o.colour?pickColor(job.status):undefined} wrap="truncate-end">{line1}</Text>
    {line2!=='' && <Text dimColor wrap="truncate-end">{line2}</Text>}
    {hasTeam(job.team) && <Text dimColor wrap="truncate-end">{teamHeaderLine(job.team)}</Text>}
    {line3!=='' && <Text wrap="truncate-end">{sanitizeText(line3)}</Text>}
    {note!=='' && <Text dimColor wrap="truncate-end">{`Note: ${note}`}</Text>}
    {livenessLine!==null && <Text dimColor={livenessLine.tone==='dim'} color={o.colour&&livenessLine.tone!=='dim'?livenessLine.tone:undefined} wrap="truncate-end">{livenessLine.text}</Text>}
    {job.warnings.map((warning,i) => <Text key={`warning-${i}`} color={o.colour?'yellow':undefined} wrap="wrap">{sanitizeText(warning.message)}</Text>)}
    {isPinned && head && <Button key="return-live" plain label={oneLine(`↩ Back to Turn ${head.turn} (${isLive(head)?'live':'latest'})`,Math.max(1,o.width-2))} onPress={() => a.pickTurn(null)} />}
    <Box key="header-gap"><Text> </Text></Box>
    {turns.length>1
      ? <Box flexDirection="column">
        {turns.map((turn,i) => turn.id===job.id
          ? <Text key={`turn-${turn.id}`} bold wrap="truncate-end">{priorTurnSummary(turn,i+1,o.now,{width:Math.max(1,o.width-2),open:true,prompt,messages:job.messages})}</Text>
          : <Button key={`turn-${turn.id}`} plain dimColor label={priorTurnSummary(turn,i+1,o.now,{width:Math.max(1,o.width-2)})} onPress={() => a.pickTurn(turn.id)} />)}
      </Box>
      : <Text dimColor wrap="truncate-end">{`Task: ${oneLine(taskMessage,Math.max(1,o.width-8))}`}</Text>}
    {o.taskOpen && <Markdown text={sanitizeText(job.preamble?`${job.preamble}\n\n${prompt}`:prompt)} />}
    {o.taskOpen && <Text dimColor wrap="wrap">{sanitizeText(`${oneLine(job.id)}\nWorker: ${oneLine(job.workerId)}${job.pipeline?`\nPipeline: ${oneLine(job.pipeline)} · ${oneLine(job.stage??'stage unknown')}`:''}${job.attempt!=null?`\nAttempt: ${job.attempt}`:''}`)}</Text>}
    {hasTeam(job.team) && teamSection(W,job.team.members,o,a)}
    {visibleTimeline.length>0 && <Box key="transcript-gap"><Text> </Text></Box>}
    {timelineRows(W,visibleTimeline,o,a)}
    {visibleTimeline.length===0 && !isTerminal(job.status) && <Text dimColor wrap="wrap">{sanitizeText(job.latestSummary??'No worker activity recorded yet.')}</Text>}
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
      {hasTeam(job.team) && job.team.members.length > TEAM_ROWS && <Button key="team" plain label="Team" hotkey="m" onPress={a.team} />}
      <Button key="back" plain label="Back" hotkey="b" onPress={a.back} />
      <Button key="close" plain label="Close" hotkey="x" onPress={a.close} />
    </Box>
  </Box>;
}

function teamSection(W: UiComponents, all: readonly TeamMember[], o: ViewOptions, a: ViewActions): JSX.Element {
  const {Box,Text,Button}=W;
  const members=sortMembers(all);
  const shown=o.teamOpen?members:members.slice(0,TEAM_ROWS);
  const hidden=members.length-shown.length;
  const cw=Math.max(1,o.width-4);
  const names=nameWidth(shown,24);
  return <Box key="team-section" flexDirection="column">
    <Box key="team-gap"><Text> </Text></Box>
    <Text bold wrap="truncate-end">Team</Text>
    {shown.map((m,i) => {
      const line=memberRow(m,o.now,cw,names);
      const glyph=line.slice(0,1);
      return <Button key={`member-${m.id}`} plain {...(i<TEAM_KEYS?{hotkey:String(i+1)}:{})} label={line} onPress={() => a.member(m.id)}>
        <Text color={o.colour?memberColor(m.state):undefined} wrap="truncate-end">{glyph}</Text>
        {line.slice(1)}
      </Button>;
    })}
    {hidden>0 && <Text dimColor wrap="truncate-end">{`  + ${hidden} more · m: all`}</Text>}
  </Box>;
}

const memberColor=(state: TeamMemberState): 'blue' | 'green' | 'red' | undefined =>
  state==='working'?'blue':state==='done'?'green':state==='failed'?'red':undefined;

export function renderMember(W: UiComponents, job: RadarJob, member: TeamMember, view: MemberView | null, o: ViewOptions, a: ViewActions): JSX.Element {
  const {Box,Text,Button,Markdown}=W;
  const task=oneLine(member.task??'');
  const timeline=view?.timeline??[];
  return <Box flexDirection="column">
    <Text bold color={o.colour?memberColor(member.state):undefined} wrap="truncate-end">{memberHeading(member,workerHeading(job),o.now)}</Text>
    <Text dimColor wrap="truncate-end">{memberDetailLine(member)}</Text>
    <Box key="header-gap"><Text> </Text></Box>
    {task!=='' && <Text dimColor wrap="truncate-end">{`Task: ${oneLine(task,Math.max(1,o.width-8))}`}</Text>}
    {view===null
      ? <Text dimColor wrap="wrap">No detail recorded yet.</Text>
      : <Box flexDirection="column">
        {o.taskOpen && (view.brief?.trim() ?? '')!=='' && <Markdown text={sanitizeText(view.brief!)} />}
        {timeline.length>0 && <Box key="transcript-gap"><Text> </Text></Box>}
        {timelineRows(W,timeline,o,a)}
        <Text bold wrap="truncate-end">Result</Text>
        {view.report?.trim()?<Markdown text={sanitizeText(view.report)}/>
          :<Text dimColor wrap="wrap">{member.state==='working'?'No post yet.':'No report recorded.'}</Text>}
      </Box>}
    <Box flexDirection="row" gap={2}>
      <Button key="task" plain label="Task" hotkey="t" onPress={a.task} />
      <Button key="back" plain label="Back" hotkey="b" onPress={a.memberBack} />
      <Button key="close" plain label="Close" hotkey="x" onPress={a.close} />
    </Box>
  </Box>;
}

function timelineRows(W: UiComponents, timeline: readonly ActivityEvent[], o: ViewOptions, a: ViewActions): JSX.Element[] {
  const {Box,Text,Markdown}=W;
  return condenseTimeline(timeline).flatMap((item,i,items) => {
    const followedByProse=i+1<items.length&&isProse(items[i+1]!)!==isProse(item);
    const row=item.kind==='group'
      ? timelineGroup(W,item,o,a,!followedByProse)
      : item.event.kind==='assistant'
        ? <Markdown key={`event-${item.event.sequence}`} text={proseText(item.event.text)} />
        : item.event.kind==='message'
        ? <Text key={`event-${item.event.sequence}`} color={o.colour?'cyan':undefined} wrap="truncate-end">{messageLine(item.event.sender,item.event.text,o.width)}</Text>
        : toolRow(W,`event-${item.event.sequence}`,item.event.tool,item.event.input,item.event.output,item.event.state,o,a,!followedByProse);
    return i>0&&isProse(items[i-1]!)!==isProse(item)
      ? [<Box key={`gap-${timelineKey(item)}`}><Text> </Text></Box>,row] : [row];
  });
}

function toolRow(W: UiComponents,key:string,tool:string,input:string,output:string,state:string,o:ViewOptions,a:ViewActions,trailingGap=true): JSX.Element {
  const {Box,Text,Button}=W;
  const expanded=o.tools.includes(key);
  const glyph=state==='active'?activeGlyph(o.now):state==='error'?'✗':expanded?'▾':'✓';
  const label=`${glyph} ${oneLine(classify(tool,input,output).label,Math.max(1,o.width-3))}`;
  return <Box key={`row-${key}`} flexDirection="column">
    {state==='error'
      ? <Button key={key} plain dimColor={false} label={label} onPress={() => a.tool(key)}>
        <Text color={o.colour?'red':undefined} wrap="truncate-end">{label}</Text>
      </Button>
      : <Button key={key} plain dimColor={!expanded} label={label} onPress={() => a.tool(key)} />}
    {expanded&&<Box key={`body-${key}`} flexDirection="row">
      <Text>{'  '}</Text>
      <Box flexDirection="column">
        <Text dimColor wrap="wrap">{sanitizeText(`${oneLine(tool)} ${input}${output?`\n${prettyJson(output)}`:''}`)}</Text>
      </Box>
    </Box>}
    {expanded&&trailingGap&&<Box key={`end-${key}`}><Text> </Text></Box>}
  </Box>;
}

function timelineGroup(W: UiComponents, item: Extract<TimelineItem,{kind:'group'}>, o: ViewOptions, a: ViewActions, trailingGap=true): JSX.Element {
  const {Box,Text,Button,Markdown}=W;
  const expanded=o.tools.includes(item.key);
  const childOpts={...o,width:Math.max(1,o.width-2)};
  return <Box key={`row-${item.key}`} flexDirection="column">
    <Button key={item.key} plain dimColor={!expanded} label={`${expanded?'▾':'✓'} ${oneLine(timelineGroupLabel(item.reads,item.searches,item.commands,item.team),Math.max(1,o.width-3))}`} onPress={() => a.tool(item.key)} />
    {expanded && <Box key={`body-${item.key}`} flexDirection="row">
      <Text>{'  '}</Text>
      <Box flexDirection="column">
        {item.events.map((event,i) => event.kind==='tool'
          ? toolRow(W,`event-${event.sequence}`,event.tool,event.input,event.output,event.state,childOpts,a,i<item.events.length-1)
          : event.kind==='message'
          ? <Text key={`event-${event.sequence}`} wrap="truncate-end">{messageLine(event.sender,event.text,childOpts.width)}</Text>
          : <Markdown key={`event-${event.sequence}`} text={proseText(event.text)} />)}
      </Box>
    </Box>}
    {expanded&&trailingGap&&<Box key={`end-${item.key}`}><Text> </Text></Box>}
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

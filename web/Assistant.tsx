import {useEffect,useRef,useState,type FormEvent} from 'react';
import {ASSISTANT_LIMITS,type AssistantAnswer,type AssistantEvidence,type AssistantOptions,type AssistantPreview,type AssistantReply} from '../shared/assistant.js';

type Destination='Diagnostics'|'Playback'|'Systems'|'Settings';
type Props={active:boolean;prompt:{text:string;revision:number;focusJobId?:string};onNavigate:(target:Destination,jobId?:string)=>void};
type Turn={question:string;reply:AssistantReply;preview:AssistantPreview};
const starters=[
  {label:'Explain latest results',question:'Explain my latest saved results in plain language. What was measured, what is uncertain, and what should I check next?'},
  {label:'What should I improve first?',question:'Prioritise practical improvements from my saved evidence. For each, explain the expected benefit, trade-offs, exact next steps, and how I can verify whether it helped.'},
  {label:'Compare DNS and IPv6',question:'Compare my system DNS and public resolver results across IPv4, IPv6, UDP, TCP, A and AAAA. Consider reliability and coverage before latency. Which differences are meaningful, and what remains untested?'},
  {label:'Help with streaming',question:'Help diagnose streaming using my saved Internet and playback evidence. Separate buffering, network paths, device or decoding issues, and unmeasured causes. What should I do next?'},
];
const when=(value:number)=>new Date(value).toLocaleString();
const destination=(source:AssistantEvidence):Destination=>source.kind==='playback'?'Playback':['system-stats','inventory'].includes(source.kind)?'Systems':'Diagnostics';
const sourceElementId=(id:string)=>'assistant-evidence-'+encodeURIComponent(id);
class AssistantApiError extends Error {
  constructor(message:string,readonly statusCode:number){super(message);}
}

async function api<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetch('/api/v1/assistant/'+path,{signal,...(body!==undefined?{method:'POST',body:JSON.stringify(body)}:{}),
    headers:{'Content-Type':'application/json','X-Neo-Client':'local-ui'}});
  const value=await response.json();
  if(!response.ok)throw new AssistantApiError(value.error??'The assistant request could not be completed.',response.status);
  return value as T;
}

function Citations({ids,evidence,onEvidence}:{ids:string[];evidence:AssistantEvidence[];onEvidence:(id:string)=>void}){
  const sources=ids.map(id=>evidence.find(source=>source.id===id)).filter((source):source is AssistantEvidence=>!!source);
  return sources.length?<div className="assistant-citations" aria-label="Supporting evidence">{sources.map(source=><button key={source.id} className="assistant-citation" aria-label={'View evidence '+source.id+': '+source.title} onClick={()=>onEvidence(source.id)}>{source.id} · {source.title}</button>)}</div>:null;
}

function Answer({answer,evidence,onEvidence,onQuestion}:{answer:AssistantAnswer;evidence:AssistantEvidence[];onEvidence:(id:string)=>void;onQuestion:(question:string)=>void}){
  return <div className="assistant-answer">
    <p className="assistant-summary assistant-prose">{answer.summary}</p>
    {answer.findings.length>0&&<section><h4>What the results mean</h4>{answer.findings.map((finding,index)=><div className="assistant-finding" key={index}>
      <div className="assistant-card-title"><h5>{finding.title}</h5><span className={'badge assistant-confidence-'+finding.confidence}>{finding.confidence==='measured'?'Measured':finding.confidence==='likely'?'Likely cause':'Uncertain'}</span></div>
      <p className="assistant-prose">{finding.explanation}</p><Citations ids={finding.evidenceIds} evidence={evidence} onEvidence={onEvidence}/>
    </div>)}</section>}
    {answer.actions.length>0&&<section><h4>Ways to improve things</h4><ol className="assistant-action-list">{answer.actions.map((action,index)=><li key={index} className="assistant-action">
      <div className="assistant-card-title"><h5>{index+1}. {action.title}</h5><span className={'badge assistant-priority-'+action.priority}>{action.priority} priority</span></div>
      <p className="assistant-prose">{action.why}</p><ol>{action.steps.map((step,stepIndex)=><li className="assistant-prose" key={stepIndex}>{step}</li>)}</ol>
      <p className="assistant-prose"><strong>Check whether it helped:</strong> {action.verification}</p>
      {action.tradeoff&&<p className="assistant-prose"><strong>Trade-off:</strong> {action.tradeoff}</p>}
      <Citations ids={action.evidenceIds} evidence={evidence} onEvidence={onEvidence}/>
    </li>)}</ol></section>}
    {answer.limitations.length>0&&<section className="assistant-limitations"><h4>What remains uncertain</h4><ul>{answer.limitations.map((value,index)=><li className="assistant-prose" key={index}>{value}</li>)}</ul></section>}
    {answer.followUpQuestions.length>0&&<section><h4>Useful follow-up questions</h4><div className="assistant-followups">{answer.followUpQuestions.map((question,index)=><button key={index} onClick={()=>onQuestion(question)}>{question}</button>)}</div></section>}
  </div>;
}

export function Assistant({active,prompt,onNavigate}:Props){
  const [options,setOptions]=useState<AssistantOptions|null>(null),[optionsError,setOptionsError]=useState('');
  const [preview,setPreview]=useState<AssistantPreview|null>(null),[previewError,setPreviewError]=useState(''),[previewLoading,setPreviewLoading]=useState(false);
  const [includeIdentifiers,setIncludeIdentifiers]=useState(false),[consent,setConsent]=useState(false);
  const [draft,setDraft]=useState(''),[turns,setTurns]=useState<Turn[]>([]),[pending,setPending]=useState<string|null>(null),[error,setError]=useState(''),[status,setStatus]=useState('');
  const [now,setNow]=useState(Date.now);
  const previewRef=useRef<AssistantPreview|null>(null),conversationRef=useRef<string|undefined>(undefined);
  const pendingRef=useRef<{id:string;controller:AbortController}|null>(null),previewController=useRef<AbortController|null>(null),optionsController=useRef<AbortController|null>(null);
  const initialized=useRef(false),lastPrompt=useRef(0),reviewRevision=useRef(0),retryRequest=useRef<{key:string;id:string}|null>(null);
  const previewFocus=useRef<string|undefined>(undefined);
  const composer=useRef<HTMLTextAreaElement|null>(null);
  const limits=options?.limits??ASSISTANT_LIMITS;
  const lastReply=turns.at(-1)?.reply;
  const reviewExpiresAt=lastReply?lastReply.createdAt+limits.conversationTtlMs:preview?.expiresAt;
  const expired=reviewExpiresAt!==undefined&&reviewExpiresAt<=now;
  const turnsRemaining=turns.at(-1)?.reply.turnsRemaining??limits.turns;

  async function loadOptions(){
    optionsController.current?.abort();const controller=new AbortController();optionsController.current=controller;
    try{const result=await api<AssistantOptions>('options',undefined,controller.signal);if(!controller.signal.aborted){setOptions(result);setOptionsError('');}}
    catch{if(!controller.signal.aborted)setOptionsError('Could not check the assistant connection. Retry when the collector is available.');}
  }
  async function refreshEvidence(identifiers=includeIdentifiers,focusJobId=prompt.focusJobId){
    if(pendingRef.current)return;
    const revision=++reviewRevision.current;previewController.current?.abort();const controller=new AbortController();previewController.current=controller;
    previewFocus.current=focusJobId;
    const old=previewRef.current,conversationId=conversationRef.current;
    previewRef.current=null;conversationRef.current=undefined;retryRequest.current=null;
    setPreview(null);setTurns([]);setConsent(false);setPreviewError('');setError('');setStatus('');setPreviewLoading(true);
    try{
      if(old)await api('reset',{previewId:old.previewId,...(conversationId?{conversationId}:{})},controller.signal);
      const result=await api<AssistantPreview>('preview',{includeIdentifiers:identifiers,...(focusJobId?{focusJobId}:{})},controller.signal);
      if(controller.signal.aborted||revision!==reviewRevision.current)return;
      previewRef.current=result;setPreview(result);setNow(Date.now());
    }catch(value){if(!controller.signal.aborted&&revision===reviewRevision.current)setPreviewError(value instanceof Error?value.message:'Could not prepare saved evidence.');}
    finally{if(revision===reviewRevision.current)setPreviewLoading(false);}
  }
  function chooseQuestion(question:string){setDraft(question);setError('');composer.current?.focus();}
  function showEvidence(id:string){
    const element=document.getElementById(sourceElementId(id));
    if(element instanceof HTMLDetailsElement){element.open=true;element.scrollIntoView({block:'nearest'});element.querySelector('summary')?.focus();}
  }
  useEffect(()=>{
    if(!active)return;
    void loadOptions();
    if(!initialized.current){initialized.current=true;void refreshEvidence();}
    const focus=()=>void loadOptions(),timer=setInterval(()=>setNow(Date.now()),15000);
    window.addEventListener('focus',focus);
    return()=>{window.removeEventListener('focus',focus);clearInterval(timer);optionsController.current?.abort();};
  },[active]);
  useEffect(()=>{
    if(!prompt.revision||prompt.revision===lastPrompt.current)return;
    lastPrompt.current=prompt.revision;setDraft(prompt.text);setError('');
  },[prompt.revision,prompt.text]);
  useEffect(()=>{if(active&&initialized.current&&!pending&&previewFocus.current!==prompt.focusJobId)void refreshEvidence(includeIdentifiers,prompt.focusJobId);},[active,prompt.focusJobId,pending]);
  useEffect(()=>()=>{previewController.current?.abort();optionsController.current?.abort();pendingRef.current?.controller.abort();},[]);

  async function send(event:FormEvent){
    event.preventDefault();const context=previewRef.current,message=draft.trim();
    if(pendingRef.current||!context||!options?.available||!consent||!message||message.length>limits.messageCharacters||turnsRemaining<=0)return;
    if((reviewExpiresAt??context.expiresAt)<=Date.now()){setNow(Date.now());setError('This evidence review has expired. Start a new conversation with current evidence.');return;}
    const key=JSON.stringify([context.previewId,conversationRef.current,message]);
    const requestId=retryRequest.current?.key===key?retryRequest.current.id:crypto.randomUUID();retryRequest.current={key,id:requestId};
    const controller=new AbortController();pendingRef.current={id:requestId,controller};setPending(message);setError('');setStatus('');
    try{
      const reply=await api<AssistantReply>('chat',{requestId,previewId:context.previewId,...(conversationRef.current?{conversationId:conversationRef.current}:{}),message,confirmed:true},controller.signal);
      if(controller.signal.aborted||pendingRef.current?.id!==requestId)return;
      conversationRef.current=reply.conversationId;retryRequest.current=null;
      setTurns(current=>[...current,{question:message,reply,preview:context}]);setDraft(current=>current.trim()===message?'':current);setStatus('Reply ready. Review the supporting evidence and suggested checks.');
    }catch(value){if(!controller.signal.aborted){
      // A definitive rejected request can be tried again deliberately; uncertain transport failures must replay the same id.
      if(value instanceof AssistantApiError)retryRequest.current=null;
      setError(value instanceof Error?value.message:'The assistant could not reply. Your question has been kept.');
    }}
    finally{if(pendingRef.current?.id===requestId){pendingRef.current=null;setPending(null);}}
  }
  async function cancel(){
    const request=pendingRef.current;if(!request)return;
    request.controller.abort();pendingRef.current=null;setPending(null);retryRequest.current=null;
    setStatus('Reply cancelled. Your question has been kept.');
    try{await api('cancel',{requestId:request.id});}catch{setError('The reply was stopped here, but cancellation could not be confirmed with the collector. Check the connection before sending again.');}
  }

  const sources=preview?.context.evidence??[];
  const omitted=preview?Object.values(preview.context.omitted).reduce((sum,count)=>sum+count,0):0;
  const canSend=!!options?.available&&!!preview&&!previewLoading&&!expired&&consent&&!!draft.trim()&&draft.trim().length<=limits.messageCharacters&&!pending&&turnsRemaining>0;
  return <section hidden={!active} className="neo-assistant" aria-labelledby="assistant-heading">
    <div className="section-title assistant-heading"><div><div className="eyebrow">EXPLAIN · PRIORITISE · VERIFY</div><h2 id="assistant-heading">NEO assistant</h2><p>Understand your measurements and choose a practical next step.</p></div>
      <span className="badge">{options?.available?'OpenAI configured':'OpenAI setup'}</span></div>
    <p>The assistant uses the saved evidence you review below. It explains findings, compares possible causes and suggests improvements with checks to confirm the result. Suggested changes are yours to apply.</p>
    {optionsError&&<p className="error" role="alert">{optionsError} <button onClick={()=>void loadOptions()}>Retry assistant connection</button></p>}
    {options&&!options.available&&<section className="panel assistant-setup"><h3>Connect OpenAI to ask the assistant</h3><p>{options.reason??'Configure an OpenAI API key on the computer running this collector.'}</p>
      <p>You can review the local evidence below while setting it up. The assistant uses an OpenAI API key; signing into ChatGPT here does not configure the collector.</p>
      <div className="actions">{window.neoDesktop&&<button onClick={()=>void window.neoDesktop!.connection('assistant')}>Configure desktop assistant</button>}<button onClick={()=>void loadOptions()}>Check connection again</button><button onClick={()=>onNavigate('Settings')}>Open NEO settings</button></div></section>}
    <div className="assistant-layout"><div className="assistant-workspace">
      <section className="panel assistant-review" aria-labelledby="assistant-review-heading"><div className="assistant-card-title"><h3 id="assistant-review-heading">Evidence for this conversation</h3>
        <button disabled={!!pending||previewLoading} onClick={()=>void refreshEvidence()}>{turns.length?'New conversation with latest evidence':'Refresh evidence'}</button></div>
        <label className="check"><input type="checkbox" checked={includeIdentifiers} disabled={!!pending||previewLoading} onChange={event=>{setIncludeIdentifiers(event.target.checked);void refreshEvidence(event.target.checked);}}/>Include network addresses and names in the reviewed evidence</label>
        <p className="muted">Aliases are used by default. Changing this choice prepares a new evidence review and starts a new conversation.</p>
        {previewLoading&&<p role="status">Preparing saved evidence on this collector…</p>}
        {previewError&&<p className="error" role="alert">{previewError} <button disabled={previewLoading} onClick={()=>void refreshEvidence()}>Retry evidence review</button></p>}
        {preview&&<><p><strong>{sources.length} saved {sources.length===1?'record':'records'}</strong> · prepared {when(preview.createdAt)}{includeIdentifiers?' · addresses and names included':' · identifiers minimised'}</p>
          {sources.length===0&&<p className="notice">There are no saved measurements to explain yet. The assistant can help you choose the first useful check, but cannot diagnose an unmeasured network.</p>}
          <ul className="assistant-disclosure">{preview.disclosure.map((line,index)=><li key={index}>{line}</li>)}</ul>
          <details><summary>Review the exact evidence sent to OpenAI</summary><pre className="assistant-evidence-text">{preview.outboundEvidence}</pre></details>
          {omitted>0&&<p className="caution">{omitted} older or excess records are outside this bounded review. The assistant sees only the records listed here.</p>}
          {expired?<p className="caution" role="status">This review has expired. Refresh the evidence before asking another question.</p>:<p className="muted">{lastReply?'Conversation available':'Review valid'} until {when(reviewExpiresAt??preview.expiresAt)}. New measurements are included only when you refresh the evidence.</p>}
        </>}
      </section>
      {turns.length>0&&<section className="assistant-conversation" aria-label="Assistant conversation">{turns.map(turn=><article className="panel assistant-turn" key={turn.reply.requestId}>
        <div className="assistant-question"><div className="eyebrow">YOU</div><p className="assistant-prose">{turn.question}</p></div>
        <div className="assistant-reply-heading"><h3>NEO assistant</h3><p className="muted">{turn.reply.model} · {when(turn.reply.createdAt)}</p></div>
        <Answer answer={turn.reply.answer} evidence={turn.preview.context.evidence} onEvidence={showEvidence} onQuestion={chooseQuestion}/>
        <p className="muted assistant-turn-meta">Based on evidence reviewed {when(turn.preview.createdAt)}. {turn.reply.turnsRemaining} follow-up {turn.reply.turnsRemaining===1?'turn':'turns'} remaining.</p>
      </article>)}</section>}
      <section className="panel assistant-compose"><h3>{turns.length?'Ask a follow-up':'What would you like to understand?'}</h3>
        {!turns.length&&<div className="assistant-starters">{starters.map(starter=><button key={starter.label} disabled={!!pending} onClick={()=>chooseQuestion(starter.question)}>{starter.label}</button>)}</div>}
        <form onSubmit={event=>void send(event)}><label className="field">Your question<textarea ref={composer} value={draft} onChange={event=>setDraft(event.target.value)} rows={4} maxLength={limits.messageCharacters} disabled={!!pending} placeholder="For example: IPv6 DNS failed while IPv4 worked. What does that tell us?"/></label>
          <p className="muted">{draft.length}/{limits.messageCharacters} characters · Your question is sent as written. Keep passwords and API keys out of the chat.</p>
          <label className="check assistant-consent"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} disabled={!preview||!!pending||previewLoading||expired}/>Send the reviewed evidence, my question and this conversation to OpenAI.</label>
          {turnsRemaining<=0&&<p className="notice">This conversation has reached its turn limit. Start a new conversation with the latest evidence to continue.</p>}
          <div className="actions"><button type="submit" className="primary" disabled={!canSend}>{pending?'Preparing your explanation…':'Ask assistant'}</button>{pending&&<button type="button" onClick={()=>void cancel()}>Cancel reply</button>}</div>
        </form>
        {pending&&<div className="notice" role="status"><strong>Considering your reviewed measurements…</strong><p>The answer will include evidence, uncertainty and suggested checks. You can cancel or keep using NEO.</p></div>}
        {error&&<p className="error" role="alert">{error}</p>}
        {status&&<p className="muted" role="status">{status}</p>}
        <p className="muted">Conversation state is temporary. Refreshing the page clears this view; the collector expires its in-memory conversation. NEO does not save the chat to its database.</p>
      </section>
    </div>
    <aside className="assistant-evidence-column" aria-label="Reviewed measurement sources">
      <section className="panel"><h3>Supporting measurements</h3><p className="muted">Each answer can link back to these saved records, their time and where they were measured.</p>
        {sources.length? <div className="assistant-sources">{sources.map(source=><details className="assistant-source" id={sourceElementId(source.id)} key={source.id}><summary><span className="assistant-source-id">{source.id}</span> {source.title}</summary>
          <p className="muted">{when(source.observedAt)} · {source.vantage} · {source.complete?'Complete record':'Partial record'}</p>
          <p>{source.summary}</p>{source.limitations.length>0&&<ul className="muted">{source.limitations.map((line,index)=><li key={index}>{line}</li>)}</ul>}
          <pre className="assistant-evidence-text">{JSON.stringify(source.facts,null,2)}</pre><button onClick={()=>onNavigate(destination(source),destination(source)==='Diagnostics'?source.sourceId:undefined)}>Open {destination(source).toLowerCase()}</button>
        </details>)}</div>:<p>No saved records in this review.</p>}
      </section>
      {preview&&preview.context.findings.length>0&&<section className="panel"><h3>Local findings</h3><p className="muted">These findings come from NEO’s existing measurement rules and are available before an AI request.</p>{preview.context.findings.map(finding=><div className="assistant-local-finding" key={finding.id}>
        <h4>{finding.title}</h4><p>{finding.detail}</p><p><strong>Next check:</strong> {finding.nextStep}</p><Citations ids={finding.evidenceIds} evidence={sources} onEvidence={showEvidence}/>
      </div>)}</section>}
      {preview&&preview.context.missingEvidence.length>0&&<section className="panel"><h3>Evidence still needed</h3><ul>{preview.context.missingEvidence.map((line,index)=><li key={index}>{line}</li>)}</ul><div className="actions"><button onClick={()=>onNavigate('Diagnostics')}>Open diagnostics</button><button onClick={()=>onNavigate('Playback')}>Open playback</button></div></section>}
    </aside></div>
  </section>;
}

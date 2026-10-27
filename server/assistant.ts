import {createHash,randomUUID} from 'node:crypto';
import {ASSISTANT_LIMITS,type AssistantChatRequest,type AssistantPreview,type AssistantReply} from '../shared/assistant.js';
import {buildAssistantContext} from './assistant-context.js';
import {OpenAIAssistantProvider,type AssistantProvider,type AssistantTurn} from './assistant-provider.js';
import {RequestError} from './jobs.js';
import type {Store} from './store.js';

type Source=Pick<Store,'jobs'|'assets'|'stats'|'playback'>;
interface Conversation {id:string;preview:AssistantPreview;turns:AssistantTurn[];updatedAt:number}
interface RequestEntry {fingerprint:string;previewId:string;conversationId:string;createdAt:number;done:Promise<AssistantReply>}
interface Active {requestId:string;previewId:string;conversationId:string;controller:AbortController;done:Promise<AssistantReply>}

function data(value:unknown,allowed:string[]):Record<string,unknown>{
  if(typeof value!=='object'||value===null||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new RequestError(400,'Invalid assistant request.');
  return value as Record<string,unknown>;
}
function identifier(value:unknown,label:string):string {
  if(typeof value!=='string'||!/^[A-Za-z0-9-]{8,80}$/.test(value))throw new RequestError(400,'Invalid '+label+'.');return value;
}
export function parseAssistantChat(value:unknown):AssistantChatRequest {
  const body=data(value,['requestId','previewId','conversationId','message','confirmed']);
  if(body.confirmed!==true)throw new RequestError(400,'Review the evidence and confirm sending it to OpenAI.');
  if(typeof body.message!=='string'||!body.message.trim()||body.message.length>ASSISTANT_LIMITS.messageCharacters||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body.message))throw new RequestError(400,'Enter a question of at most '+ASSISTANT_LIMITS.messageCharacters+' characters.');
  return {requestId:identifier(body.requestId,'request ID'),previewId:identifier(body.previewId,'preview ID'),
    ...(body.conversationId!==undefined?{conversationId:identifier(body.conversationId,'conversation ID')} : {}),message:body.message.trim(),confirmed:true};
}

/** Ephemeral chat state; never writes conversation text or API credentials to the evidence database. */
export class AssistantService {
  private readonly previews=new Map<string,AssistantPreview>();
  private readonly conversations=new Map<string,Conversation>();
  private readonly requests=new Map<string,RequestEntry>();
  private active:Active|null=null;
  private closing=false;
  private cleanupTimer:NodeJS.Timeout|null=null;
  constructor(private readonly source:Source,private readonly provider:AssistantProvider=new OpenAIAssistantProvider(),private readonly now:()=>number=Date.now){}
  options(){return this.provider.options();}
  private prune(){
    const now=this.now();
    for(const [id,preview] of this.previews)if(preview.expiresAt<=now&&this.active?.previewId!==id)this.previews.delete(id);
    for(const [id,conversation] of this.conversations)if(conversation.updatedAt+ASSISTANT_LIMITS.conversationTtlMs<=now&&this.active?.conversationId!==id)this.conversations.delete(id);
    for(const [id,entry] of this.requests)if(entry.createdAt+ASSISTANT_LIMITS.conversationTtlMs<=now&&this.active?.requestId!==id)this.requests.delete(id);
    this.scheduleCleanup();
  }
  private scheduleCleanup(){
    if(this.cleanupTimer)clearTimeout(this.cleanupTimer);
    this.cleanupTimer=null;
    if(this.closing)return;
    const deadlines=[...this.previews.values()].filter(item=>item.previewId!==this.active?.previewId).map(item=>item.expiresAt)
      .concat([...this.conversations.values()].filter(item=>item.id!==this.active?.conversationId).map(item=>item.updatedAt+ASSISTANT_LIMITS.conversationTtlMs))
      .concat([...this.requests.entries()].filter(([id])=>id!==this.active?.requestId).map(([,item])=>item.createdAt+ASSISTANT_LIMITS.conversationTtlMs));
    if(deadlines.length)this.cleanupTimer=setTimeout(()=>this.prune(),Math.max(1,Math.min(...deadlines)-this.now())).unref();
  }
  preview(value:unknown):AssistantPreview {
    if(this.closing)throw new RequestError(503,'The collector is shutting down.');
    const body=data(value,['includeIdentifiers','focusJobId']);
    if(body.includeIdentifiers!==undefined&&typeof body.includeIdentifiers!=='boolean')throw new RequestError(400,'Choose whether to include network identifiers.');
    const focusJobId=body.focusJobId===undefined?undefined:identifier(body.focusJobId,'job ID');
    this.prune();
    if(this.previews.size>=16){
      const oldest=[...this.previews.keys()].find(id=>id!==this.active?.previewId&&! [...this.conversations.values()].some(conversation=>conversation.preview.previewId===id));
      if(oldest)this.previews.delete(oldest);
      else throw new RequestError(409,'Too many active evidence previews. Start a new conversation after clearing an old one.');
    }
    const createdAt=this.now();
    // Freeze exactly what was reviewed. Subsequent collector results cannot silently change the upload.
    const built=buildAssistantContext(this.source,{includeIdentifiers:body.includeIdentifiers===true,now:createdAt,focusJobId});
    const outboundEvidence=JSON.stringify(built);
    if(outboundEvidence.length>ASSISTANT_LIMITS.contextCharacters)throw new RequestError(413,'The selected evidence exceeds the assistant context budget. Choose a focused diagnostic report.');
    const context=JSON.parse(outboundEvidence) as typeof built;
    const preview:AssistantPreview={previewId:randomUUID(),createdAt,expiresAt:createdAt+ASSISTANT_LIMITS.previewTtlMs,context,outboundEvidence,
      disclosure:[
        'When you send a question, this evidence, your question and earlier messages in this conversation are sent to OpenAI at api.openai.com. API usage is billed to the configured OpenAI account.',
        body.includeIdentifiers===true?'Network addresses and names in the selected records are included. Review the exact evidence below.':'Network identifiers are replaced with consistent aliases, except recognised public benchmark resolvers and fixed public test domains. Text you type is sent as written.',
        'Only saved, bounded diagnostic evidence is read. This preview performs no scans, live device reads or OpenAI requests. New results require a refreshed preview.',
        'NEO keeps this conversation in collector memory for up to 30 minutes of inactivity and the page session, with no chat database or browser-storage history. OpenAI response storage is disabled; provider abuse monitoring and other account retention policies still apply.',
        'The assistant provides advice and has no tools for changing settings or running tests. Its conclusions can be wrong; use the cited measurements and verification steps.',
      ]};
    this.previews.set(preview.previewId,preview);
    this.scheduleCleanup();
    return structuredClone(preview);
  }
  async chat(value:unknown,signal?:AbortSignal):Promise<AssistantReply>{
    const request=parseAssistantChat(value);
    if(this.closing)throw new RequestError(503,'The collector is shutting down.');
    this.prune();
    const fingerprint=createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const existing=this.requests.get(request.requestId);
    if(existing){
      if(existing.fingerprint!==fingerprint)throw new RequestError(409,'This request ID already belongs to another question.');
      return existing.done;
    }
    if(signal?.aborted)throw new RequestError(408,'The assistant request was cancelled before sending.');
    const availability=this.provider.options();
    if(!availability.available)throw new RequestError(503,availability.reason??'Configure OpenAI on this collector first.');
    if(this.active)throw new RequestError(409,'An assistant answer is already being prepared. Wait or cancel it first.');
    if(this.requests.size>=128)throw new RequestError(429,'The assistant session request limit was reached. Clear a conversation or wait for its session to expire.');
    let conversation=request.conversationId?this.conversations.get(request.conversationId):undefined;
    if(request.conversationId&&!conversation)throw new RequestError(410,'This conversation has expired. Review a fresh evidence preview.');
    if(conversation&&conversation.preview.previewId!==request.previewId)throw new RequestError(409,'A conversation must use its original reviewed evidence. Start a new conversation for fresh results.');
    const preview=conversation?.preview??this.previews.get(request.previewId);
    if(!preview||(!conversation&&preview.expiresAt<=this.now()))throw new RequestError(410,'This evidence preview has expired. Review fresh results before sending.');
    if(conversation&&conversation.turns.length>=ASSISTANT_LIMITS.turns)throw new RequestError(409,'This conversation has reached its turn limit. Start a new conversation with fresh evidence.');
    if(!conversation){
      if(this.conversations.size>=8)throw new RequestError(409,'The collector has eight active conversations. Clear an earlier conversation first.');
      conversation={id:randomUUID(),preview,turns:[],updatedAt:this.now()};
    }
    const current=conversation;
    const controller=new AbortController();
    const abort=()=>controller.abort();
    signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,ASSISTANT_LIMITS.requestTimeoutMs);
    // Register ownership before invoking even a synchronously throwing provider.
    const done=Promise.resolve().then(async()=>{
      try{
        if(controller.signal.aborted)throw new RequestError(408,'The assistant request was cancelled before sending.');
        const result=await this.provider.respond({context:preview.context,outboundEvidence:preview.outboundEvidence,history:current.turns,message:request.message,signal:controller.signal});
        if(controller.signal.aborted)throw new RequestError(408,'The assistant request was stopped or reached its time limit.');
        current.turns.push({message:request.message,answer:result.answer});current.updatedAt=this.now();
        this.conversations.set(current.id,current);
        return {requestId:request.requestId,conversationId:current.id,previewId:preview.previewId,answer:result.answer,model:availability.model,createdAt:this.now(),turnsRemaining:ASSISTANT_LIMITS.turns-current.turns.length,usage:result.usage};
      }catch(error){
        if(controller.signal.aborted)throw new RequestError(408,'The assistant request was stopped or reached its time limit. You can ask again when ready.');
        if(error instanceof RequestError)throw error;
        throw new RequestError(502,'The assistant is unavailable. Your diagnostic results are unchanged.');
      }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(this.active?.requestId===request.requestId)this.active=null;this.prune();}
    });
    this.active={requestId:request.requestId,previewId:preview.previewId,conversationId:current.id,controller,done};
    this.requests.set(request.requestId,{fingerprint,previewId:preview.previewId,conversationId:current.id,createdAt:this.now(),done});
    this.scheduleCleanup();
    return done;
  }
  async cancel(value:unknown){
    const body=data(value,['requestId']);const requestId=identifier(body.requestId,'request ID');
    if(this.active?.requestId===requestId){const active=this.active;active.controller.abort();await active.done.catch(()=>undefined);}
    return {cancelRequested:true};
  }
  async reset(value:unknown){
    const body=data(value,['conversationId','previewId']);
    const conversationId=body.conversationId===undefined?undefined:identifier(body.conversationId,'conversation ID');
    const previewId=body.previewId===undefined?undefined:identifier(body.previewId,'preview ID');
    if(!conversationId&&!previewId)throw new RequestError(400,'Choose a conversation or evidence preview to clear.');
    const matches=(entry:{conversationId:string;previewId:string})=>entry.conversationId===conversationId||entry.previewId===previewId;
    if(this.active&&matches(this.active)){const active=this.active;active.controller.abort();await active.done.catch(()=>undefined);}
    for(const [id,conversation] of this.conversations)if(id===conversationId||conversation.preview.previewId===previewId)this.conversations.delete(id);
    if(previewId)this.previews.delete(previewId);
    for(const [id,entry] of this.requests)if(matches(entry))this.requests.delete(id);
    this.scheduleCleanup();
    return {reset:true};
  }
  async shutdown(){
    this.closing=true;
    if(this.cleanupTimer)clearTimeout(this.cleanupTimer);this.cleanupTimer=null;
    const active=this.active;active?.controller.abort();await active?.done.catch(()=>undefined);
    this.previews.clear();this.conversations.clear();this.requests.clear();
  }
}

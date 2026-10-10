const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
let prefs = {}, workspacePrefs = {};
class TextPart { constructor(value){this.value=value;} }
class ToolCallPart { constructor(callId,name,input){Object.assign(this,{callId,name,input});} }
class ToolResultPart { constructor(callId,content){Object.assign(this,{callId,content});} }
class DataPart { constructor(data,mimeType){Object.assign(this,{data,mimeType});} }
const vscode={CancellationError:class extends Error{},version:'1.110.0',
  LanguageModelTextPart:TextPart,LanguageModelToolCallPart:ToolCallPart,LanguageModelToolResultPart:ToolResultPart,LanguageModelDataPart:DataPart,
  LanguageModelChatMessageRole:{User:1,Assistant:2},
  EventEmitter:class{event=()=>({dispose(){}});fire(){this.fires=(this.fires??0)+1;}dispose(){}},
  workspace:{getConfiguration:()=>({get:(key,fallback)=>key==='thinkingEffortByModel'?{...prefs,...workspacePrefs}:fallback,
    inspect:key=>key==='thinkingEffortByModel'?{globalValue:prefs,workspaceValue:workspacePrefs}:{}})},
  window:{showWarningMessage(){},showErrorMessage(){}},
};
const load=Module._load;let Dispatcher,Anthropic,Google,Grok;
try{Module._load=function(r,...args){if(r==='vscode')return vscode;if(r.endsWith('/Logger'))return{Logger:class{log(){}error(){}}};return load.call(this,r,...args);};
 ({VertexChatModelDispatcher:Dispatcher}=require('../out/VertexChatModelDispatcher.js'));
 ({VertexAnthropicProvider:Anthropic}=require('../out/providers/VertexAnthropicProvider.js'));
 ({VertexGoogleProvider:Google}=require('../out/providers/VertexGoogleProvider.js'));
 ({VertexGrokProvider:Grok}=require('../out/providers/VertexGrokProvider.js'));
}finally{Module._load=load;}
const {EffortCatalog}=require('../out/effort/EffortCatalog.js');
const {resolveEffort}=require('../out/effort/ResolveEffort.js');
const models=require('../src/models.json').candidateModels;
const catalog=new EffortCatalog(models);
const flush=()=>new Promise(setImmediate);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const token=()=>({isCancellationRequested:false,onCancellationRequested:()=>({dispose(){}})});
const progress={report(){}};
const messages=[{role:1,content:[new TextPart('hello')]}];
const usage={usage:{input:3,output:1,cache_read:0,cache_create:0},charCount:{}};
function harness(){class D extends Dispatcher{registerProviders(){}}
 const records=[],requests=[];
 const d=new D('test-project',{recordUsage:async(...args)=>records.push(args)}, {onAuthUpdated(){},getResolvedAuthOptions:async()=>undefined},
   {getEffectiveCatalog:async()=>({candidateModels:models,regionPriority:['global']})});
 d.availableModels=models;d.discoveryDone=true;
 for(const vendor of ['anthropic','google','grok'])d.activeProviders.set(vendor,{vendor,setLabels(){},initialize(){},pingModel:async()=>true,
  provideLanguageModelChatResponse:async(...args)=>{requests.push(args);return usage;}});
 return{d,records,requests};
}
test.beforeEach(()=>{prefs={};workspacePrefs={};});
test('public callbacks capture preferences; internal infer keeps the catalog default',async()=>{
 const h=harness();prefs={'claude-opus-5-5':'max'};
 await h.d.provideLanguageModelChatResponse({id:'claude-opus-5-5'},messages,{},progress,token());
 await h.d.infer('claude-opus-5-5',messages,{},progress,token());
 assert.deepEqual(h.requests.map(r=>r[7].effort.value),['max','medium']);
 assert.deepEqual(h.requests.map(r=>r[7].effort.source),['user','catalog']);
 assert.deepEqual(h.records.map(r=>r[0]),['claude-opus-5-5','claude-opus-5-5']);
 assert(h.records.every(r=>r.length===3));
});
test('settings change while waiting for labels does not alter the public snapshot; invocations remain independent',async()=>{
 const h=harness(),gate=deferred();
 h.d.resolveRequestLabels=async()=>{await gate.promise;return{};};
 prefs={'claude-opus-5-5':'high'};
 const first=h.d.provideLanguageModelChatResponse({id:'claude-opus-5-5'},messages,{},progress,token());
 prefs['claude-opus-5-5']='max';
 const second=h.d.provideLanguageModelChatResponse({id:'claude-opus-5-5'},messages,{},progress,token());
 gate.resolve();await Promise.all([first,second]);
 assert.deepEqual(h.requests.map(r=>r[7].effort.value),['high','max']);
});
test('invalid policy fails before inference; exact dispatcher membership remains required',async()=>{
 const h=harness();prefs={'claude-opus-5-5':'low'};
 await assert.rejects(h.d.provideLanguageModelChatResponse({id:'claude-opus-5-5'},messages,{},progress,token()),/not permitted/);
 await assert.rejects(h.d.infer('arbitrary-ui-id',messages,{},progress,token()),/not available/);
 assert.equal(h.requests.length,0);assert.equal(h.records.length,0);
});
test('model information exposes the complete catalog and refreshes effort without discovery',async()=>{
 const h=harness();let discoveryCalls=0;h.d.discoverModelsAndRegion=()=>{discoveryCalls++;throw Error('no probes');};
 assert.deepEqual((await h.d.provideLanguageModelChatInformation()).map(m=>m.id),models.map(m=>m.id));
 await h.d.ensureInitialDiscovery(token());
 prefs={'claude-opus-5-5':'high'};h.d.refreshModelInformation();
 const info=(await h.d.provideLanguageModelChatInformation()).find(m=>m.id==='claude-opus-5-5');
 assert.match(info.detail,/high.*user/);assert.equal(info.version,'claude-opus-5-5');
 assert.equal(discoveryCalls,0);assert.equal(h.d.getConnectionRevision(),0);
});
test('connection changes while labels are pending fail before inference',async()=>{
 const h=harness(),gate=deferred();h.d.resolveRequestLabels=async()=>{await gate.promise;return{};};
 const pending=h.d.provideLanguageModelChatResponse({id:'claude-opus-5-5'},messages,{},progress,token());
 h.d.resetConnection();gate.resolve();await assert.rejects(pending,/Configuration changed/);assert.equal(h.requests.length,0);
});

function adapter(vendor,onRequest){
 const provider=vendor==='anthropic'?new Anthropic():vendor==='google'?new Google():new Grok();
 provider.projectId='test';provider.region='global';
 const requests=[];
 const capture=async body=>{requests.push(body);await onRequest?.(body,requests.length);return(async function*(){})()};
 if(vendor==='anthropic')provider.client={messages:{create:capture}};
 if(vendor==='google')provider.getClient=async()=>({models:{generateContentStream:capture}});
 if(vendor==='grok')provider.getClient=async()=>({chat:{completions:{create:capture}}});
 return{provider,requests};
}
for(const model of models.filter(m=>m.effort))test(`${model.id} sends every named effort and the catalog default`,async()=>{
 const h=adapter(model.vendor);
 for(const value of [...model.effort.values,undefined]){
  const request=resolveEffort(catalog,model.id,value===undefined?undefined:{preferences:{[model.id]:value},sourceByModel:{}});
  await h.provider.provideLanguageModelChatResponse(model.id,messages,{},progress,token(),{},request.spec,request);
  const body=h.requests.at(-1);
  const effective=value===undefined?model.effort.default:value;
  assert.equal(body.model,model.version);
  if(model.vendor==='anthropic'){
   assert.equal(body.output_config?.effort,effective);
   assert.deepEqual(body.thinking,{type:'adaptive',display:'omitted'});
  }else if(model.vendor==='google')assert.equal(body.config.thinkingConfig?.thinkingLevel,effective.toUpperCase());
  else assert.equal(body.reasoning_effort,effective);
 }
});
for(const vendor of ['anthropic','google','grok'])test(`${vendor} retries reuse the payload/client despite settings and provider reinitialization`,async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const model=models.find(m=>m.vendor===vendor&&m.effort);
 const request=resolveEffort(catalog,model.id,{preferences:{[model.id]:model.effort.values[0]},sourceByModel:{}});
 const h=adapter(vendor,async(_body,attempt)=>{if(attempt===1)throw{status:503,message:'503 service unavailable'};});
 const pending=h.provider.provideLanguageModelChatResponse(model.id,messages,{},progress,token(),{},request.spec,request);
 await flush();assert.equal(h.requests.length,1);
 prefs[model.id]=model.effort.default;
 if(vendor==='anthropic')h.provider.client={messages:{create:async()=>{throw Error('redirected retry');}}};
 else h.provider.getClient=async()=>{throw Error('redirected retry');};
 t.mock.timers.tick(4000);await pending;
 assert.equal(h.requests.length,2);assert.deepEqual(h.requests[0],h.requests[1]);
});
test('custom Grok UI IDs and backend versions use the catalog literally',async()=>{
 const h=adapter('grok'),model={...models.at(-1),id:'enterprise-grok'};
 await h.provider.provideLanguageModelChatResponse(model.id,messages,{},progress,token(),{},model);
 assert.equal(h.requests[0].model,'xai/grok-4.6');
 await h.provider.provideLanguageModelChatResponse(model.id,messages,{},progress,token(),{},{...model,version:'xai/company-reasoner-high'});
 assert.equal(h.requests[1].model,'xai/company-reasoner-high');
});

for(const vendor of ['anthropic','google','grok'])test(`${vendor} connection reset cancels direct backoff, sends no retry and records no success`,async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const model=models.find(m=>m.vendor===vendor&&m.effort),h=harness();
 const a=adapter(vendor,async()=>{throw{status:503,message:'service unavailable'};});
 h.d.activeProviders.set(vendor,a.provider);
 const pending=h.d.provideLanguageModelChatResponse({id:model.id},messages,{},progress,token());
 const rejected=assert.rejects(pending);
 await flush();assert.equal(a.requests.length,1);
 h.d.resetConnection();await rejected;t.mock.timers.tick(5000);await flush();
 assert.equal(a.requests.length,1);assert.equal(h.records.length,0);
});

for (const vendor of ['anthropic', 'google', 'grok']) {
 test(`${vendor} custom backend and effort reach the adapter, and API rejection is surfaced`, async () => {
  const model = { ...models.find(m => m.vendor === vendor), id: 'company-model', version: 'company-model-high',
   effort: { values: ['custom-effort'], default: 'custom-effort' } };
  const request = resolveEffort(new EffortCatalog([model]), model.id);
  const h = adapter(vendor, () => { throw Object.assign(new Error('API rejected custom effort'), { status: 400 }); });
  await assert.rejects(h.provider.provideLanguageModelChatResponse(model.id, messages, {}, progress, token(), {}, model, request), /API rejected custom effort/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].model, model.version);
  const body = h.requests[0];
  assert.equal(vendor === 'anthropic' ? body.output_config.effort : vendor === 'google' ? body.config.thinkingConfig.thinkingLevel : body.reasoning_effort,
   vendor === 'google' ? 'CUSTOM-EFFORT' : 'custom-effort');
 });
}

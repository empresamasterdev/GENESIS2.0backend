import express from "express";
import cors from "cors";
import crypto from "node:crypto";

const app=express();
app.use(cors());
app.use(express.json({limit:"2mb"}));

const runs=new Map();
const connections=new Map();
const providers=new Map([
 ["groq",{base:"https://api.groq.com/openai/v1",models:"/models",chat:"/chat/completions"}],
 ["mistral",{base:"https://api.mistral.ai/v1",models:"/models",chat:"/chat/completions"}],
 ["openai",{base:"https://api.openai.com/v1",models:"/models",chat:"/chat/completions"}],
 ["anthropic",{base:"https://api.anthropic.com/v1",models:null,chat:"/messages"}]
]);

function id(p="id"){return p+"_"+crypto.randomUUID().replaceAll("-","").slice(0,16)}
function now(){return new Date().toISOString()}
function log(r,type,stage,message,extra={}){r.events.push({ts:now(),type,stage,message,...extra})}
function cap(name=""){let n=name.toLowerCase(); if(/code|codestral|coder|dev|program/.test(n))return "code"; if(/vision|vl|pixtral|image/.test(n))return "vision"; if(/audio|whisper|speech/.test(n))return "audio"; if(/embed/.test(n))return "embedding"; if(/reason|thinking|r1|o1|o3|gpt-oss/.test(n))return "reasoning"; return "text"}
function modelKey(c,m){return `${c.id}::${c.provider}::${m}`}

async function fetchJson(url,opt={}){let res=await fetch(url,opt);let text=await res.text();let data;try{data=JSON.parse(text)}catch{data={raw:text}}if(!res.ok)throw new Error(data?.error?.message||data?.message||`HTTP ${res.status}`);return data}

async function detectProvider(key,requested="auto"){
 if(requested&&requested!=="auto")return requested;
 const tests=[["groq","https://api.groq.com/openai/v1/models",{"Authorization":`Bearer ${key}`}],["openai","https://api.openai.com/v1/models",{"Authorization":`Bearer ${key}`}],["mistral","https://api.mistral.ai/v1/models",{"Authorization":`Bearer ${key}`}]];
 for(const [p,u,h] of tests){try{await fetchJson(u,{headers:h});return p}catch{}}
 throw new Error("Não foi possível detectar o provedor automaticamente.");
}
async function discover(c){
 if(c.provider==="anthropic"){
   // Anthropic does not expose the same public model-list endpoint; use configured discovery candidates only after key validation.
   // This is not a fake model result: each candidate is validated with a real API call.
   const candidates=["claude-3-5-haiku-latest","claude-3-5-sonnet-latest","claude-3-7-sonnet-latest"];
   const out=[];
   for(const model of candidates){try{
      const x=await fetchJson("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"x-api-key":c.key,"anthropic-version":"2023-06-01","content-type":"application/json"},body:JSON.stringify({model,max_tokens:1,messages:[{role:"user",content:"ping"}]})});
      if(x)out.push({model,provider:"anthropic",capability:cap(model),connectionId:c.id,connectionName:c.name});
   }catch{}}
   return out;
 }
 const p=providers.get(c.provider);
 const d=await fetchJson(p.base+p.models,{headers:{Authorization:`Bearer ${c.key}`}});
 return (d.data||[]).map(x=>({model:x.id,provider:c.provider,capability:cap(x.id),connectionId:c.id,connectionName:c.name}));
}
async function callModel(c,model,messages){
 const p=providers.get(c.provider); const t=Date.now();
 if(c.provider==="anthropic"){
   const d=await fetchJson(p.base+p.chat,{method:"POST",headers:{"x-api-key":c.key,"anthropic-version":"2023-06-01","content-type":"application/json"},body:JSON.stringify({model,max_tokens:2500,temperature:0,messages})});
   return {text:(d.content||[]).map(x=>x.text||"").join(""),usage:{input_tokens:d.usage?.input_tokens||0,output_tokens:d.usage?.output_tokens||0,total_tokens:(d.usage?.input_tokens||0)+(d.usage?.output_tokens||0)},latencyMs:Date.now()-t,raw:d};
 }
 const d=await fetchJson(p.base+p.chat,{method:"POST",headers:{Authorization:`Bearer ${c.key}`,"content-type":"application/json"},body:JSON.stringify({model,messages,temperature:0})});
 const u=d.usage||{};
 return {text:d.choices?.[0]?.message?.content||"",usage:{input_tokens:u.prompt_tokens||u.input_tokens||0,output_tokens:u.completion_tokens||u.output_tokens||0,total_tokens:u.total_tokens||(u.prompt_tokens||u.input_tokens||0)+(u.completion_tokens||u.output_tokens||0)},latencyMs:Date.now()-t,raw:d};
}
function stagePrompt(stage,command,previous){
 const common=`Você é a etapa ${stage} de um pipeline de engenharia de software. Execute somente o papel da sua etapa. Comando do usuário:\n${command}\n\nContexto produzido pelas etapas anteriores:\n${previous||"(nenhum)"}`;
 if(stage==="NEXUS")return common+"\nDefina intenção, requisitos, riscos e plano objetivo. Não invente dados.";
 if(stage==="SCOUT")return common+"\nInvestigue o contexto disponível, identifique arquivos/áreas relevantes e dependências. Não escreva código nem alegue acesso a arquivos que não recebeu.";
 if(stage==="FORGE")return common+"\nProponha as alterações de código/SQL necessárias com artefatos estruturados. Só use informações presentes no contexto.";
 return common+"\nRevise o trabalho anterior, valide coerência e produza uma decisão final operacional. Se estiver tudo correto, gere githubAction com action e lista de alterações propostas. Não alegue que algo foi aplicado no GitHub real.";
}

app.get("/health",(req,res)=>res.json({ok:true,version:"6.0.0",name:"VILTRIX AI LAB REAL SANDBOX"}));
app.get("/api/models",(req,res)=>{
 const models=[];
 for(const c of connections.values())for(const m of c.models||[])models.push(m);
 res.json({models});
});
app.get("/api/connections",(req,res)=>res.json({connections:[...connections.values()].map(c=>({id:c.id,name:c.name,provider:c.provider,models:c.models||[]}))}));

app.post("/api/connections",async(req,res)=>{
 try{
   const key=String(req.body.key||"").trim(), requested=String(req.body.provider||"auto"), name=String(req.body.name||"Conexão").trim();
   if(!key)throw Error("API key ausente.");
   const provider=await detectProvider(key,requested);
   const c={id:id("conn"),name,provider,key,models:[]};
   c.models=await discover(c);
   connections.set(c.id,c);
   res.json({connection:{id:c.id,name:c.name,provider:c.provider},models:c.models});
 }catch(e){res.status(400).json({error:e.message})}
});

app.post("/api/sandbox/run",async(req,res)=>{
 const command=String(req.body.command||"").trim(), team=req.body.team||{};
 if(!command)return res.status(400).json({error:"Comando vazio."});
 for(const s of ["NEXUS","SCOUT","FORGE","SENTINEL"]){if(!team[s]?.model||!team[s]?.connectionId)return res.status(400).json({error:`Modelo ausente em ${s}.`})}
 const r={id:id("run"),command,team,status:"running",createdAt:now(),events:[],stageResults:{},githubSignal:null,githubReceived:false};
 runs.set(r.id,r); log(r,"TASK_CREATED","","Execução criada");
 executeRun(r).catch(e=>{r.status="failed";log(r,"EXECUTION_FAILED","",e.message)});
 res.json({run:{id:r.id,status:r.status}});
});

async function executeRun(r){
 let previous="";
 for(const stage of ["NEXUS","SCOUT","FORGE","SENTINEL"]){
   const sel=r.team[stage], c=connections.get(sel.connectionId);
   if(!c)throw Error(`Conexão ${sel.connectionId} não encontrada.`);
   const found=(c.models||[]).find(x=>x.model===sel.model);
   if(!found)throw Error(`Modelo ${sel.model} não pertence à conexão selecionada.`);
   r.stageResults[stage]={status:"running",model:sel.model,provider:c.provider,startedAt:now()};
   log(r,"STAGE_STARTED",stage,`Modelo ${sel.model}`);
   try{
     const result=await callModel(c,sel.model,[{role:"user",content:stagePrompt(stage,r.command,previous)}]);
     r.stageResults[stage]={...r.stageResults[stage],status:"completed",completedAt:now(),latencyMs:result.latencyMs,usage:result.usage,output:result.text,raw:result.raw};
     previous=result.text;
     log(r,"STAGE_COMPLETED",stage,`Concluído`,{tokens:result.usage.total_tokens,latencyMs:result.latencyMs});
     if(stage==="SENTINEL"){
       let parsed=null;try{parsed=JSON.parse(result.text)}catch{}
       r.githubSignal=parsed?.githubAction||{action:"review",status:"proposed",payload:result.text};
       log(r,"FINAL_SIGNAL_CREATED","SENTINEL","Sinal final produzido pelo modelo");
       const received=githubSimulator(r.githubSignal);
       r.githubReceived=received.ok;
       log(r,received.ok?"GITHUB_SIGNAL_RECEIVED":"GITHUB_SIGNAL_REJECTED","GITHUB",received.message);
     }
   }catch(e){
     r.stageResults[stage]={...r.stageResults[stage],status:"failed",completedAt:now(),error:e.message};
     log(r,"STAGE_FAILED",stage,e.message);r.status="failed";return;
   }
 }
 r.status=r.githubReceived?"completed":"failed";
 log(r,r.status==="completed"?"SIMULATION_COMPLETED":"SIMULATION_FAILED","","Fluxo encerrado");
}
function githubSimulator(signal){
 if(!signal||typeof signal!=="object")return {ok:false,message:"Sinal não é objeto."};
 if(typeof signal.action!=="string"||!signal.action.trim())return {ok:false,message:"Sinal sem action válida."};
 return {ok:true,message:`Protocolo aceito: action=${signal.action}`};
}

app.get("/api/runs",(req,res)=>res.json({runs:[...runs.values()].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).map(r=>({id:r.id,status:r.status,command:r.command,createdAt:r.createdAt}))}));
app.get("/api/runs/:id",(req,res)=>{const r=runs.get(req.params.id);if(!r)return res.status(404).json({error:"Run não encontrada"});res.json({run:r})});

app.get("/api/reports",(req,res)=>{
 const reports=[...runs.values()].map(r=>{
   const stages=Object.values(r.stageResults||{}), completed=stages.filter(x=>x.status==="completed").length;
   const totalTokens=stages.reduce((n,x)=>n+(x.usage?.total_tokens||0),0);
   const totalLatencyMs=stages.reduce((n,x)=>n+(x.latencyMs||0),0);
   return {id:r.id,status:r.status,completedStages:completed,totalStages:4,totalTokens,totalLatencyMs,summary:r.status==="completed"?"As quatro etapas concluíram e o GitHub Simulator recebeu o sinal final.":`Execução encerrada com ${completed}/4 etapas concluídas.`};
 });
 res.json({reports});
});
app.get("/api/power-rank",(req,res)=>{
 const map=new Map();
 for(const r of runs.values())for(const [stage,x] of Object.entries(r.stageResults||{})){
   if(!x.model)continue;const k=`${x.provider}/${x.model}`;let z=map.get(k)||{provider:x.provider,model:x.model,experiments:0,completedStages:0,stages:0,tokens:0,lat:0};
   z.experiments++;z.stages++;if(x.status==="completed")z.completedStages++;z.tokens+=x.usage?.total_tokens||0;z.lat+=x.latencyMs||0;map.set(k,z);
 }
 const rank=[...map.values()].map(z=>({...z,avgLatencyMs:z.stages?Math.round(z.lat/z.stages):0})).sort((a,b)=>b.completedStages-a.completedStages||a.avgLatencyMs-b.avgLatencyMs);
 res.json({rank});
});

const port=process.env.PORT||10000;
app.listen(port,()=>console.log(`VILTRIX AI LAB 6.0.0 REAL SANDBOX on ${port}`));

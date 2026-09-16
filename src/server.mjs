import express from "express";
import cors from "cors";
import crypto from "node:crypto";

const app=express();
app.use(cors());
app.use(express.json({limit:"3mb"}));

const connections=new Map();
const runs=new Map();

const providers={
 groq:{base:"https://api.groq.com/openai/v1"},
 mistral:{base:"https://api.mistral.ai/v1"},
 openai:{base:"https://api.openai.com/v1"},
 anthropic:{base:"https://api.anthropic.com/v1"}
};

const id=p=>`${p}_${crypto.randomUUID().replaceAll("-","").slice(0,16)}`;
const now=()=>new Date().toISOString();
const capability=n=>{n=String(n).toLowerCase();if(/vision|pixtral|vl|image/.test(n))return"vision";if(/audio|whisper|speech/.test(n))return"audio";if(/embed/.test(n))return"embedding";if(/code|coder|codestral|dev|program/.test(n))return"code";if(/reason|thinking|r1|o1|o3|gpt-oss/.test(n))return"reasoning";return"text"};
function addEvent(r,type,stage,message,extra={}){r.events.push({ts:now(),type,stage,message,...extra})}
async function request(url,opt={}){const res=await fetch(url,opt);const text=await res.text();let data;try{data=JSON.parse(text)}catch{data={raw:text}}if(!res.ok)throw Error(data?.error?.message||data?.message||`HTTP ${res.status}`);return data}

async function detectProvider(key,requested){
 if(requested&&requested!=="auto")return requested;
 for(const p of ["groq","openai","mistral"]){
   try{await request(providers[p].base+"/models",{headers:{Authorization:`Bearer ${key}`}});return p}catch{}
 }
 throw Error("Provedor não identificado automaticamente.");
}
async function discover(c){
 if(c.provider==="anthropic"){
   // Anthropic does not expose a public model-list endpoint equivalent to OpenAI-compatible providers.
   // Validate candidate IDs with a real minimal API request; only successfully validated models are returned.
   const candidates=["claude-3-5-haiku-latest","claude-3-5-sonnet-latest","claude-3-7-sonnet-latest","claude-sonnet-4-20250514","claude-opus-4-20250514"];
   const found=[];
   for(const model of candidates){try{
     await request(providers.anthropic.base+"/messages",{method:"POST",headers:{"x-api-key":c.key,"anthropic-version":"2023-06-01","content-type":"application/json"},body:JSON.stringify({model,max_tokens:1,messages:[{role:"user",content:"ping"}]})});
     found.push({model,provider:"anthropic",capability:capability(model),connectionId:c.id,connectionName:c.name});
   }catch{}}
   return found;
 }
 const d=await request(providers[c.provider].base+"/models",{headers:{Authorization:`Bearer ${c.key}`}});
 return (d.data||[]).map(x=>({model:x.id,provider:c.provider,capability:capability(x.id),connectionId:c.id,connectionName:c.name}));
}
async function call(c,model,messages){
 const started=Date.now();
 if(c.provider==="anthropic"){
   const d=await request(providers.anthropic.base+"/messages",{method:"POST",headers:{"x-api-key":c.key,"anthropic-version":"2023-06-01","content-type":"application/json"},body:JSON.stringify({model,max_tokens:3000,temperature:0,messages})});
   const input=d.usage?.input_tokens||0, output=d.usage?.output_tokens||0;
   return{text:(d.content||[]).map(x=>x.text||"").join(""),usage:{input_tokens:input,output_tokens:output,total_tokens:input+output},latencyMs:Date.now()-started,raw:d};
 }
 const d=await request(providers[c.provider].base+"/chat/completions",{method:"POST",headers:{Authorization:`Bearer ${c.key}`,"content-type":"application/json"},body:JSON.stringify({model,messages,temperature:0})});
 const u=d.usage||{},input=u.prompt_tokens??u.input_tokens??0,output=u.completion_tokens??u.output_tokens??0;
 return{text:d.choices?.[0]?.message?.content||"",usage:{input_tokens:input,output_tokens:output,total_tokens:u.total_tokens??input+output},latencyMs:Date.now()-started,raw:d};
}
function prompt(stage,command,previous){
 const base=`Você é a etapa ${stage} de um pipeline real de engenharia de software.\nComando do usuário:\n${command}\n\nSaída anterior:\n${previous||"(nenhuma)"}\n\nNão invente acesso, arquivos, resultados ou fatos.`;
 if(stage==="NEXUS")return base+"\nDefina intenção, requisitos, restrições, riscos e plano objetivo.";
 if(stage==="SCOUT")return base+"\nAnalise o contexto recebido, identifique o que deve ser investigado e quais arquivos/áreas seriam relevantes. Não alegue ter lido arquivos que não recebeu.";
 if(stage==="FORGE")return base+"\nProponha as alterações técnicas necessárias. Produza código/artefatos somente quando sustentados pelo contexto.";
 return base+"\nFaça a revisão final. Retorne um objeto JSON quando possível com status e githubAction. githubAction deve conter action e payload. Não afirme que algo foi escrito no GitHub real.";
}

app.get("/health",(req,res)=>res.json({ok:true,version:"6.0.1",name:"VILTRIX AI LAB REAL SANDBOX"}));
app.get("/api/models",(req,res)=>res.json({models:[...connections.values()].flatMap(c=>c.models||[])}));
app.get("/api/connections",(req,res)=>res.json({connections:[...connections.values()].map(c=>({id:c.id,name:c.name,provider:c.provider,models:c.models||[]}))}));

app.post("/api/connections",async(req,res)=>{
 try{
   const key=String(req.body.key||"").trim(), requested=String(req.body.provider||"auto"), name=String(req.body.name||"Conexão").trim()||"Conexão";
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
 for(const s of ["NEXUS","SCOUT","FORGE","SENTINEL"]){
   if(!team[s]?.model||!team[s]?.connectionId)return res.status(400).json({error:`Modelo ausente em ${s}.`});
   const c=connections.get(team[s].connectionId);
   if(!c) return res.status(400).json({error:`Conexão ${team[s].connectionId} não está ativa no backend.`});
   if(!(c.models||[]).some(m=>m.model===team[s].model))return res.status(400).json({error:`Modelo ${team[s].model} não pertence à conexão selecionada.`});
 }
 const r={id:id("run"),command,team,status:"running",createdAt:now(),events:[],stageResults:{},githubSignal:null,githubReceived:false};
 runs.set(r.id,r);addEvent(r,"TASK_CREATED","","Execução criada");
 execute(r).catch(e=>{r.status="failed";addEvent(r,"EXECUTION_FAILED","",e.message)});
 res.json({run:{id:r.id,status:r.status}});
});

async function execute(r){
 let previous="";
 for(const stage of ["NEXUS","SCOUT","FORGE","SENTINEL"]){
   const sel=r.team[stage],c=connections.get(sel.connectionId);
   r.stageResults[stage]={status:"running",model:sel.model,provider:c.provider,startedAt:now()};
   addEvent(r,"STAGE_STARTED",stage,`Modelo ${sel.model}`);
   try{
     const out=await call(c,sel.model,[{role:"user",content:prompt(stage,r.command,previous)}]);
     r.stageResults[stage]={...r.stageResults[stage],status:"completed",completedAt:now(),latencyMs:out.latencyMs,usage:out.usage,output:out.text,raw:out.raw};
     previous=out.text;
     addEvent(r,"STAGE_COMPLETED",stage,"Etapa concluída",{tokens:out.usage.total_tokens,latencyMs:out.latencyMs});
     if(stage==="SENTINEL"){
       let parsed=null;try{parsed=JSON.parse(out.text)}catch{}
       r.githubSignal=parsed?.githubAction||{action:"review",payload:out.text};
       addEvent(r,"FINAL_SIGNAL_CREATED","SENTINEL","Sinal final produzido pelo modelo");
       const result=githubProtocol(r.githubSignal);
       r.githubReceived=result.ok;
       addEvent(r,result.ok?"GITHUB_SIGNAL_RECEIVED":"GITHUB_SIGNAL_REJECTED","GITHUB",result.message);
     }
   }catch(e){
     r.stageResults[stage]={...r.stageResults[stage],status:"failed",completedAt:now(),error:e.message};
     addEvent(r,"STAGE_FAILED",stage,e.message);r.status="failed";return;
   }
 }
 r.status=r.githubReceived?"completed":"failed";
 addEvent(r,r.status==="completed"?"SIMULATION_COMPLETED":"SIMULATION_FAILED","","Fluxo encerrado");
}
function githubProtocol(signal){if(!signal||typeof signal!=="object")return{ok:false,message:"Sinal inválido."};if(typeof signal.action!=="string"||!signal.action.trim())return{ok:false,message:"Sinal sem action."};return{ok:true,message:`Protocolo aceito: ${signal.action}`}}

app.get("/api/runs",(req,res)=>res.json({runs:[...runs.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(r=>({id:r.id,status:r.status,command:r.command,createdAt:r.createdAt}))}));
app.get("/api/runs/:id",(req,res)=>{const r=runs.get(req.params.id);if(!r)return res.status(404).json({error:"Run não encontrada"});res.json({run:r})});
app.get("/api/reports",(req,res)=>res.json({reports:[...runs.values()].map(r=>{const s=Object.values(r.stageResults),completed=s.filter(x=>x.status==="completed").length,totalTokens=s.reduce((n,x)=>n+(x.usage?.total_tokens||0),0),totalLatencyMs=s.reduce((n,x)=>n+(x.latencyMs||0),0);return{id:r.id,status:r.status,completedStages:completed,totalStages:4,totalTokens,totalLatencyMs,summary:r.status==="completed"?"Quatro etapas concluídas e o protocolo final foi recebido pelo GitHub Simulator.":`Execução encerrada em ${completed}/4 etapas.`}})}));
app.get("/api/power-rank",(req,res)=>{const map=new Map();for(const r of runs.values())for(const x of Object.values(r.stageResults)){if(!x.model)continue;const k=`${x.provider}/${x.model}`,z=map.get(k)||{provider:x.provider,model:x.model,experiments:0,completedStages:0,stages:0,tokens:0,lat:0};z.experiments++;z.stages++;if(x.status==="completed")z.completedStages++;z.tokens+=x.usage?.total_tokens||0;z.lat+=x.latencyMs||0;map.set(k,z)}res.json({rank:[...map.values()].map(z=>({...z,avgLatencyMs:z.stages?Math.round(z.lat/z.stages):0})).sort((a,b)=>b.completedStages-a.completedStages||a.avgLatencyMs-b.avgLatencyMs)})});

const port=process.env.PORT||10000;
app.listen(port,()=>console.log(`VILTRIX AI LAB 6.0.1 REAL SANDBOX on ${port}`));

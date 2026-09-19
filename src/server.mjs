import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import { Octokit } from "octokit";

const app=express(), PORT=Number(process.env.PORT||10000);
app.use(express.json({limit:"2mb"}));
app.use(cors({origin:process.env.CORS_ORIGIN||true,credentials:true}));

const need=n=>{if(!process.env[n])throw Error(`Missing environment variable: ${n}`);return process.env[n]};
const enc=b=>Buffer.from(b).toString("base64url");
const cookies=s=>Object.fromEntries((s||"").split(";").map(x=>x.trim()).filter(Boolean).map(x=>{let i=x.indexOf("=");return[x.slice(0,i),decodeURIComponent(x.slice(i+1))]}));
function seal(text){const k=crypto.createHash("sha256").update(need("GENESIS_SESSION_SECRET")).digest(),iv=crypto.randomBytes(12),c=crypto.createCipheriv("aes-256-gcm",k,iv),d=Buffer.concat([c.update(text),c.final()]);return `${enc(iv)}.${enc(c.getAuthTag())}.${enc(d)}`}
function open(v){const [i,t,d]=String(v||"").split("."),k=crypto.createHash("sha256").update(need("GENESIS_SESSION_SECRET")).digest(),c=crypto.createDecipheriv("aes-256-gcm",k,Buffer.from(i,"base64url"));c.setAuthTag(Buffer.from(t,"base64url"));return Buffer.concat([c.update(Buffer.from(d,"base64url")),c.final()]).toString()}
function token(req){const c=cookies(req.headers.cookie);if(!c.genesis_session)return null;try{return JSON.parse(open(c.genesis_session))}catch{return null}}
function gh(req){const t=token(req);if(!t?.access_token)throw Error("GitHub authentication required");return new Octokit({auth:t.access_token})}

async function ai(n,system,user){
  const p=`GENESIS_AI_${n}_`, key=need(p+"API_KEY"), model=need(p+"MODEL");
  if((process.env[p+"PROVIDER"]||"mistral").toLowerCase()!=="mistral")throw Error("V1 provider must be mistral");
  const r=await fetch("https://api.mistral.ai/v1/chat/completions",{method:"POST",headers:{"Authorization":`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({model,temperature:.1,messages:[{role:"system",content:system},{role:"user",content:user}]})});
  const d=await r.json();if(!r.ok)throw Error(d?.message||`Mistral HTTP ${r.status}`);return d.choices?.[0]?.message?.content||"";
}
function json(s){s=String(s).replace(/^```json/i,"").replace(/```$/,"").trim();try{return JSON.parse(s)}catch{}let a=s.indexOf("{"),b=s.lastIndexOf("}");if(a<0||b<=a)throw Error("AI returned invalid JSON");return JSON.parse(s.slice(a,b+1))}
async function tree(o,r,b){const x=await o.rest.git.getRef({owner:r[0],repo:r[1],ref:`heads/${b}`});const c=await o.rest.repos.getCommit({owner:r[0],repo:r[1],ref:x.data.object.sha});const t=await o.rest.git.getTree({owner:r[0],repo:r[1],tree_sha:c.data.commit.tree.sha,recursive:"true"});return{x:x.data.object.sha,files:t.data.tree.filter(v=>v.type==="blob").map(v=>({path:v.path,size:v.size||0}))}}
async function read(o,owner,repo,ref,path){const x=await o.rest.repos.getContent({owner,repo,path,ref});if(Array.isArray(x.data))throw Error("not file");return Buffer.from(x.data.content||"","base64").toString("utf8")}
const A=`You are GENESIS Key 1, analysis. Return JSON only: objective, requirements[], project_findings[], required_changes[], risks[], unknowns[], confidence. Never invent facts.`;
const P=`You are GENESIS Key 2, planning. Return JSON only: objective, steps[], dependencies[], commands[], validation[], prohibited_changes[], execution_policy. Each step has id, action(create|modify|delete), path, description.`;
const U=`You are GENESIS Key 1, execution. Return JSON only: operations:[{action,path,content?,reason}]. Only operate on approved plan paths. Do not use shell.`;
const AUD=`You are GENESIS Key 2, auditor. Return JSON only: status(passed|failed|needs_review), requirements[], plan_compliance, validation[], issues[], warnings[], confidence. Use evidence, not executor claims.`;

const jobs=new Map();
function ev(j,type,message,data={}){j.events.push({id:crypto.randomUUID(),at:new Date().toISOString(),type,message,data})}

app.get("/api/health",(_,res)=>res.json({ok:true,service:"genesis-backend",version:"1.0.0"}));
app.get("/api/config",(_,res)=>res.json({name:"EXTENSÃO-GENESIS2.0",ai:{key1:{provider:process.env.GENESIS_AI_1_PROVIDER||"mistral",model:process.env.GENESIS_AI_1_MODEL||"codestral-2508"},key2:{provider:process.env.GENESIS_AI_2_PROVIDER||"mistral",model:process.env.GENESIS_AI_2_MODEL||"codestral-2508"}}}));

app.get("/auth/github",(req,res)=>{const state=enc(crypto.randomBytes(32));res.setHeader("Set-Cookie",`genesis_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=600`);const q=new URLSearchParams({client_id:need("GITHUB_CLIENT_ID"),redirect_uri:need("GITHUB_REDIRECT_URI"),state,scope:"repo read:user user:email"});res.redirect(`https://github.com/login/oauth/authorize?${q}`)});
app.get("/auth/github/callback",async(req,res)=>{try{const c=cookies(req.headers.cookie);if(!req.query.code||req.query.state!==c.genesis_oauth_state)return res.status(400).send("GÊNESIS: OAuth state inválido.");const x=await fetch("https://github.com/login/oauth/access_token",{method:"POST",headers:{"Accept":"application/json","Content-Type":"application/json"},body:JSON.stringify({client_id:need("GITHUB_CLIENT_ID"),client_secret:need("GITHUB_CLIENT_SECRET"),code:req.query.code,redirect_uri:need("GITHUB_REDIRECT_URI")})});const d=await x.json();if(!d.access_token)throw Error(d.error_description||"OAuth exchange failed");const o=new Octokit({auth:d.access_token}),u=await o.rest.users.getAuthenticated();const s=encodeURIComponent(seal(JSON.stringify({access_token:d.access_token,login:u.data.login,id:u.data.id})));res.setHeader("Set-Cookie",`genesis_session=${s}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=86400`);res.send("<h2>GÊNESIS</h2><p>GitHub conectado. Retorne à extensão.</p>")}catch(e){res.status(500).send(`OAuth error: ${e.message}`)}});

app.get("/api/github/status",async(req,res)=>{try{const o=gh(req),u=await o.rest.users.getAuthenticated();res.json({connected:true,user:{login:u.data.login,id:u.data.id}})}catch{res.json({connected:false})}});
app.get("/api/github/repos",async(req,res)=>{try{const o=gh(req),x=await o.rest.repos.listForAuthenticatedUser({per_page:100,sort:"updated"});res.json({repositories:x.data.map(r=>({full_name:r.full_name,name:r.name,owner:r.owner.login,default_branch:r.default_branch||"main",private:r.private}))})}catch(e){res.status(401).json({error:e.message})}});
app.get("/api/github/branches",async(req,res)=>{try{const o=gh(req),[owner,repo]=String(req.query.repo||"").split("/");const x=await o.rest.repos.listBranches({owner,repo,per_page:100});res.json({branches:x.data.map(b=>b.name)})}catch(e){res.status(400).json({error:e.message})}});

async function execute(req,j){
  const o=gh(req),[owner,repo]=[j.repo.owner,j.repo.repo],branch=j.branch||"main";
  ev(j,"stage","Análise iniciada",{stage:"analysis"});const before=await tree(o,[owner,repo],branch);
  const files=before.files.slice(0,80), ctx=[];for(const f of files)if(f.size<200000&&!f.path.startsWith("node_modules/"))try{ctx.push({path:f.path,content:await read(o,owner,repo,branch,f.path)})}catch{}
  const analysis=json(await ai(1,A,JSON.stringify({request:j.prompt,repository:{owner,repo,branch,commit:before.x},file_tree:files,relevant_files:ctx})));ev(j,"stage","Análise concluída",{stage:"analysis"});
  ev(j,"stage","Plano iniciado",{stage:"plan"});const plan=json(await ai(2,P,JSON.stringify({request:j.prompt,analysis,repository:{owner,repo,branch,commit:before.x}})));ev(j,"stage","Plano concluído",{stage:"plan"});
  ev(j,"stage","Execução iniciada",{stage:"execution"});const ops=json(await ai(1,U,JSON.stringify({request:j.prompt,analysis,plan,repository:{owner,repo,branch,base_commit:before.x}})));
  const allowed=new Set((plan.steps||[]).map(s=>`${s.action}:${s.path}`)),applied=[],rejected=[];
  for(const op of ops.operations||[]){if(!allowed.has(`${op.action}:${op.path}`)){rejected.push({...op,reason:"outside approved plan"});continue}
    if(typeof op.content!=="string"&&op.action!=="delete"){rejected.push({...op,reason:"missing content"});continue}
    if(op.action==="delete"){const e=await o.rest.repos.getContent({owner,repo,path:op.path,ref:branch});await o.rest.repos.deleteFile({owner,repo,path:op.path,message:`GÊNESIS: delete ${op.path}`,sha:e.data.sha,branch})}
    else {let sha;try{const e=await o.rest.repos.getContent({owner,repo,path:op.path,ref:branch});if(!Array.isArray(e.data))sha=e.data.sha}catch{}await o.rest.repos.createOrUpdateFileContents({owner,repo,path:op.path,message:`GÊNESIS: ${op.action} ${op.path}`,content:Buffer.from(op.content).toString("base64"),branch,...sha?{sha}: {}})}
    applied.push(op)
  }
  const after=await tree(o,[owner,repo],branch);ev(j,"stage","Execução concluída",{stage:"execution",base_commit:before.x,result_commit:after.x,applied,rejected});
  ev(j,"stage","Auditoria iniciada",{stage:"audit"});const audit=json(await ai(2,AUD,JSON.stringify({request:j.prompt,analysis,plan,execution:{base_commit:before.x,result_commit:after.x,applied,rejected}})));ev(j,"stage","Auditoria concluída",{stage:"audit",result:audit});
  j.result={status:audit.status,repository:{owner,repo,branch,base_commit:before.x,result_commit:after.x},analysis,plan,execution:{applied,rejected},audit,report:{summary:audit.status==="passed"?"Execução concluída e auditada.":"Execução concluída com pendências.",files_changed:applied.map(x=>x.path)}};j.status="completed";ev(j,"completed","GÊNESIS concluída",{status:audit.status});
}
app.post("/api/tasks",async(req,res)=>{try{if(!token(req))return res.status(401).json({error:"GitHub authentication required"});const{prompt,repo,branch="main"}=req.body||{},[owner,name]=String(repo||"").split("/");if(!prompt||!owner||!name)return res.status(400).json({error:"prompt and repo=owner/name are required"});const j={id:crypto.randomUUID(),status:"running",prompt,repo:{owner,repo:name},branch,events:[],result:null};jobs.set(j.id,j);ev(j,"started","Tarefa recebida",{stage:"analysis"});execute(req,j).catch(e=>{j.status="failed";j.error=e.message;ev(j,"error",e.message)});res.status(202).json({id:j.id,status:j.status})}catch(e){res.status(500).json({error:e.message})}});
app.get("/api/tasks/:id",(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:"Task not found"});res.json(j)});
app.listen(PORT,()=>console.log(`GÊNESIS backend listening on ${PORT}`));

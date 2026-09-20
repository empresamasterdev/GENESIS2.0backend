import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import { Octokit } from "octokit";

const app = express();
const PORT = Number(process.env.PORT || 10000);

app.use(express.json({ limit: "8mb" }));
app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));

const need = (name) => {
  if (!process.env[name]) throw new Error(`Missing environment variable: ${name}`);
  return process.env[name];
};

const enc = (value) => Buffer.from(value).toString("base64url");

const cookies = (value) => Object.fromEntries(
  (value || "").split(";").map(x => x.trim()).filter(Boolean).map(x => {
    const i = x.indexOf("=");
    return [x.slice(0, i), decodeURIComponent(x.slice(i + 1))];
  })
);

function seal(text) {
  const key = crypto.createHash("sha256").update(need("GENESIS_SESSION_SECRET")).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(text), cipher.final()]);
  return `${enc(iv)}.${enc(cipher.getAuthTag())}.${enc(data)}`;
}

function open(value) {
  const [ivText, tagText, dataText] = String(value || "").split(".");
  if (!ivText || !tagText || !dataText) throw new Error("Invalid session");
  const key = crypto.createHash("sha256").update(need("GENESIS_SESSION_SECRET")).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataText, "base64url")),
    decipher.final()
  ]).toString();
}

const authCodes = new Map();

function token(req) {
  const authorization = String(req.headers.authorization || "");
  if (/^Bearer\s+/i.test(authorization)) {
    try { return JSON.parse(open(authorization.replace(/^Bearer\s+/i, ""))); }
    catch { return null; }
  }
  const c = cookies(req.headers.cookie);
  if (!c.genesis_session) return null;
  try { return JSON.parse(open(c.genesis_session)); }
  catch { return null; }
}

function gh(req) {
  const session = token(req);
  if (!session?.access_token) throw new Error("GitHub authentication required");
  return new Octokit({ auth: session.access_token });
}

async function ai(number, system, user) {
  const prefix = `GENESIS_AI_${number}_`;
  const key = need(prefix + "API_KEY");
  const model = need(prefix + "MODEL");
  const provider = (process.env[prefix + "PROVIDER"] || "mistral").toLowerCase();
  if (provider !== "mistral") throw new Error(`GENESIS AI ${number}: provider must be mistral`);

  const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data?.message || `Mistral HTTP ${response.status}`);
  return data.choices?.[0]?.message?.content || "";
}

function parseJson(value) {
  const text = String(value).replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI returned invalid JSON");
  return JSON.parse(text.slice(start, end + 1));
}

function repoParts(repo) {
  const [owner, name] = String(repo || "").split("/");
  if (!owner || !name) throw new Error("Repository must be owner/name");
  return { owner, name };
}

async function getBranchState(octokit, owner, repo, branch) {
  const ref = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
  const commit = await octokit.rest.repos.getCommit({ owner, repo, ref: branch });
  const tree = await octokit.rest.git.getTree({
    owner, repo, tree_sha: commit.data.commit.tree.sha, recursive: "true"
  });
  return {
    commit: ref.data.object.sha,
    treeSha: commit.data.commit.tree.sha,
    files: tree.data.tree.filter(x => x.type === "blob").map(x => ({
      path: x.path, size: x.size || 0, sha: x.sha
    }))
  };
}

async function readFile(octokit, owner, repo, branch, path) {
  const result = await octokit.rest.repos.getContent({ owner, repo, path, ref: branch });
  if (Array.isArray(result.data)) throw new Error(`Not a file: ${path}`);
  return Buffer.from(result.data.content || "", "base64").toString("utf8");
}

const IGNORE_DIRS = ["node_modules/", ".git/", "dist/", "build/", ".next/", ".turbo/", "coverage/", "vendor/"];
const SOURCE_EXTENSIONS = new Set([
  ".js",".jsx",".ts",".tsx",".mjs",".cjs",".css",".scss",".html",".json",".md",".yaml",".yml",".toml"
]);

function extensionOf(path) {
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.slice(i).toLowerCase() : "";
}

function isReadableProjectFile(path, size) {
  if (size > 250000 || IGNORE_DIRS.some(prefix => path.startsWith(prefix))) return false;
  const lower = path.toLowerCase();
  if (lower.endsWith(".lock") || lower.endsWith(".map") ||
      lower.endsWith(".min.js") || lower.endsWith(".min.css")) return false;
  return SOURCE_EXTENSIONS.has(extensionOf(path));
}

function rankProjectFiles(files) {
  const important = [
    "package.json","vite.config.","next.config.","tsconfig","tailwind.config.",
    "src/main.","src/index.","src/app.","src/routes/","src/pages/","src/components/",
    "src/styles.","app/","pages/","components/"
  ];
  const score = p => important.reduce((n, token, i) =>
    n + (p.startsWith(token) || p.includes(token) ? 100 - i : 0), 0);
  return [...files].filter(f => isReadableProjectFile(f.path, f.size))
    .sort((a,b) => score(b.path) - score(a.path) || a.path.localeCompare(b.path));
}

async function readProjectContext(octokit, owner, repo, branch, files, limitBytes = 2500000) {
  const selected = rankProjectFiles(files);
  const context = [];
  let used = 0;
  for (const file of selected) {
    if (used + file.size > limitBytes) continue;
    try {
      const content = await readFile(octokit, owner, repo, branch, file.path);
      context.push({ path: file.path, size: file.size, content });
      used += Buffer.byteLength(content, "utf8");
    } catch {}
  }
  return { context, bytes: used, considered: selected.length };
}

const ANALYST_SYSTEM = `You are GENESIS CORE — Lead Software Architect and Repository Analyst.
You are the ONLY component allowed to reason about what should be changed.
Understand the real repository before proposing changes. Treat existing code as source of truth.
Never invent files, frameworks, routes, components, APIs, dependencies or architecture.
Prefer modifying existing files when functionality already belongs there. Create new files only when architecturally justified.
Preserve working architecture, routing, styling and dependencies unless the request requires otherwise.
Identify actual framework, entry points, routing, reusable components, dependencies, relevant files and files that must remain untouched.
Return JSON only:
{"objective":"","requirements":[],"project_findings":[],"architecture":[],"required_changes":[],"files_to_read_before_execution":[],"risks":[],"unknowns":[],"confidence":0,
"plan":{"steps":[{"id":1,"action":"create|modify|delete","path":"","description":"","reason":"","depends_on":[]}],"dependencies":[],"validation":[],"prohibited_changes":[],"execution_policy":""}}`;

const EXECUTOR_SYSTEM = `You are GENESIS EXECUTOR.
Do NOT analyze the request, redesign the plan, or add extra work. The Lead Architect already supplied a closed plan.
Execute ONLY the approved plan against the supplied real repository files.
Only operate on approved paths. Preserve existing code and make minimum necessary changes.
Never replace an entire existing file when a targeted modification is sufficient. Never invent dependencies. Never use shell commands.
If a change cannot be safely performed from supplied files, report it instead of fabricating code.
Return complete resulting contents for changed/created files.
Return JSON only:
{"operations":[{"action":"create|modify|delete","path":"","content":"","reason":""}],"execution_notes":[],"blocked_items":[]}`;

const AUDITOR_SYSTEM = `You are GENESIS AUDITOR and Lead Architect returning after execution.
The executor is NOT authoritative; the repository after execution is authoritative.
Compare original state, approved plan, actual resulting repository and Git evidence.
Check architecture, existing-file reuse, duplicate/disconnected implementations, routing, imports/exports, assets, dependencies, scope and requested behavior.
Return JSON only:
{"status":"passed|failed|needs_review","requirements":[{"requirement":"","status":"passed|failed|partial","evidence":""}],
"plan_compliance":"full|partial|failed","what_changed":[],"what_was_not_changed":[],"issues":[],"warnings":[],"next_action":"","confidence":0,
"human_report":{"summary":"","result":"","changes":[],"verification":[],"problems":[],"recommendation":""}}`;

const jobs = new Map();

function event(job, type, message, data = {}) {
  job.events.push({ id: crypto.randomUUID(), at: new Date().toISOString(), type, message, data });
}

function stage(job, name, status, message, data = {}) {
  event(job, "pipeline", message, { stage: name, status, ...data });
}

async function commitOperations(octokit, owner, repo, branch, baseCommit, operations) {
  if (!operations.length) return { commit: baseCommit, changed: [], commit_created: false };

  const base = await octokit.rest.git.getCommit({ owner, repo, commit_sha: baseCommit });
  const treeItems = [];

  for (const op of operations) {
    if (op.action === "delete") {
      treeItems.push({ path: op.path, mode: "100644", type: "blob", sha: null });
    } else {
      const blob = await octokit.rest.git.createBlob({
        owner, repo, content: op.content, encoding: "utf-8"
      });
      treeItems.push({ path: op.path, mode: "100644", type: "blob", sha: blob.data.sha });
    }
  }

  const tree = await octokit.rest.git.createTree({
    owner, repo, base_tree: base.data.tree.sha, tree: treeItems
  });

  const commit = await octokit.rest.git.createCommit({
    owner, repo,
    message: `GÊNESIS: ${operations.length} alteração${operations.length === 1 ? "" : "ões"} consolidadas`,
    tree: tree.data.sha,
    parents: [baseCommit]
  });

  await octokit.rest.git.updateRef({
    owner, repo, ref: `heads/${branch}`, sha: commit.data.sha, force: false
  });

  return {
    commit: commit.data.sha,
    changed: operations.map(x => x.path),
    commit_created: true
  };
}

async function executeJob(req, job) {
  const octokit = gh(req);
  const { owner, repo } = job.repo;
  const branch = job.branch;

  stage(job, "repository_scan", "running", "Lendo o estado atual do repositório antes de planejar.");
  const before = await getBranchState(octokit, owner, repo, branch);
  event(job, "repository", "Estado inicial do projeto carregado.", {
    commit: before.commit, file_count: before.files.length
  });

  const projectContext = await readProjectContext(octokit, owner, repo, branch, before.files);
  stage(job, "repository_scan", "completed", "Leitura inicial do projeto concluída.", {
    commit: before.commit, files_considered: projectContext.considered,
    files_read: projectContext.context.length, bytes_read: projectContext.bytes
  });

  stage(job, "analysis", "running", "IA 1 está analisando o projeto real e o pedido.");
  const architecture = parseJson(await ai(1, ANALYST_SYSTEM, JSON.stringify({
    user_request: job.prompt,
    repository: { owner, repo, branch, base_commit: before.commit, file_tree: before.files },
    project_files: projectContext.context
  })));
  stage(job, "analysis", "completed", "IA 1 terminou a análise do projeto.", { confidence: architecture.confidence });

  stage(job, "planning", "running", "IA 1 está transformando a análise em uma ordem fechada de execução.");
  const plan = architecture.plan;
  if (!plan || !Array.isArray(plan.steps)) throw new Error("IA 1 returned an invalid execution plan.");

  const plannedPaths = [...new Set(plan.steps.map(s => s.path).filter(Boolean))];
  const plannedFiles = [];
  for (const path of plannedPaths) {
    const exists = before.files.find(file => file.path === path);
    if (exists) {
      try {
        plannedFiles.push({ path, exists: true, content: await readFile(octokit, owner, repo, branch, path) });
      } catch {
        plannedFiles.push({ path, exists: true, content: null, read_error: true });
      }
    } else {
      plannedFiles.push({ path, exists: false, content: null });
    }
  }
  stage(job, "planning", "completed", "Plano fechado pela IA 1.", {
    steps: plan.steps.length, approved_paths: plannedPaths
  });

  stage(job, "execution", "running", "IA 2 recebeu o plano fechado e iniciou a execução.");
  const execution = parseJson(await ai(2, EXECUTOR_SYSTEM, JSON.stringify({
    user_request: job.prompt,
    repository: { owner, repo, branch, base_commit: before.commit },
    analysis: {
      objective: architecture.objective,
      requirements: architecture.requirements,
      project_findings: architecture.project_findings,
      architecture: architecture.architecture
    },
    plan,
    approved_files: plannedFiles
  })));

  const approved = new Map(plan.steps.map(step => [`${step.action}:${step.path}`, step]));
  const operations = [];
  const rejected = [];

  for (const operation of execution.operations || []) {
    const key = `${operation.action}:${operation.path}`;
    if (!approved.has(key)) {
      rejected.push({ ...operation, reason: "Operation is outside the approved plan." });
      continue;
    }
    if (operation.action !== "delete" && typeof operation.content !== "string") {
      rejected.push({ ...operation, reason: "Missing resulting file content." });
      continue;
    }
    operations.push({
      action: operation.action, path: operation.path,
      content: operation.content, reason: operation.reason || ""
    });
  }

  const commitResult = await commitOperations(
    octokit, owner, repo, branch, before.commit, operations
  );

  stage(job, "execution", "completed",
    "IA 2 terminou e as alterações foram consolidadas em um único commit.", {
      result_commit: commitResult.commit, changed_files: commitResult.changed
    });

  stage(job, "verification", "running", "Recarregando o repositório para verificar o resultado real.");
  const after = await getBranchState(octokit, owner, repo, branch);

  const verificationFiles = [];
  for (const path of new Set(commitResult.changed)) {
    try {
      verificationFiles.push({ path, content: await readFile(octokit, owner, repo, branch, path) });
    } catch {
      verificationFiles.push({ path, content: null, missing_after_execution: true });
    }
  }
  stage(job, "verification", "completed", "Estado final do repositório carregado.", {
    result_commit: after.commit
  });

  stage(job, "audit", "running", "IA 1 está auditando o resultado real da execução.");
  const audit = parseJson(await ai(1, AUDITOR_SYSTEM, JSON.stringify({
    user_request: job.prompt,
    repository_before: { owner, repo, branch, commit: before.commit, file_count: before.files.length },
    repository_after: { owner, repo, branch, commit: after.commit, file_count: after.files.length },
    analysis: architecture,
    plan,
    execution: {
      operations_requested_by_executor: execution.operations || [],
      applied: operations, rejected, commit: commitResult.commit
    },
    resulting_files: verificationFiles
  })));

  stage(job, "audit", "completed", "Auditoria da IA 1 concluída.", {
    status: audit.status, confidence: audit.confidence
  });

  job.result = {
    status: audit.status,
    repository: { owner, repo, branch, base_commit: before.commit, result_commit: after.commit },
    analysis: architecture,
    plan,
    execution: { applied: operations, rejected, commit: commitResult.commit, commit_created: commitResult.commit_created },
    audit,
    report: {
      summary: audit.human_report?.summary || "Execução auditada.",
      human: audit.human_report || null,
      files_changed: commitResult.changed
    }
  };

  job.status = "completed";
  event(job, "completed", "GÊNESIS concluiu análise, planejamento, execução e auditoria.", {
    status: audit.status, commit: after.commit
  });
}

app.get("/api/health", (_, res) => res.json({
  ok: true, service: "genesis-backend", version: "2.0.0"
}));

app.get("/api/config", (_, res) => res.json({
  name: "EXTENSÃO-GENESIS2.0",
  version: "2.0.0",
  pipeline: ["repository_scan", "analysis", "planning", "execution", "verification", "audit"],
  ai: {
    key1: {
      provider: process.env.GENESIS_AI_1_PROVIDER || "mistral",
      model: process.env.GENESIS_AI_1_MODEL || "configured-by-environment"
    },
    key2: {
      provider: process.env.GENESIS_AI_2_PROVIDER || "mistral",
      model: process.env.GENESIS_AI_2_MODEL || "configured-by-environment"
    }
  }
}));

app.get("/auth/github", (req, res) => {
  const state = String(req.query.state || enc(crypto.randomBytes(32)));
  const extensionRedirect = String(req.query.extension_redirect || "");
  if (extensionRedirect !== String(process.env.GENESIS_EXTENSION_REDIRECT_URI || "")) {
    return res.status(400).send("GÊNESIS: extension redirect inválido.");
  }
  res.setHeader("Set-Cookie",
    `genesis_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=600`);
  const query = new URLSearchParams({
    client_id: need("GITHUB_CLIENT_ID"),
    redirect_uri: need("GITHUB_REDIRECT_URI"),
    state,
    scope: "repo read:user user:email"
  });
  res.redirect(`https://github.com/login/oauth/authorize?${query}`);
});

app.get("/auth/github/callback", async (req, res) => {
  try {
    const c = cookies(req.headers.cookie);
    if (!req.query.code || req.query.state !== c.genesis_oauth_state) {
      return res.status(400).send("GÊNESIS: OAuth state inválido.");
    }
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: need("GITHUB_CLIENT_ID"),
        client_secret: need("GITHUB_CLIENT_SECRET"),
        code: req.query.code,
        redirect_uri: need("GITHUB_REDIRECT_URI")
      })
    });
    const data = await response.json();
    if (!data.access_token) throw new Error(data.error_description || "OAuth exchange failed");

    const octokit = new Octokit({ auth: data.access_token });
    const user = await octokit.rest.users.getAuthenticated();
    const session = seal(JSON.stringify({
      access_token: data.access_token, login: user.data.login, id: user.data.id
    }));

    const extensionRedirect = String(process.env.GENESIS_EXTENSION_REDIRECT_URI || "");
    if (extensionRedirect) {
      const code = enc(crypto.randomBytes(32));
      authCodes.set(code, { session, created: Date.now() });
      setTimeout(() => authCodes.delete(code), 300000);
      const target = new URL(extensionRedirect);
      target.searchParams.set("code", code);
      target.searchParams.set("state", String(req.query.state));
      return res.redirect(target.toString());
    }

    res.setHeader("Set-Cookie",
      `genesis_session=${encodeURIComponent(session)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=86400`);
    res.send("<h2>GÊNESIS</h2><p>GitHub conectado.</p>");
  } catch (error) {
    res.status(500).send(`OAuth error: ${error.message}`);
  }
});

app.post("/auth/github/exchange", (req, res) => {
  const code = String(req.body?.code || "");
  const item = authCodes.get(code);
  if (!item || Date.now() - item.created > 300000) {
    return res.status(400).json({ error: "Código OAuth inválido ou expirado." });
  }
  authCodes.delete(code);
  try {
    const session = JSON.parse(open(item.session));
    res.json({ session_token: item.session, user: { login: session.login, id: session.id } });
  } catch {
    res.status(400).json({ error: "Sessão OAuth inválida." });
  }
});

app.get("/api/github/status", async (req, res) => {
  try {
    const octokit = gh(req);
    const user = await octokit.rest.users.getAuthenticated();
    res.json({ connected: true, user: { login: user.data.login, id: user.data.id } });
  } catch {
    res.json({ connected: false });
  }
});

app.get("/api/github/repos", async (req, res) => {
  try {
    const octokit = gh(req);
    const response = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
      per_page: 100, sort: "updated"
    });
    res.json({
      repositories: response.map(repo => ({
        full_name: repo.full_name,
        name: repo.name,
        owner: repo.owner.login,
        default_branch: repo.default_branch || "main",
        private: repo.private
      }))
    });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.get("/api/github/branches", async (req, res) => {
  try {
    const octokit = gh(req);
    const { owner, name } = repoParts(req.query.repo);
    const response = await octokit.paginate(octokit.rest.repos.listBranches, {
      owner, repo: name, per_page: 100
    });
    res.json({ branches: response.map(branch => branch.name) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/tasks", async (req, res) => {
  try {
    if (!token(req)) return res.status(401).json({ error: "GitHub authentication required" });
    const { prompt, repo, branch = "main" } = req.body || {};
    const parts = repoParts(repo);
    if (!prompt) return res.status(400).json({ error: "prompt is required" });

    const job = {
      id: crypto.randomUUID(),
      status: "running",
      prompt,
      repo: { owner: parts.owner, repo: parts.name },
      branch,
      created_at: new Date().toISOString(),
      events: [],
      result: null,
      error: null
    };

    jobs.set(job.id, job);
    event(job, "started", "Tarefa recebida.", { stage: "repository_scan" });
    executeJob(req, job).catch(error => {
      job.status = "failed";
      job.error = error.message;
      event(job, "error", error.message, { stage: "pipeline" });
    });

    res.status(202).json({ id: job.id, status: job.status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/tasks/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Task not found" });
  res.json(job);
});

app.listen(PORT, () => console.log(`GÊNESIS backend listening on ${PORT}`));

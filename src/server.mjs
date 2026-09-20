import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import { Octokit } from "octokit";

const app = express();
const PORT = Number(process.env.PORT || 10000);

app.use(express.json({ limit: "8mb" }));
app.use(cors({
  origin: process.env.CORS_ORIGIN || true,
  credentials: true
}));

const need = (name) => {
  if (!process.env[name]) throw new Error(`Missing environment variable: ${name}`);
  return process.env[name];
};

const enc = (value) => Buffer.from(value).toString("base64url");

const cookies = (value) =>
  Object.fromEntries(
    String(value || "")
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        const i = x.indexOf("=");
        return [x.slice(0, i), decodeURIComponent(x.slice(i + 1))];
      })
  );

function seal(text) {
  const key = crypto.createHash("sha256")
    .update(need("GENESIS_SESSION_SECRET"))
    .digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(text), cipher.final()]);
  return `${enc(iv)}.${enc(cipher.getAuthTag())}.${enc(data)}`;
}

function open(value) {
  const [iv, tag, data] = String(value || "").split(".");
  if (!iv || !tag || !data) throw new Error("Invalid session token");

  const key = crypto.createHash("sha256")
    .update(need("GENESIS_SESSION_SECRET"))
    .digest();

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64url")
  );

  decipher.setAuthTag(Buffer.from(tag, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final()
  ]).toString();
}

const authCodes = new Map();

function sessionFromRequest(req) {
  const authorization = String(req.headers.authorization || "");

  if (/^Bearer\s+/i.test(authorization)) {
    try {
      return JSON.parse(open(authorization.replace(/^Bearer\s+/i, "")));
    } catch {
      return null;
    }
  }

  const c = cookies(req.headers.cookie);

  if (!c.genesis_session) return null;

  try {
    return JSON.parse(open(c.genesis_session));
  } catch {
    return null;
  }
}

function github(req) {
  const session = sessionFromRequest(req);

  if (!session?.access_token) {
    throw new Error("GitHub authentication required");
  }

  return new Octokit({ auth: session.access_token });
}

async function mistral(modelEnv, system, user, temperature = 0.1) {
  const prefix = `GENESIS_AI_${modelEnv}_`;
  const provider = (process.env[prefix + "PROVIDER"] || "mistral").toLowerCase();

  if (provider !== "mistral") {
    throw new Error(`Unsupported provider for ${modelEnv}: ${provider}`);
  }

  const key = need(prefix + "API_KEY");
  const model = need(prefix + "MODEL");

  const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.message || `Mistral HTTP ${response.status}`);
  }

  return data.choices?.[0]?.message?.content || "";
}

function parseJson(value) {
  let text = String(value || "").trim();
  text = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

  try {
    return JSON.parse(text);
  } catch {}

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");

  if (first < 0 || last <= first) {
    throw new Error("AI returned invalid JSON");
  }

  return JSON.parse(text.slice(first, last + 1));
}

async function getBranchState(octokit, owner, repo, branch) {
  const ref = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`
  });

  const commit = await octokit.rest.repos.getCommit({
    owner,
    repo,
    ref: ref.data.object.sha
  });

  const tree = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: commit.data.commit.tree.sha,
    recursive: "true"
  });

  return {
    commit: ref.data.object.sha,
    tree: tree.data.tree
      .filter((entry) => entry.type === "blob")
      .map((entry) => ({
        path: entry.path,
        size: entry.size || 0
      }))
  };
}

async function readFile(octokit, owner, repo, branch, path) {
  const response = await octokit.rest.repos.getContent({
    owner,
    repo,
    path,
    ref: branch
  });

  if (Array.isArray(response.data)) {
    throw new Error(`Path is not a file: ${path}`);
  }

  return {
    sha: response.data.sha,
    content: Buffer.from(response.data.content || "", "base64").toString("utf8")
  };
}

function normalizePath(path) {
  return String(path || "").replace(/^\/+/, "").trim();
}

function relevantFiles(tree, prompt, max = 120) {
  const terms = String(prompt || "")
    .toLowerCase()
    .split(/[^a-z0-9áéíóúãõç_-]+/i)
    .filter((x) => x.length >= 3);

  const ignored = [
    "node_modules/",
    ".git/",
    "dist/",
    "build/",
    ".next/",
    "coverage/",
    "package-lock.json"
  ];

  const files = tree.filter((f) =>
    !ignored.some((prefix) => f.path.startsWith(prefix)) &&
    f.size <= 300000
  );

  if (!terms.length) return files.slice(0, max);

  const scored = files.map((file) => {
    const haystack = file.path.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term)) score += 5;
    }
    if (/\.(tsx|jsx|ts|js|css|scss|html)$/.test(haystack)) score += 1;
    return { file, score };
  });

  scored.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));

  const selected = scored
    .filter((x) => x.score > 0)
    .slice(0, max)
    .map((x) => x.file);

  if (selected.length < Math.min(30, max)) {
    const seen = new Set(selected.map((x) => x.path));
    for (const file of files) {
      if (!seen.has(file.path)) {
        selected.push(file);
        seen.add(file.path);
      }
      if (selected.length >= max) break;
    }
  }

  return selected;
}

async function readContext(octokit, owner, repo, branch, files) {
  const result = [];

  for (const file of files) {
    try {
      const data = await readFile(octokit, owner, repo, branch, file.path);
      result.push({
        path: file.path,
        content: data.content
      });
    } catch {}
  }

  return result;
}

function planPaths(plan) {
  return new Set(
    (plan.steps || [])
      .filter((step) => ["create", "modify", "delete"].includes(step.action))
      .map((step) => normalizePath(step.path))
  );
}

function validatePlan(plan) {
  if (!plan || typeof plan !== "object") throw new Error("Invalid plan");
  if (!Array.isArray(plan.steps) || !plan.steps.length) {
    throw new Error("IA 1 returned an empty execution plan");
  }

  for (const step of plan.steps) {
    if (!["create", "modify", "delete"].includes(step.action)) {
      throw new Error(`Invalid plan action: ${step.action}`);
    }
    if (!normalizePath(step.path)) {
      throw new Error("Plan contains a step without path");
    }
  }
}

function validateOperations(operations, plan) {
  const allowed = planPaths(plan);
  const rejected = [];
  const accepted = [];

  for (const operation of Array.isArray(operations) ? operations : []) {
    const action = String(operation.action || "");
    const path = normalizePath(operation.path);

    if (!allowed.has(path)) {
      rejected.push({
        ...operation,
        reason: "Path was not approved by IA 1 plan"
      });
      continue;
    }

    if (!["create", "modify", "delete"].includes(action)) {
      rejected.push({
        ...operation,
        reason: "Invalid operation"
      });
      continue;
    }

    if (action !== "delete" && typeof operation.content !== "string") {
      rejected.push({
        ...operation,
        reason: "Missing file content"
      });
      continue;
    }

    accepted.push({
      action,
      path,
      content: operation.content,
      reason: operation.reason || "Approved by IA 1 plan"
    });
  }

  return { accepted, rejected };
}

async function commitOperations(octokit, owner, repo, branch, operations, message) {
  if (!operations.length) {
    return {
      commit: null,
      tree: null
    };
  }

  const ref = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`
  });

  const baseCommitSha = ref.data.object.sha;

  const baseCommit = await octokit.rest.repos.getCommit({
    owner,
    repo,
    ref: baseCommitSha
  });

  const baseTreeSha = baseCommit.data.commit.tree.sha;

  const treeItems = [];

  for (const operation of operations) {
    if (operation.action === "delete") {
      treeItems.push({
        path: operation.path,
        mode: "100644",
        type: "blob",
        sha: null
      });
    } else {
      const blob = await octokit.rest.git.createBlob({
        owner,
        repo,
        content: operation.content,
        encoding: "utf-8"
      });

      treeItems.push({
        path: operation.path,
        mode: "100644",
        type: "blob",
        sha: blob.data.sha
      });
    }
  }

  const tree = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: treeItems
  });

  const commit = await octokit.rest.git.createCommit({
    owner,
    repo,
    message,
    tree: tree.data.sha,
    parents: [baseCommitSha]
  });

  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: commit.data.sha,
    force: false
  });

  return {
    commit: commit.data.sha,
    tree: tree.data.sha
  };
}

const ORCHESTRATOR_SYSTEM = `
You are GENESIS IA 1 — ORCHESTRATOR.

You are the only intelligence allowed to:
1. understand the user's request;
2. inspect and reason about the existing repository;
3. determine what already exists;
4. decide what must be reused, modified, created or left untouched;
5. produce the complete execution plan.

You must NOT execute changes.

You receive real repository evidence. Never invent files, frameworks, routes, dependencies, components, assets or existing behavior.

The goal is to make the smallest coherent change that satisfies the request while preserving the existing application.

For visual/UI requests, reason concretely about the implementation:
- existing components;
- layout hierarchy;
- CSS/Tailwind/styling system;
- animation implementation;
- responsive behavior;
- assets and image strategy;
- routing;
- state and interactions;
- accessibility;
- dependencies.

Do not reduce a visual request to generic text blocks.

Return JSON only:
{
  "objective": "...",
  "requirements": [],
  "project_findings": [],
  "existing_assets_and_components": [],
  "required_changes": [],
  "files_to_leave_untouched": [],
  "risks": [],
  "unknowns": [],
  "confidence": 0,
  "execution_plan": {
    "steps": [
      {
        "id": 1,
        "action": "create|modify|delete",
        "path": "...",
        "description": "...",
        "reason": "...",
        "depends_on": []
      }
    ]
  }
}
`;

const EXECUTOR_SYSTEM = `
You are GENESIS IA 2 — EXECUTOR.

You do not plan.
You do not reinterpret the user's request.
You do not choose different files.
You do not add scope.
You do not redesign the architecture.

IA 1 has already analyzed the repository and created an approved execution plan.

Your sole responsibility is to materialize that exact plan in code.

Rules:
- operate only on paths explicitly approved by IA 1;
- preserve unrelated existing code;
- when modifying a file, return the complete resulting file content;
- when creating a file, return the complete file content;
- when deleting, return no content;
- do not invent dependencies unless IA 1 explicitly approved them;
- do not use shell commands;
- do not return explanations outside JSON.

Return JSON only:
{
  "operations": [
    {
      "action": "create|modify|delete",
      "path": "...",
      "content": "...",
      "reason": "..."
    }
  ]
}
`;

const AUDITOR_SYSTEM = `
You are GENESIS IA 1 — FINAL AUDITOR.

You are receiving:
- the original request;
- IA 1's analysis and approved plan;
- the exact operations produced by IA 2;
- the actual GitHub state after execution.

Audit the result using evidence.

Do not trust claims from the executor.
Do not assume a file is correct merely because it was returned.
Identify missing requirements, unintended changes, suspicious placeholders, broken references, fake/example URLs, obvious integration inconsistencies, and violations of the approved plan.

For visual requests, verify that the implementation is actually visual code rather than merely descriptive text.

Return JSON only:
{
  "status": "passed|failed|needs_review",
  "human_summary": "...",
  "what_was_done": [],
  "what_was_not_done": [],
  "files_changed": [],
  "evidence": [],
  "issues": [],
  "warnings": [],
  "next_action": "...",
  "confidence": 0
}
`;

const jobs = new Map();

function event(job, type, message, data = {}) {
  job.events.push({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    type,
    message,
    data
  });
}

async function executeTask(req, job) {
  const octokit = github(req);
  const { owner, repo } = job.repository;
  const branch = job.branch;

  event(job, "stage", "IA 1: lendo o estado atual do repositório.", {
    stage: "repository_read"
  });

  const before = await getBranchState(octokit, owner, repo, branch);

  event(job, "stage", "IA 1: analisando a arquitetura e selecionando arquivos relevantes.", {
    stage: "analysis",
    base_commit: before.commit,
    file_count: before.tree.length
  });

  const candidateFiles = relevantFiles(before.tree, job.prompt, 120);
  const initialContext = await readContext(
    octokit,
    owner,
    repo,
    branch,
    candidateFiles
  );

  const analysis = parseJson(
    await mistral(
      "1",
      ORCHESTRATOR_SYSTEM,
      JSON.stringify({
        request: job.prompt,
        repository: {
          owner,
          repo,
          branch,
          base_commit: before.commit,
          total_files: before.tree.length
        },
        file_tree: before.tree,
        relevant_files: initialContext
      })
    )
  );

  event(job, "stage", "IA 1: análise concluída.", {
    stage: "analysis",
    confidence: analysis.confidence
  });

  event(job, "stage", "IA 1: construindo plano fechado de execução.", {
    stage: "planning"
  });

  const plan = {
    objective: analysis.objective,
    requirements: analysis.requirements,
    files_to_leave_untouched: analysis.files_to_leave_untouched || [],
    steps: analysis.execution_plan?.steps || [],
    required_changes: analysis.required_changes || []
  };

  validatePlan(plan);

  event(job, "stage", "IA 1: plano aprovado e bloqueado para execução.", {
    stage: "plan_locked",
    steps: plan.steps.map((step) => ({
      id: step.id,
      action: step.action,
      path: step.path,
      description: step.description
    }))
  });

  const paths = [...planPaths(plan)];

  const executionContext = await readContext(
    octokit,
    owner,
    repo,
    branch,
    paths.map((path) => ({
      path,
      size: before.tree.find((x) => x.path === path)?.size || 0
    }))
  );

  event(job, "stage", "IA 2: recebeu o plano fechado e o conteúdo real dos arquivos.", {
    stage: "executor_ready",
    files: paths
  });

  const execution = parseJson(
    await mistral(
      "2",
      EXECUTOR_SYSTEM,
      JSON.stringify({
        request: job.prompt,
        plan,
        repository: {
          owner,
          repo,
          branch,
          base_commit: before.commit
        },
        current_files: executionContext
      }),
      0
    )
  );

  const checked = validateOperations(execution.operations, plan);

  event(job, "stage", "IA 2: execução preparada; operações fora do plano foram bloqueadas.", {
    stage: "execution_validation",
    accepted: checked.accepted.length,
    rejected: checked.rejected.length
  });

  if (!checked.accepted.length) {
    throw new Error("IA 2 did not produce any approved operation.");
  }

  event(job, "stage", "Aplicando todas as alterações em um único commit Git.", {
    stage: "git_commit",
    files: checked.accepted.map((x) => x.path)
  });

  const commitResult = await commitOperations(
    octokit,
    owner,
    repo,
    branch,
    checked.accepted,
    `GÊNESIS: ${job.prompt.slice(0, 72)}`
  );

  const after = await getBranchState(octokit, owner, repo, branch);

  event(job, "stage", "IA 1: recebeu o resultado real do GitHub e iniciou a auditoria.", {
    stage: "audit",
    base_commit: before.commit,
    result_commit: after.commit
  });

  const changedPaths = checked.accepted.map((x) => x.path);

  const finalContext = await readContext(
    octokit,
    owner,
    repo,
    branch,
    changedPaths.map((path) => ({
      path,
      size: after.tree.find((x) => x.path === path)?.size || 0
    }))
  );

  const audit = parseJson(
    await mistral(
      "1",
      AUDITOR_SYSTEM,
      JSON.stringify({
        request: job.prompt,
        analysis,
        plan,
        execution: {
          accepted: checked.accepted.map(({ content, ...x }) => x),
          rejected: checked.rejected
        },
        repository_before: {
          commit: before.commit,
          tree: before.tree
        },
        repository_after: {
          commit: after.commit,
          tree: after.tree
        },
        actual_changed_files: finalContext
      })
    )
  );

  job.result = {
    status: audit.status,
    repository: {
      owner,
      repo,
      branch,
      base_commit: before.commit,
      result_commit: after.commit
    },
    analysis,
    plan,
    execution: {
      applied: checked.accepted.map(({ content, ...x }) => x),
      rejected: checked.rejected,
      commit: commitResult.commit
    },
    audit,
    report: {
      summary: audit.human_summary,
      what_was_done: audit.what_was_done || [],
      what_was_not_done: audit.what_was_not_done || [],
      issues: audit.issues || [],
      warnings: audit.warnings || [],
      files_changed: changedPaths
    }
  };

  job.status = audit.status === "failed" ? "failed" : "completed";

  event(job, "completed", "GÊNESIS concluiu análise, execução e auditoria.", {
    stage: "completed",
    status: audit.status
  });
}

app.get("/api/health", (_, res) => {
  res.json({
    ok: true,
    service: "genesis-backend",
    version: "2.0.0"
  });
});

app.get("/api/config", (_, res) => {
  res.json({
    name: "EXTENSÃO-GENESIS2.0",
    version: "2.0.0",
    pipeline: [
      "IA 1 — análise",
      "IA 1 — planejamento",
      "IA 2 — execução",
      "IA 1 — auditoria"
    ],
    ai: {
      key1: {
        provider: process.env.GENESIS_AI_1_PROVIDER || "mistral",
        model: process.env.GENESIS_AI_1_MODEL || "undefined"
      },
      key2: {
        provider: process.env.GENESIS_AI_2_PROVIDER || "mistral",
        model: process.env.GENESIS_AI_2_MODEL || "undefined"
      }
    }
  });
});

app.get("/auth/github", (req, res) => {
  const state = String(req.query.state || enc(crypto.randomBytes(32)));
  const extensionRedirect = String(req.query.extension_redirect || "");

  if (
    extensionRedirect !==
    String(process.env.GENESIS_EXTENSION_REDIRECT_URI || "")
  ) {
    return res.status(400).send("GÊNESIS: extension redirect inválido.");
  }

  res.setHeader(
    "Set-Cookie",
    `genesis_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=600`
  );

  const params = new URLSearchParams({
    client_id: need("GITHUB_CLIENT_ID"),
    redirect_uri: need("GITHUB_REDIRECT_URI"),
    state,
    scope: "repo read:user user:email"
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get("/auth/github/callback", async (req, res) => {
  try {
    const c = cookies(req.headers.cookie);

    if (!req.query.code || req.query.state !== c.genesis_oauth_state) {
      return res.status(400).send("GÊNESIS: OAuth state inválido.");
    }

    const response = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          client_id: need("GITHUB_CLIENT_ID"),
          client_secret: need("GITHUB_CLIENT_SECRET"),
          code: req.query.code,
          redirect_uri: need("GITHUB_REDIRECT_URI")
        })
      }
    );

    const data = await response.json();

    if (!data.access_token) {
      throw new Error(data.error_description || "OAuth exchange failed");
    }

    const octokit = new Octokit({ auth: data.access_token });
    const user = await octokit.rest.users.getAuthenticated();

    const session = seal(
      JSON.stringify({
        access_token: data.access_token,
        login: user.data.login,
        id: user.data.id
      })
    );

    const extensionRedirect = String(
      process.env.GENESIS_EXTENSION_REDIRECT_URI || ""
    );

    if (extensionRedirect) {
      const code = enc(crypto.randomBytes(32));

      authCodes.set(code, {
        session,
        created: Date.now()
      });

      setTimeout(() => authCodes.delete(code), 300000);

      const target = new URL(extensionRedirect);
      target.searchParams.set("code", code);
      target.searchParams.set("state", String(req.query.state));

      return res.redirect(target.toString());
    }

    res.setHeader(
      "Set-Cookie",
      `genesis_session=${encodeURIComponent(session)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=86400`
    );

    res.send("<h2>GÊNESIS</h2><p>GitHub conectado.</p>");
  } catch (error) {
    res.status(500).send(`OAuth error: ${error.message}`);
  }
});

app.post("/auth/github/exchange", (req, res) => {
  const code = String(req.body?.code || "");
  const item = authCodes.get(code);

  if (!item || Date.now() - item.created > 300000) {
    return res.status(400).json({
      error: "Código OAuth inválido ou expirado."
    });
  }

  authCodes.delete(code);

  try {
    const session = JSON.parse(open(item.session));

    res.json({
      session_token: item.session,
      user: {
        login: session.login,
        id: session.id
      }
    });
  } catch {
    res.status(400).json({
      error: "Sessão OAuth inválida."
    });
  }
});

app.get("/api/github/status", async (req, res) => {
  try {
    const octokit = github(req);
    const user = await octokit.rest.users.getAuthenticated();

    res.json({
      connected: true,
      user: {
        login: user.data.login,
        id: user.data.id
      }
    });
  } catch {
    res.json({ connected: false });
  }
});

app.get("/api/github/repos", async (req, res) => {
  try {
    const octokit = github(req);
    const response = await octokit.rest.repos.listForAuthenticatedUser({
      per_page: 100,
      sort: "updated"
    });

    res.json({
      repositories: response.data.map((repo) => ({
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
    const octokit = github(req);
    const [owner, repo] = String(req.query.repo || "").split("/");

    if (!owner || !repo) {
      return res.status(400).json({ error: "repo=owner/name is required" });
    }

    const response = await octokit.rest.repos.listBranches({
      owner,
      repo,
      per_page: 100
    });

    res.json({
      branches: response.data.map((branch) => branch.name)
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/tasks", async (req, res) => {
  try {
    if (!sessionFromRequest(req)) {
      return res.status(401).json({
        error: "GitHub authentication required"
      });
    }

    const { prompt, repo, branch } = req.body || {};
    const [owner, name] = String(repo || "").split("/");

    if (!prompt || !owner || !name) {
      return res.status(400).json({
        error: "prompt and repo=owner/name are required"
      });
    }

    const job = {
      id: crypto.randomUUID(),
      status: "running",
      prompt: String(prompt),
      repository: {
        owner,
        repo: name
      },
      branch: branch || "main",
      events: [],
      result: null
    };

    jobs.set(job.id, job);

    event(job, "started", "Tarefa recebida pela GÊNESIS.", {
      stage: "repository_read"
    });

    executeTask(req, job).catch((error) => {
      job.status = "failed";
      job.error = error.message;

      event(job, "error", error.message, {
        stage: "failed"
      });
    });

    res.status(202).json({
      id: job.id,
      status: job.status
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/tasks/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      error: "Task not found"
    });
  }

  res.json(job);
});

app.listen(PORT, () => {
  console.log(`GÊNESIS backend 2.0 listening on ${PORT}`);
});

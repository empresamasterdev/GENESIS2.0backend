import express from "express";
import cors from "cors";
import crypto from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 10000);
const MAX_HISTORY = 500;
const MAX_LOGS_PER_RUN = 300;

app.use(cors({
  origin: process.env.CORS_ORIGIN || "*",
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: "1mb" }));

const agents = [
  { id: "ia1", name: "IA1", role: "Estratégia", provider: "groq", model: process.env.GROQ_IA1_MODEL || "openai/gpt-oss-120b", keyEnv: "GROQ_IA1_API_KEY" },
  { id: "ia2", name: "IA2", role: "Análise", provider: "groq", model: process.env.GROQ_IA2_MODEL || "openai/gpt-oss-120b", keyEnv: "GROQ_IA2_API_KEY" },
  { id: "ia3", name: "IA3", role: "Código", provider: "groq", model: process.env.GROQ_IA3_MODEL || "openai/gpt-oss-120b", keyEnv: "GROQ_IA3_API_KEY" },
  { id: "ia4", name: "IA4", role: "Auditoria", provider: "groq", model: process.env.GROQ_IA4_MODEL || "openai/gpt-oss-120b", keyEnv: "GROQ_IA4_API_KEY" },
  { id: "ia5", name: "IA5", role: "Pesquisa", provider: "mistral", model: process.env.MISTRAL_IA5_MODEL || "mistral-small-2603", keyEnv: "MISTRAL_IA5_API_KEY" },
  { id: "ia6", name: "IA6", role: "Recuperação", provider: "mistral", model: process.env.MISTRAL_IA6_MODEL || "mistral-small-2603", keyEnv: "MISTRAL_IA6_API_KEY" }
];

const tests = [
  { id: "individual", name: "Teste Individual", description: "Avalia uma IA isoladamente." },
  { id: "comparative", name: "Teste Comparativo", description: "Executa a mesma tarefa em várias IAs." },
  { id: "progressive", name: "Teste Profundo", description: "Aumenta a dificuldade por níveis." },
  { id: "recovery", name: "Teste de Recuperação", description: "Avalia reação a erro, contexto perdido e tentativa novamente." },
  { id: "memory", name: "Teste de Memória", description: "Avalia retenção e montagem de peças de contexto." },
  { id: "cooperation", name: "Teste de Cooperação", description: "Avalia IAs trabalhando juntas." },
  { id: "arena", name: "Arena", description: "Compara arquiteturas e equipes." }
];

const runs = new Map();
const history = [];
const rateState = new Map();

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function addHistory(run) {
  history.unshift(run);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
}
function publicAgent(a) {
  return {
    id: a.id, name: a.name, role: a.role, provider: a.provider, model: a.model,
    configured: Boolean(process.env[a.keyEnv])
  };
}
function headersToObject(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) out[k.toLowerCase()] = v;
  return out;
}
function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function providerCall(agent, prompt, options = {}) {
  const key = process.env[agent.keyEnv];
  if (!key) throw new Error(`API key não configurada para ${agent.id}`);

  const started = Date.now();
  const url = agent.provider === "groq"
    ? "https://api.groq.com/openai/v1/chat/completions"
    : "https://api.mistral.ai/v1/chat/completions";

  const body = {
    model: agent.model,
    messages: [
      { role: "system", content: options.system || "Você é um agente de teste da VILTRIX AI LAB. Responda de forma objetiva." },
      { role: "user", content: prompt }
    ],
    temperature: options.temperature ?? 0.2,
    max_tokens: options.max_tokens ?? 700
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify(body)
  });

  const headers = headersToObject(response.headers);
  const elapsedMs = Date.now() - started;
  const text = await response.text();

  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  const usage = data?.usage || {};
  const inputTokens = Number(usage.prompt_tokens || estimateTokens(prompt));
  const outputTokens = Number(usage.completion_tokens || estimateTokens(data?.choices?.[0]?.message?.content || ""));

  if (!response.ok) {
    const retryAfter = headers["retry-after"];
    if (response.status === 429) {
      rateState.set(`${agent.provider}:${agent.model}`, {
        status: "cooldown",
        retryAfter: retryAfter || null,
        at: now()
      });
    }
    const message = data?.error?.message || data?.message || `HTTP ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.headers = headers;
    err.metrics = { elapsedMs, inputTokens, outputTokens };
    throw err;
  }

  rateState.set(`${agent.provider}:${agent.model}`, {
    status: "ok",
    retryAfter: null,
    at: now()
  });

  return {
    text: data?.choices?.[0]?.message?.content || "",
    metrics: {
      elapsedMs,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      status: response.status
    },
    headers
  };
}

async function executeRun(run) {
  run.status = "running";
  run.startedAt = now();

  const selected = agents.filter(a => run.agentIds.includes(a.id));
  if (!selected.length) throw new Error("Nenhuma IA selecionada.");

  const levels = run.testType === "progressive"
    ? Array.from({ length: Math.max(1, Math.min(10, Number(run.levels || 5))) }, (_, i) => i + 1)
    : [Number(run.level || 1)];

  for (const agent of selected) {
    const agentResult = {
      agentId: agent.id,
      name: agent.name,
      provider: agent.provider,
      model: agent.model,
      calls: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      elapsedMs: 0,
      levels: [],
      outputs: [],
      logs: []
    };

    for (const level of levels) {
      const prompt = buildPrompt(run, agent, level);
      const callId = id("call");
      const log = {
        id: callId,
        at: now(),
        agentId: agent.id,
        level,
        type: run.testType,
        status: "started",
        prompt
      };
      agentResult.logs.push(log);
      if (agentResult.logs.length > MAX_LOGS_PER_RUN) agentResult.logs.shift();

      try {
        const result = await providerCall(agent, prompt, {
          max_tokens: run.maxTokens || (run.testType === "progressive" ? 1000 : 700),
          system: buildSystem(run, agent, level)
        });
        agentResult.calls++;
        agentResult.inputTokens += result.metrics.inputTokens;
        agentResult.outputTokens += result.metrics.outputTokens;
        agentResult.elapsedMs += result.metrics.elapsedMs;

        const levelResult = {
          level,
          success: true,
          output: result.text,
          metrics: result.metrics
        };
        agentResult.levels.push(levelResult);
        agentResult.outputs.push({ level, text: result.text });
        log.status = "success";
        log.metrics = result.metrics;
        log.output = result.text;
      } catch (error) {
        agentResult.calls++;
        agentResult.errors++;
        if (error.metrics) {
          agentResult.inputTokens += error.metrics.inputTokens || 0;
          agentResult.outputTokens += error.metrics.outputTokens || 0;
          agentResult.elapsedMs += error.metrics.elapsedMs || 0;
        }
        agentResult.levels.push({
          level,
          success: false,
          error: error.message,
          status: error.status || 500
        });
        log.status = "error";
        log.error = error.message;
        log.statusCode = error.status || 500;
      }

      await sleep(Math.max(0, Number(run.cooldownMs || 0)));
    }

    agentResult.successRate = agentResult.levels.length
      ? Math.round(agentResult.levels.filter(x => x.success).length / agentResult.levels.length * 100)
      : 0;
    agentResult.score = calculateScore(agentResult);
    run.results.push(agentResult);
  }

  run.finishedAt = now();
  run.status = run.results.every(r => r.errors === 0) ? "completed" : "completed_with_errors";
  run.summary = summarizeRun(run);
  addHistory(structuredClone(run));
  return run;
}

function buildSystem(run, agent, level) {
  return [
    `Você é ${agent.name} da VILTRIX AI LAB.`,
    `Função experimental: ${agent.role}.`,
    `Teste: ${run.testType}.`,
    `Nível: ${level}.`,
    "Não invente resultados externos.",
    "Entregue somente a resposta necessária para avaliação."
  ].join(" ");
}

function buildPrompt(run, agent, level) {
  const task = run.task || "Analise esta tarefa e proponha uma solução.";
  const difficulty = [
    "Tarefa simples e direta.",
    "Inclua duas condições.",
    "Inclua múltiplas etapas.",
    "Inclua contexto conflitante e peça decisão.",
    "Inclua erro proposital e peça recuperação.",
    "Exija comparação de alternativas.",
    "Exija planejamento, execução conceitual e validação.",
    "Exija memória de informações fornecidas anteriormente.",
    "Exija colaboração conceitual com outro agente.",
    "Resolva como uma tarefa de produção com validação final."
  ][Math.max(0, Math.min(9, level - 1))];

  if (run.testType === "memory") {
    return `Memória/puzzle. ${task}\nPeças anteriores: ${JSON.stringify(run.memoryPieces || [])}\n${difficulty}\nIdentifique o que deve ser preservado e produza a próxima peça.`;
  }
  if (run.testType === "cooperation" || run.testType === "arena") {
    return `Cooperação. ${task}\nEquipe: ${run.agentIds.join(", ")}\n${difficulty}\nDefina sua contribuição sem assumir que você controla os outros agentes.`;
  }
  if (run.testType === "recovery") {
    return `Recuperação. ${task}\nErro/contexto inicial: ${run.failureContext || "simule uma falha anterior"}\n${difficulty}\nExplique a correção e entregue uma nova resposta válida.`;
  }
  return `${task}\n${difficulty}\nResponda de modo que a qualidade possa ser comparada objetivamente.`;
}

function calculateScore(r) {
  const success = r.successRate;
  const errorPenalty = Math.min(30, r.errors * 10);
  const latencyPenalty = Math.min(15, Math.round(r.elapsedMs / 5000));
  return Math.max(0, Math.round(success - errorPenalty - latencyPenalty + Math.min(10, r.calls)));
}

function summarizeRun(run) {
  return {
    agents: run.results.length,
    calls: run.results.reduce((s, r) => s + r.calls, 0),
    errors: run.results.reduce((s, r) => s + r.errors, 0),
    inputTokens: run.results.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: run.results.reduce((s, r) => s + r.outputTokens, 0),
    elapsedMs: run.results.reduce((s, r) => s + r.elapsedMs, 0),
    bestAgent: [...run.results].sort((a, b) => b.score - a.score)[0]?.agentId || null
  };
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "VILTRIX AI LAB Backend",
    version: "1.0.0",
    time: now()
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    version: "1.0.0",
    agents: agents.map(publicAgent),
    rateState: Object.fromEntries(rateState),
    historyCount: history.length,
    activeRuns: [...runs.values()].filter(r => r.status === "running").length
  });
});

app.get("/api/agents", (req, res) => res.json({ agents: agents.map(publicAgent) }));
app.get("/api/tests", (req, res) => res.json({ tests }));

app.get("/api/runs", (req, res) => {
  res.json({
    runs: [...runs.values()].sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(r => ({
      id: r.id, testType: r.testType, status: r.status, createdAt: r.createdAt,
      startedAt: r.startedAt, finishedAt: r.finishedAt, agentIds: r.agentIds,
      summary: r.summary || null
    }))
  });
});

app.get("/api/runs/:id", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Run não encontrado." });
  res.json(run);
});

app.post("/api/tests/run", async (req, res) => {
  const body = req.body || {};
  const run = {
    id: id("run"),
    createdAt: now(),
    status: "queued",
    testType: body.testType || "individual",
    task: String(body.task || ""),
    agentIds: Array.isArray(body.agentIds) ? body.agentIds.filter(x => agents.some(a => a.id === x)) : agents.map(a => a.id),
    level: Number(body.level || 1),
    levels: Number(body.levels || 5),
    maxTokens: Number(body.maxTokens || 700),
    cooldownMs: Number(body.cooldownMs || 0),
    memoryPieces: Array.isArray(body.memoryPieces) ? body.memoryPieces.slice(0, 80) : [],
    failureContext: String(body.failureContext || ""),
    metadata: body.metadata || {},
    results: []
  };
  runs.set(run.id, run);

  executeRun(run).catch(error => {
    run.status = "failed";
    run.finishedAt = now();
    run.error = error.message;
    addHistory(structuredClone(run));
  });

  res.status(202).json({
    accepted: true,
    runId: run.id,
    status: run.status
  });
});

app.post("/api/runs/:id/retry", async (req, res) => {
  const previous = runs.get(req.params.id);
  if (!previous) return res.status(404).json({ error: "Run não encontrado." });

  const retry = {
    ...structuredClone(previous),
    id: id("run"),
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
    status: "queued",
    results: [],
    retryOf: previous.id,
    error: null,
    summary: null
  };
  runs.set(retry.id, retry);
  executeRun(retry).catch(error => {
    retry.status = "failed";
    retry.finishedAt = now();
    retry.error = error.message;
    addHistory(structuredClone(retry));
  });

  res.status(202).json({ accepted: true, runId: retry.id });
});

app.delete("/api/runs/:id", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Run não encontrado." });
  run.status = "cancelled";
  run.finishedAt = now();
  res.json({ ok: true, runId: run.id, status: run.status });
});

app.get("/api/runs/:id/export", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Run não encontrado." });
  res.setHeader("Content-Disposition", `attachment; filename="${run.id}.json"`);
  res.json(run);
});

app.get("/api/history", (req, res) => {
  res.json({ history });
});

app.get("/api/diagnostics", (req, res) => {
  res.json({
    time: now(),
    providers: {
      groq: agents.filter(a => a.provider === "groq").map(publicAgent),
      mistral: agents.filter(a => a.provider === "mistral").map(publicAgent)
    },
    rateState: Object.fromEntries(rateState),
    limits: {
      groq: { strategy: "headers + 429 cooldown" },
      mistral: { strategy: "headers + 429 cooldown" }
    }
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Erro interno do servidor." });
});

app.listen(PORT, () => {
  console.log(`VILTRIX AI LAB Backend V1.0.0 running on port ${PORT}`);
});

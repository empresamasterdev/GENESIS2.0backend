# VILTRIX AI LAB Backend V1.0.0

Backend da extensão VILTRIX AI LAB.

## Arquitetura

6 IAs independentes:

- IA1 — Groq / GPT-OSS 120B
- IA2 — Groq / GPT-OSS 120B
- IA3 — Groq / GPT-OSS 120B
- IA4 — Groq / GPT-OSS 120B
- IA5 — Mistral / mistral-small-2603
- IA6 — Mistral / mistral-small-2603

As chaves ficam no backend através das Environment Variables do Render. Nunca coloque chaves no código ou no frontend.

## Funções

- health/status
- cadastro e configuração das 6 IAs
- teste individual
- teste comparativo
- teste de dificuldade progressiva
- recuperação
- memória/puzzle
- cooperação
- arena
- métricas de chamadas, tokens, latência e erros
- eventos de rate limit
- histórico em memória da instância
- exportação JSON
- CORS para a extensão Chrome

## Deploy no Render

1. Crie um Web Service apontando para este repositório.
2. Build: `npm install`
3. Start: `npm start`
4. Health: `/health`
5. Cadastre as 6 API keys como Environment Variables no Render.
6. Não coloque nenhuma API key no GitHub.

## Endpoints principais

GET `/health`
GET `/api/status`
GET `/api/agents`
GET `/api/tests`
GET `/api/runs`
GET `/api/runs/:id`
POST `/api/tests/run`
POST `/api/runs/:id/retry`
DELETE `/api/runs/:id`
GET `/api/runs/:id/export`

O backend foi preparado para ser consumido pela extensão VILTRIX AI LAB.

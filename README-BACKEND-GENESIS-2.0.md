# GÊNESIS Backend 2.0

Substitua `src/server.mjs` pelo arquivo `server.mjs` deste pacote.

A conexão OAuth/GitHub e as rotas existentes são preservadas.

Novo pipeline:
1. leitura do repositório
2. IA 1 — análise
3. IA 1 — plano fechado
4. IA 2 — execução somente
5. verificação real no GitHub
6. IA 1 — auditoria

As alterações de uma tarefa são consolidadas em um único commit Git.

Os modelos continuam sendo lidos das variáveis:
GENESIS_AI_1_API_KEY / MODEL / PROVIDER
GENESIS_AI_2_API_KEY / MODEL / PROVIDER

Não altere o callback do GitHub nem o ID da extensão.

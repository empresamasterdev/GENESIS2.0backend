# GÊNESIS 2.0 — Backend completo

Este pacote substitui o backend anterior como conjunto completo.

Arquitetura:

IA 1 → leitura/análise → plano fechado
IA 2 → execução exclusiva
IA 1 → auditoria final

O backend consulta o estado real do GitHub antes e depois da execução.

As alterações de uma tarefa são consolidadas em um único commit Git.

## OAuth

Mantenha no GitHub OAuth App:

`https://genesis2-0.onrender.com/auth/github/callback`

No Render, configure `GENESIS_EXTENSION_REDIRECT_URI` com o ID REAL da extensão instalada:

`https://SEU_ID.chromiumapp.org/github`

Não copie um ID de exemplo.

## Importante

Credenciais reais, tokens e `GENESIS_SESSION_SECRET` devem existir somente nas Environment Variables do Render.

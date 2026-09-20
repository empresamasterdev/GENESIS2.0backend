# GÊNESIS 2.0 — Backend

Backend da extensão GÊNESIS 2.0.

## Pipeline

A arquitetura desta versão é deliberadamente não intercalada:

1. **IA 1 — Orquestradora**
   - lê o estado real do repositório;
   - analisa a arquitetura;
   - identifica o que já existe;
   - decide o que deve ser reutilizado/modificado/criado;
   - cria o plano fechado.

2. **IA 2 — Executora**
   - recebe o plano da IA 1;
   - recebe o conteúdo real dos arquivos envolvidos;
   - executa somente as operações aprovadas;
   - não cria plano próprio;
   - não amplia o escopo.

3. **IA 1 — Auditora**
   - recebe o estado real após a execução;
   - compara o resultado com o pedido e o plano;
   - gera auditoria técnica e resumo em linguagem natural.

## Git

Todas as alterações aprovadas de uma tarefa são aplicadas em uma única operação de árvore/commit no GitHub, evitando um commit individual por arquivo.

## OAuth

O callback do GitHub permanece:

`https://SEU-SERVICO.onrender.com/auth/github/callback`

A extensão utiliza `GENESIS_EXTENSION_REDIRECT_URI` para retornar ao `chromiumapp.org`.

## Variáveis

Consulte `.env.exemplo`. Nunca publique segredos reais no repositório.

## Health check

`GET /api/health`

Retorna a versão do backend e confirma que o processo está ativo.

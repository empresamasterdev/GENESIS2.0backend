# GÊNESIS 2.0 — backend OAuth patch

Substitua `src/server.mjs` pelo arquivo deste pacote.

Adicione no Render:

GENESIS_EXTENSION_REDIRECT_URI=https://gipfdbmobkgn...chromiumapp.org/github

Use o ID real da extensão instalada. Para a extensão atual mostrada no navegador, o padrão é:
`https://akealbnpdlpcdodpmaokfnobolclbfjk.chromiumapp.org/github`

IMPORTANTE: confirme o ID exibido em chrome://extensions. O valor exato deve ser usado.

O GitHub App continua usando:
`https://genesis2-0.onrender.com/auth/github/callback`

O fluxo passa a ser:
GitHub -> Render callback -> código de uso único -> chromiumapp.org -> extensão -> /auth/github/exchange -> token de sessão.

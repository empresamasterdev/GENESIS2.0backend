# EXTENSÃO-GENESIS2.0 — Backend

Render-ready backend for the GÊNESIS browser extension.

Flow: GitHub OAuth → repository context → Key 1 analysis → Key 2 plan → Key 1 execution → GitHub changes → Key 2 audit/report.

Render:
- Build: `npm install`
- Start: `npm start`
- Health: `/api/health`

After Render creates the service URL, set `GITHUB_REDIRECT_URI` to:
`https://YOUR-SERVICE.onrender.com/auth/github/callback`
and use the exact same URL in the GitHub App.

Never commit secrets.

# RAFFLEYE development

- The production bot is being migrated to strict TypeScript on Node.js; keep the Python implementation as a rollback/reference until cutover is verified. Keep offline demo/test paths credential-free.
- Never read or print real secrets from `.env`; use `.env.example` for configuration guidance.
- Do not add browser scraping, login/cookie extraction, actor execution, or automated giveaway participation.
- The user authorized post-only screenshots: render official public X embeds for images, without account cookies or browser-based discovery.
- Official X is the live primary source; Apify is an opt-in authorized-dataset adapter.
- Preserve evidence and unknowns. Do not guess dates, sponsor affiliations, or winner counts.
- Persist raw pages before advancing cursors. Reserve budget before each billable attempt.
- Run `ruff check src tests`, `ruff format --check src tests`, and `pytest -q` after implementation changes.
- Also run `npm run check`, `npm test`, and `npm run build` for TypeScript changes. Never run both implementations against the live database.
- Run one writer/scheduler per SQLite database. Do not reset live storage to fix a test.

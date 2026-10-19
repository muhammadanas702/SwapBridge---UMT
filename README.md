# SectionSwap
Standalone section-exchange app. Node 22+, zero npm deps (built-in `node:sqlite`), vanilla-JS PWA frontend, versioned REST API.

## Run
    npm start        # http://localhost:3000 (creates + migrates sectionswap.db, seeds fictional demo data)
    npm test         # 5 test groups: engine, API flow, catalog/timetable/admin, avatar/terms/openapi

Env: `PORT` (3000), `DB` (file path), `MAIL_WEBHOOK` (optional URL that receives POST {to,subject,text}).
Without MAIL_WEBHOOK, emails (verification, reset, notifications) are only logged to the console and verification is not required.

Demo accounts (fictional, password `demo1234`): admin@demo.test, ayesha@demo.test, bilal@demo.test, sara@demo.test.

## Layout
`matching.js` pure matching engine · `server.js` auth, requests, matches/consent, timetable, catalog, notifications, admin, OpenAPI · `public/` UI + manifest + service worker.

## API
OpenAPI 3: `GET /api/v1/openapi.json` (route list: `/api/v1/docs`). Session cookie auth; ownership + admin checks are server-side.
Future integration: call the same API from another platform; add token auth in front of `c.user` lookup in `server.js`.

## Notes
Timetable slots are self-entered (unverified). Outcomes are self-reported; nothing is claimed as official university approval.

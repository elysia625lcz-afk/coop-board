# coop-board

Co-op job board web page. Code only — all data lives in Supabase behind login or a per-AI key.

- Page: `index.html` + `backend.js` (open `?debug=1` for a live debug log; `window.coop` in the console).
- AI access without a password: `python3 coopdb.py -h` (key in `~/.config/coop-board/key` or `COOP_KEY`).
- Database schema: `coop_001_docs.sql`.

# Synthetic workstation browser regression

This suite intercepts `data.js` and blocks every non-local request. It does not authenticate against Supabase, load private snapshots or write production data. Fixtures contain two generic synthetic workspaces. The real `getHandoff()` implementation is read from the local `data.js` and exercised against those fixtures.

Run with Python Playwright and its Chromium browser installed:

```sh
python3 /Users/yiannispoulos/.codex/plugins/cache/anthropic-agent-skills/example-skills/local/skills/webapp-testing/scripts/with_server.py \
  --server 'python3 -m http.server 5174 --bind 127.0.0.1 --directory /Users/yiannispoulos/poulos-os' \
  --port 5174 -- python3 /Users/yiannispoulos/poulos-os/tests/regression.py
```

The JSON report is written to `tests/results.json`. Browser failures exit nonzero.

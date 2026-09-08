# Workstation chat sending

The authenticated owner writes a plain text message and presses Send in Conversations. An RPC snapshots the exact chat/account/text under an immutable client request UUID. A scoped Mac worker claims requests atomically and sends through the local Beeper Desktop API. No AI model or scheduled AI task participates.

The Mac must be awake, signed in and running Beeper. Browser status updates every five seconds; the worker checks its private outbox every two seconds. Inbound ingestion remains the existing 30-minute schedule, separately from outbound sending.

Setup on a new Mac:

1. Enable Beeper Desktop API, run `node tools/beeper-auth.mjs`, open the displayed authorization link and approve the requested access.
2. Run `node tools/beeper-sender.mjs --initialize`. Provision the printed SHA256 hash in the private `bridge_credentials` table, bound to an existing workspace bridge. Never store the credential itself in the database or repository.
3. Run `node tools/beeper-sender.mjs --check`, then `node tools/install-beeper-sender.mjs`.

Credentials and sanitized operational logs are local under `~/.local/share/poulos-workstation`, outside Drive and Git. OAuth approval and the scoped credential are separate from Codex's own connector authorization.

`launchctl bootout gui/$(id -u)/gr.poulos.workstation-sender` stops the service. Re-run the installer to restart. Revoke the scoped credential in the database and the app's authorization in Beeper to disconnect permanently.

The browser cannot write outbox rows directly or impersonate a worker. Members may read their workspace; only its owner can queue. A worker credential can only claim/finish that workspace's already authorized messages. Terminal requests are never replayed. An ambiguous timeout is shown as requiring review in Beeper. Queued requests expire after two minutes. Accepted requests display as waiting until the provider reports SUCCESS; this is not a read receipt.

Verification: `node tests/beeper-sender.mjs`, `node tests/outbox-ui.cjs`, existing communication tests, and rollback-only `tests/outbox-transaction.sql` with an idle outbox. These tests do not send messages to real contacts. The latter uses an isolated transaction, a temporary test credential, and always rolls back.

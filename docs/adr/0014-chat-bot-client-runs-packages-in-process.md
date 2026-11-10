# ADR 0014 — The chat bot runs the packages in-process, not as a client of the API

**Status:** Proposed · **Date:** 2026-11-10

## Context

The owner wants people to be able to learn on the go, in a chat app, with the same game, the same
bots and the same Coach as the web app: a hand is played with messages and buttons. Telegram is
first, and other chat platforms may follow. `apps/bot` is that client. Its core is a function from
one reader event to the next session and the messages to send, with a Telegram adapter and a
terminal adapter over it.

The obvious design is a thin client of the API: open a room with five bots over REST, play over
the WebSocket, and render the frames as messages. The API is built so that design does not work,
and each reason is deliberate.

* **The WebSocket refuses non-browser clients.** `apps/api/src/ws/hub.ts` refuses an upgrade with
  no `Origin` and says why (lines 20-22): "an upgrade without it is a non-browser client, and this
  API is only served to its own web app. Fail closed: a native client would need a deliberately
  reviewed authentication path of its own, not a hole in this one." A bot process would have to
  forge a browser `Origin`, which is exactly the hole that sentence rules out.
* **Every reader would arrive from one address.** Guest creation is limited per client address,
  10 per 60 s (`apps/api/src/routes/auth.ts`, the note at line 155 on why that stays fixed). Every
  chat user's session would be minted from the bot's own address, so the eleventh new reader in a
  minute would be refused, and the limit is not one to loosen for a single caller.
* **One API process serves all rooms.** `replicas: 1` is a correctness requirement (ADR 0013). A
  chat audience routed through it adds seated tables to the one process whose capacity is already
  the constraint, for a client that does not need anything the server holds: a chat table is one
  reader against five bots, with no second person and nothing to persist.

## Decision

**The bot imports `@prl/poker-engine`, `@prl/poker-ai`, `@prl/poker-math` and `@prl/contracts` and
deals, plays and coaches in its own process.** It does not call the API and does not depend on
`apps/api`. Where logic lived only in an app, the minimum is duplicated with a comment naming the
original:

* the Coach input built from a redacted view (`readCoachSituation` and `coachForView`,
  `apps/api/src/ws/router.ts`) and the `top:NN` range expansion (`assumedRange`,
  `apps/api/src/rooms/bots.ts`), with the web's live values: seed 1, 2,000 samples, `top:40`;
* the bot lineup and table settings (`BOT_TABLE_REQUEST`, `apps/web/src/lib/table-rooms.ts`) and
  the bots' `realistic` difficulty;
* the probability range check (`formatProbability`, `packages/ui/src/probability.ts`), because
  `@prl/ui` is React source.

The rest is the packages' own: cards from `createSecureRandom()`, legality from the engine, each
bot given only its own redacted view and its own two cards, as `simulate.ts` and `BotRunner` do.

## Options considered

**A. A client of the API over REST and the WebSocket.** Rejected for the three reasons above. Each
would need a change to the API that weakens a control written to stay strong.

**B. A reviewed bot-to-API path: a service credential, a per-reader identity, room creation on the
reader's behalf.** Not rejected, deferred. It is the right design once a chat reader needs anything
the server holds, such as progress, hand history or review. It is its own threat-model item, and a
first playable slice should not have to carry it.

**C. In-process, on the packages (chosen).** The packages are pure and were built to be called
like this: `simulate.ts` drives the same engine and the same policies with no server at all.

## Consequences

* **A second place hands are dealt.** The engine is still the only authority on legality and on
  who won, but a hand dealt here is not in the database, appears in no hand history, and is not
  covered by the room-ownership lease. Nothing here can carry units between the two clients, and
  nothing should.
* **No deck commitment is shown to the reader yet.** The engine commits to every deck (ADR 0004),
  and the commitment exists in the `HandState`, but the chat client does not publish the root
  before the first action or the proofs afterwards. Until it does, a chat reader has no way to
  check a deal, which the web reader has.
* **State lives in memory.** Sessions are a `Map` per chat id. A restart ends every table and
  hand, and `/about` tells the reader so. A button from before a restart can never act on the new
  table: every hand id carries a random per-table tag.
* **The Coach runs on the bot's own thread.** The API moved it to a worker pool after measuring a
  3,034 ms first analysis and 56-84 ms warm. Here the preflop strength table is built at start-up
  (about 3 s). Measured over 320 readings on this branch: 28 ms median, but 1.2 to 1.5 s against
  three or more opponents, and the poll loop handles one update at a time, so every chat waits
  behind such a reading. A worker, or a per-chat queue, is the fix when the audience needs it.
* **The duplicated pieces can drift from the web's.** The Coach input assembly is the one that
  matters, because a learner could see two figures for one spot. It is a candidate to move into
  `@prl/poker-math` as a function of a `PlayerView`, so both apps call one definition.

What this does **not** change:

* **No chat between people (ADR 0010).** The bot answers one reader in a private chat and drops
  every update from a group, supergroup or channel. No reader's text reaches anybody else. There
  is no shared table.
* **No LLM (ADR 0012).** Every message is a template filled with the engine's and the Coach's
  numbers. The bots decide with `decide()` from `@prl/poker-ai`.
* **The guardrails.** Units are free and worthless, and reset is always available (§1). The bot
  never messages first and sends no reminder (§8). The Coach's suggestion always travels with its
  confidence, its disclaimer and its assumptions (§3). Opponents are shown by archetype name only
  (ADR 0011). Attributed names stay off in this client whatever `PRL_LEGEND_NAMING` says, because a
  chat message is forwarded without the page around it.

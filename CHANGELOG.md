# Changelog

## [3.3.0](https://github.com/mohitmayank/shared-brainstorm/compare/v3.2.0...v3.3.0) (2026-05-28)

### Features

* **stream:** planning-stream MCP tool with coordinator-gated audience + pending-join dialog ([f1a6668](https://github.com/mohitmayank/shared-brainstorm/commit/f1a6668e1a58bc9d2bbce8425182f81ad997d13a))

## [3.2.0](https://github.com/mohitmayank/shared-brainstorm/compare/v3.1.1...v3.2.0) (2026-05-26)

### Features

* **launch:** auto-open coordinator URL + planner-link dialog, drop clipboard ([075bab9](https://github.com/mohitmayank/shared-brainstorm/commit/075bab9ee0b1bf09a2544928bb992eca725cba57))
* **welcome:** seed active advisories for cold-open coordinators ([80f2efc](https://github.com/mohitmayank/shared-brainstorm/commit/80f2efcf45deda289e2e3cb7da06344f510fe635))

## [3.1.1](https://github.com/mohitmayank/shared-brainstorm/compare/v3.1.0...v3.1.1) (2026-05-26)

All notable changes to this project are documented here. This file is generated
from [Conventional Commits](https://www.conventionalcommits.org/) by `release-it`
using the `conventionalcommits` preset; do not edit released sections by hand.

## [3.1.0](https://github.com/mohitmayank/shared-brainstorm/compare/v3.0.2...v3.1.0) (2026-05-26)

### Features

* v3.1 reliability & resilience hardening ([6b200d3](https://github.com/mohitmayank/shared-brainstorm/commit/6b200d353eef5baa20e15998df4de578852e1328))

## [3.0.2](https://github.com/mohitmayank/shared-brainstorm/compare/v3.0.1...v3.0.2) (2026-05-23)

### Bug Fixes

* **server:** move bundled @shared-brainstorm/shared to devDependencies ([8948da0](https://github.com/mohitmayank/shared-brainstorm/commit/8948da0ccb7ddb47b141365bb3d455966d46f2a7))

## [3.0.1](https://github.com/mohitmayank/shared-brainstorm/compare/v3.0.0...v3.0.1) (2026-05-23)

### Features

* **install:** advise on cloudflared availability after install ([155c9ef](https://github.com/mohitmayank/shared-brainstorm/commit/155c9ef00a508d711e7f28991ff9ce6f28a0ae6f))

## [3.0.0](https://github.com/mohitmayank/shared-brainstorm/compare/v1.1.0...v3.0.0) (2026-05-22)

### Features

* **01-01:** extract isTruthyEnv into shared util/env.ts ([f0d5c05](https://github.com/mohitmayank/shared-brainstorm/commit/f0d5c055fea659a25bb6b2894a876a7b31ba01c5))
* **01-01:** fix cli.ts --version to read package.json via createRequire ([4cad90e](https://github.com/mohitmayank/shared-brainstorm/commit/4cad90e0a239393d32e584fa6b65b2e754aa7276))
* **01-03:** add ## Redaction section to all 4 skill files + skill-mirror.test.ts enforcement ([0c0f126](https://github.com/mohitmayank/shared-brainstorm/commit/0c0f1265d17b4068531e0ea4591b183d9e45e80e)), closes [#12](https://github.com/mohitmayank/shared-brainstorm/issues/12)
* **01-03:** add Redaction DISABLED stderr banner in cli.ts case 'mcp' + banner tests ([e7cf5a5](https://github.com/mohitmayank/shared-brainstorm/commit/e7cf5a5199f994e09219d4c11e68d99c210ed2ad))
* **01-03:** add SHARED_BRAINSTORM_NO_REDACT opt-out branch in redact.ts ([fd99c3b](https://github.com/mohitmayank/shared-brainstorm/commit/fd99c3b4fa99f4837673eac7a631c04132c4448e))
* **01-03:** extract TOOLS array from mcp/server.ts + append best-effort warning to askGroup description ([36ff784](https://github.com/mohitmayank/shared-brainstorm/commit/36ff784678bdf466d63fb1c9fc23df996f00dc87))
* **01-04:** add Playwright config, fixtures, README; test:e2e script; gitignore ([a313287](https://github.com/mohitmayank/shared-brainstorm/commit/a31328771a50f2852c0b0753509c727320273bfc))
* **01-04:** bring e2e/ under npm run typecheck via e2e/tsconfig.json ([6180d5b](https://github.com/mohitmayank/shared-brainstorm/commit/6180d5ba6b69526e2d8434ddfaaa4fe2805ccff3)), closes [#13](https://github.com/mohitmayank/shared-brainstorm/issues/13)
* **01-05:** implement golden-path E2E spec (REL-01 scenario 1) ([4ab3b10](https://github.com/mohitmayank/shared-brainstorm/commit/4ab3b109615c6ffe1a864c7569d996d163697f4e))
* **01-05:** implement multi-participant E2E spec (REL-01 scenario 2) ([9de8389](https://github.com/mohitmayank/shared-brainstorm/commit/9de8389a7372c8bf8c9710054398ccc9576c2363))
* **01-05:** implement WS reconnect E2E spec (REL-01 scenario 3) ([bed98be](https://github.com/mohitmayank/shared-brainstorm/commit/bed98beef62bb0cb85c216db0ea6c0d2c49782d0))
* **01-06:** add e2e/session-stop.spec.ts — REL-01 scenario 4 ([bf2da99](https://github.com/mohitmayank/shared-brainstorm/commit/bf2da99b1e8ff8ae95f1bb9e57bd79dd64ea1c85)), closes [#15](https://github.com/mohitmayank/shared-brainstorm/issues/15)
* **01-06:** add e2e/signal-handling.spec.ts — REL-01 scenario 5 ([05660c5](https://github.com/mohitmayank/shared-brainstorm/commit/05660c5d0ac3266fa8f4296a92b3fd2ae7fd5433))
* **02-01:** rate-limit middleware factory + env parser + tests ([3d7bf61](https://github.com/mohitmayank/shared-brainstorm/commit/3d7bf618e89fa9bb597e484ecdceb9b8f7a260dc))
* **02-02:** nextBackoffMs pure function for WS reconnect backoff ([02a6336](https://github.com/mohitmayank/shared-brainstorm/commit/02a6336d0282e6f01d96cab03f271eafd7a182bf))
* **02-03:** session caps + 409 mapping + rate-limit route wiring ([94ff841](https://github.com/mohitmayank/shared-brainstorm/commit/94ff8417d81af8c92aa976c430bcad62787c26e6))
* **02-04:** Transport interface widening (bind, secureCookie, onError) + cookies + BIND override ([5bbcbe7](https://github.com/mohitmayank/shared-brainstorm/commit/5bbcbe778b77f511fefa4c30d2ae1a82a2cea164))
* **02-05:** cloudflared 3-restart counter + 5s/15s diagnostics + version detect ([c3b93a7](https://github.com/mohitmayank/shared-brainstorm/commit/c3b93a789d33b51faa7d8da7471676088d752762))
* **02-06:** transport_failed schema + mcpState gate + askGroup error path + web reducer ([a0955dd](https://github.com/mohitmayank/shared-brainstorm/commit/a0955ddb1c741eae9075c7701ed72edd4fb78c46))
* **02-07:** web reconnect backoff + TunnelBanner + Playwright specs ([10a9865](https://github.com/mohitmayank/shared-brainstorm/commit/10a98659b5d4aa61e33692bd1cdffee6b5fe8017))
* **02-08:** README + skill-bundle env-var docs + --help pointer ([278b3cf](https://github.com/mohitmayank/shared-brainstorm/commit/278b3cf0d39ec022af7622d9ebc684dfe54860d3))
* **03-01:** compose coordinator_url in startSession; invert negative assertions ([77a213c](https://github.com/mohitmayank/shared-brainstorm/commit/77a213c8c62bf5af028ad3feaeff22d722d8919c))
* **03-01:** mint coordinator token + add coordinator_url to StartSessionOutput ([f7472d7](https://github.com/mohitmayank/shared-brainstorm/commit/f7472d76ada7171eeb6c5a0f3bea71ebe0f28d9e))
* **03-01:** store coordinator_token on ActiveSession + coordinatorToken() getter ([73bd385](https://github.com/mohitmayank/shared-brainstorm/commit/73bd38520a828010ab561227c03641f4fc6c80e7))
* **03-02:** add sb_c coordinator cookie helpers + REL-09 regression tests ([8bfd9c1](https://github.com/mohitmayank/shared-brainstorm/commit/8bfd9c110bc62281e45409bd0d68f277cf897fd9))
* **03-02:** coordinator join endpoint + requireCoordinator middleware ([3bd1b45](https://github.com/mohitmayank/shared-brainstorm/commit/3bd1b4525a18aea2a27106a080fbfc8910268be2))
* **03-03:** reducer UiState.isCoordinator from welcome flag ([963150d](https://github.com/mohitmayank/shared-brainstorm/commit/963150d30c885ec47ebfbf0c724d418d8bf3a488)), closes [#6](https://github.com/mohitmayank/shared-brainstorm/issues/6)
* **03-03:** welcome schema — optional you + required is_coordinator ([dd3e8ef](https://github.com/mohitmayank/shared-brainstorm/commit/dd3e8efa04e53b6145a3bea3d5f159773ac0cd80))
* **03-03:** WS coordinator branch + server-derived is_coordinator at upgrade ([7d26693](https://github.com/mohitmayank/shared-brainstorm/commit/7d26693888eebbce045a9de219d5cc1e66edeeed)), closes [#6](https://github.com/mohitmayank/shared-brainstorm/issues/6)
* **03-04:** mount POST /api/coordinator/answer on requireCoordinator ([5090c68](https://github.com/mohitmayank/shared-brainstorm/commit/5090c684d8f98470e26a77a7ada418243e455f62))
* **03-05:** coordinator page shell + DecisionsPanel + SuggestionRow + CommentRow ([58b4b3c](https://github.com/mohitmayank/shared-brainstorm/commit/58b4b3c1dacf8add4872c9f79b7c3df539c24665))
* **03-05:** coordinator REST helpers + App URL role detection & routing ([ca4676e](https://github.com/mohitmayank/shared-brainstorm/commit/ca4676e4c3dec9a379155f7f951fcba2d100c0e2))
* **03-05:** CoordinatorQuestionCard (radiogroup + Record affordances + resolved variant) + styles ([b62eacb](https://github.com/mohitmayank/shared-brainstorm/commit/b62eacb150bcd0c30a63ba0f15a41be2a9ddb5c5))
* **04-03:** coordinator kick/lock UI, kicked roster group, CSS + e2e kick/lock tests ([a4628f5](https://github.com/mohitmayank/shared-brainstorm/commit/a4628f51d9c8c9b42a44690e2a01bfbd73ecf162))
* **04:** approval flow UI — pending screen, auto-submit, Coordinator roster, JOIN-06 ([02ec8a5](https://github.com/mohitmayank/shared-brainstorm/commit/02ec8a594157db6142c2c1e54904d80baf544704))
* **04:** production code sweep — remove join_code, add pending status + locked ([69d7b47](https://github.com/mohitmayank/shared-brainstorm/commit/69d7b47fe0bb9d194800ff91b59f557ed30b5892))
* **04:** shared contract — Participant.status, new WS events, remove join_code ([2b85d84](https://github.com/mohitmayank/shared-brainstorm/commit/2b85d84371dfd0b57004df5b9d1f6f57f28f81b7))
* **05-02:** sessionStatus + presence fields + PresenceExpireAction in reducer ([cd5c8e1](https://github.com/mohitmayank/shared-brainstorm/commit/cd5c8e17be8cfb795d4525852eed5c94580d808f))
* **05-02:** SessionStatusPill + Session/Coordinator wiring + styles + e2e presence spec ([92dabc0](https://github.com/mohitmayank/shared-brainstorm/commit/92dabc007f6dd7a02e3801a2fe9c1f84a55e5f27))
* **05-03:** add presence EphemeralFrame + typing/picking ClientCommands + ws.ts handlers ([01d0d5e](https://github.com/mohitmayank/shared-brainstorm/commit/01d0d5e374f9370ebdac650d6f13c4a0f0caf262))
* **05-03:** presence reducer branch + QuestionCard debounce + Session activity lines + e2e test ([766c8f9](https://github.com/mohitmayank/shared-brainstorm/commit/766c8f905a14534f59ebcb7fcb884f426cf38d25))
* **05:** add session_status state machine + broadcastEphemeral to SessionManager ([4f3b92d](https://github.com/mohitmayank/shared-brainstorm/commit/4f3b92dd64adcaddc9c72232dc7fb03bd7a0b12c))
* **05:** add SessionStatus type + session_status_changed event + SessionViewSchema update ([be9f2a7](https://github.com/mohitmayank/shared-brainstorm/commit/be9f2a7cc8bb563ebbe4db2c93a480503f353823))
* **06-01:** MCP union schema + N-concurrent question wiring (BATCH-01) ([37d878b](https://github.com/mohitmayank/shared-brainstorm/commit/37d878be9d1327c2f336c2465ffe5575dff26639))
* **06-02:** Session.tsx + Coordinator.tsx .map() over questions[] + e2e batch spec ([85b26de](https://github.com/mohitmayank/shared-brainstorm/commit/85b26de296a98f307fa5ce74a984a71f37315750))
* **06-02:** withOpenQuestion + question_broadcast/resolved/cancelled accumulate in questions[] ([fe933ed](https://github.com/mohitmayank/shared-brainstorm/commit/fe933ed73863f9c236cd5506e7b4023706db5659))
* **06-03:** per-question progress indicators (BATCH-03) ([0dba305](https://github.com/mohitmayank/shared-brainstorm/commit/0dba305021d2d6fa7ea6b5599f429837c0a8f367))
* **06:** server model — open_questions Map + TicketStore gate lift + SessionView questions[] ([0cf3440](https://github.com/mohitmayank/shared-brainstorm/commit/0cf3440fdc77669c85e01391223e5f57131d05a7))
* **07-02:** CHAT-01 SessionManager.postChat + ws.ts post_chat handler ([466c4c2](https://github.com/mohitmayank/shared-brainstorm/commit/466c4c2e36cfc92926a51c851dd1d3fff3b49c0c))
* **07-02:** CHAT-01 web chat_added reducer + ChatPanel component + wiring ([0be0147](https://github.com/mohitmayank/shared-brainstorm/commit/0be014730979f90ebdb54e8436bd2f32df25e04e))
* **07:** add clarification round-trip (CHATAI-01) — shared types, SessionManager, MCP tool, ws handler ([31b3611](https://github.com/mohitmayank/shared-brainstorm/commit/31b3611539a2e2b2272131d7d51021db16920026))
* **07:** CHATAI-01/02 clarification round-trip — web UI, state, skill docs ([2c57e34](https://github.com/mohitmayank/shared-brainstorm/commit/2c57e34f165d7a587d12a4e51770cff9e5be42ab))
* **08-02:** DISC-01 add DRY what-to-do-next line to all 4 install paths ([25d5c02](https://github.com/mohitmayank/shared-brainstorm/commit/25d5c02bf638fbdca4c8fed7bc130730c022a60e))
* **08-02:** DISC-01 insert tagline and reassurance copy into Join.tsx ([43a334f](https://github.com/mohitmayank/shared-brainstorm/commit/43a334fead67c60b9025ab586b30c9eead961a89))
* **08-02:** DISC-01 rewrite README hero and feature list for v2.0.0 ([ca44548](https://github.com/mohitmayank/shared-brainstorm/commit/ca44548b5ca89de056d1f42360a6269aa4d4b71c))
* **08-03:** DISC-02 demo/index.html — self-contained 7-scene animated walkthrough ([3ab408e](https://github.com/mohitmayank/shared-brainstorm/commit/3ab408e4cb878ddddffb1f6264473b944a22791f))
* **260522-pah:** coordinator add-answer UI, attribution, and answered-count fix ([fdeed3f](https://github.com/mohitmayank/shared-brainstorm/commit/fdeed3f61761439a8bc4d0144e121aaa758b2d41))
* **260522-pah:** coordinator-authored suggestions — schema, server method, HTTP route ([4e88ec7](https://github.com/mohitmayank/shared-brainstorm/commit/4e88ec7780240f72a7c573546bed3ace89e504e4))
* **260522-r5c:** coordinator selects options (radio group) instead of typing ([f96e14b](https://github.com/mohitmayank/shared-brainstorm/commit/f96e14bd60196004c3dcc287ee4449bce2a9a567))

### Bug Fixes

* **01-02:** fix claude-code installer path and add verify branch ([a6f5b4c](https://github.com/mohitmayank/shared-brainstorm/commit/a6f5b4c593af160a3c901cc994a9e6445c7e85ee))
* **03-01:** update mcp-schemas test for required coordinator_url field ([03bdd85](https://github.com/mohitmayank/shared-brainstorm/commit/03bdd858aea77223b9c4cacc52cb6bc9c9c87841))
* **03:** CR-01 hash coordinator token before timingSafeEqual to remove length oracle ([0653eee](https://github.com/mohitmayank/shared-brainstorm/commit/0653eee7c0478c56035d79e4f20dcbbce7c73c31))
* **03:** WR-01 keep welcome seq watermark monotonic ([3b2bfc5](https://github.com/mohitmayank/shared-brainstorm/commit/3b2bfc586f95f53e833e10b55b0e03cbf7f8a214))
* **03:** WR-01 return 404 session_ended from requireCoordinator to match sibling endpoints ([c633bfe](https://github.com/mohitmayank/shared-brainstorm/commit/c633bfe19eebceadbc97a351d6de71e8bfb7b2ce))
* **03:** WR-02/WR-03 track record fallback timers per-ticket ([9851071](https://github.com/mohitmayank/shared-brainstorm/commit/98510713b93285e5eab983f344505c01d9bfaa14))
* **03:** WR-02+WR-05 crypto-random coordinator sub id + heartbeat session-revocation guard ([f583cb6](https://github.com/mohitmayank/shared-brainstorm/commit/f583cb69dc06c68722192efc51c243a945ad8b32))
* **03:** WR-03 keep recording=true after successful answer POST until question_resolved ([b3548d6](https://github.com/mohitmayank/shared-brainstorm/commit/b3548d6ff5ede2c8ecb4d394b890ba555c662154))
* **03:** WR-04 seed WS replay from ?last_seq= query param at onOpen ([bc0c0b3](https://github.com/mohitmayank/shared-brainstorm/commit/bc0c0b3ffaaf62eddec024ce587300ee9b7f7c36))
* **03:** WR-06 add bounded fallback re-enable for stuck record button ([fd9dbbc](https://github.com/mohitmayank/shared-brainstorm/commit/fd9dbbc83af9f23196b53820ac6fce4098fd08f1))
* **03:** WR-07 add monotonic seq guard to reducer for idempotent replay ([3b5f250](https://github.com/mohitmayank/shared-brainstorm/commit/3b5f250d5923d1ad10de45107452c44f674715e5))
* **04:** CR-01 branch WS close on reason — no kick/lock evasion on reload ([9f95a36](https://github.com/mohitmayank/shared-brainstorm/commit/9f95a36b12ce2f0edc6511419a78fc2c2ae9f923))
* **04:** CR-01/WR-02 resume before auto-join, reset seq on fresh join ([514a34b](https://github.com/mohitmayank/shared-brainstorm/commit/514a34b241e80e1470520b23546df56825a2a917))
* **04:** WR-01 add roomLocked-from-welcome regression tests in state.test.ts ([0eb81bd](https://github.com/mohitmayank/shared-brainstorm/commit/0eb81bdf1bd1f54d8efcca6dbae86e717a0a8959))
* **04:** WR-01 project welcome.session.locked into roomLocked on reconnect ([f0544a9](https://github.com/mohitmayank/shared-brainstorm/commit/f0544a908034c0dad198518632c6b4da3edf602d))
* **04:** WR-03 filter approved-only participants in participant Session view ([be03ef6](https://github.com/mohitmayank/shared-brainstorm/commit/be03ef6a8b1b80a03c5fa3d715ae94270f77561e))
* **05:** PRES-03 signal 'choosing' on suggestion select, not only at record ([37caa2d](https://github.com/mohitmayank/shared-brainstorm/commit/37caa2d6bd69c54ddc1a9965be6a38f9d0b3b3a4))
* **05:** WR-01 fix stale closure guard and picking presence leak ([116a744](https://github.com/mohitmayank/shared-brainstorm/commit/116a7440af679133efbe64257efa6f4761cad43b))
* **05:** WR-01 idle presence frame must not clobber a submitted entry ([b0e5881](https://github.com/mohitmayank/shared-brainstorm/commit/b0e588148f20ad4a5f45d55ae7066b4d4ff96174))
* **05:** WR-01 test needs session base state for suggestion_added path ([91900e6](https://github.com/mohitmayank/shared-brainstorm/commit/91900e6bcbef701840fa082b13a869f5014e246a))
* **05:** WR-01 track presence activity in a ref so idle never cancels the submitted timer ([4a83190](https://github.com/mohitmayank/shared-brainstorm/commit/4a83190115cf58c1984d32e77c8a5e6d73ecb4a8))
* **05:** WR-02 clear all presence timers on terminal session status ([11511a9](https://github.com/mohitmayank/shared-brainstorm/commit/11511a946acf939b3b8b8bed054c81369fa3b74f))
* **05:** WR-03 durable welcome handler now projects session_status ([50f6ae9](https://github.com/mohitmayank/shared-brainstorm/commit/50f6ae9ed8e8eda9fec05dbd2a30b01bb408f06d))
* **05:** WR-04 scope picking start to active question's ticket_id ([0370d0b](https://github.com/mohitmayank/shared-brainstorm/commit/0370d0b6d2479b39d8d9b8d58ba1cff3e40d920b))
* **06:** CR-01 enforce aggregate MAX_OPEN_QUESTIONS=20 cap in askGroup ([dfdae6d](https://github.com/mohitmayank/shared-brainstorm/commit/dfdae6d98531b30cf05ef95401836813f5989a6d))
* **06:** make askGroupBatch atomic + drop redundant exitChoosing/shadowed firstOpen ([d4b1793](https://github.com/mohitmayank/shared-brainstorm/commit/d4b1793ef1a9944aee481bf884db40ed0304419e))
* **06:** restore resolved-card flip + clear 'choosing' on resolve (e2e regressions) ([be1cb3a](https://github.com/mohitmayank/shared-brainstorm/commit/be1cb3aaae10f82f2d9eb4308ca114710d76f530))
* **06:** WR-01/WR-03 track pickingTicketId per-ticket for correct choosing status ([84f7916](https://github.com/mohitmayank/shared-brainstorm/commit/84f7916574a4c46965aff97545eeb14ab74790f2))
* **06:** WR-02 return 409 already_resolved for double-resolve on known ticket ([36e83be](https://github.com/mohitmayank/shared-brainstorm/commit/36e83be0fbfed07e991b2780a414d1aa2237fdbe))
* **06:** WR-05 unify derived current_question via firstOpen() helper ([2756e0a](https://github.com/mohitmayank/shared-brainstorm/commit/2756e0a1e3a644269c0332d3a1f6d3c17301f1a9))
* **07:** WR-01 awaitAnswer falls back to terminalQuestions after pruning ([7a75525](https://github.com/mohitmayank/shared-brainstorm/commit/7a75525d51bf82ce7289dd34cfac29ee52aee31a))
* **07:** WR-01 prune ticket_to_question on question resolve/cancel/timeout ([f885b28](https://github.com/mohitmayank/shared-brainstorm/commit/f885b28a87a387dc4b5c1b9c136ced2102eda483))
* **07:** WR-03 gate ChatPanel Send on WS connectivity ([83b5d1a](https://github.com/mohitmayank/shared-brainstorm/commit/83b5d1a0efb072102da35bbaf5651144cd44b8ec))
* **08:** IN-01 change demo link to htmlpreview so it renders live ([12b3241](https://github.com/mohitmayank/shared-brainstorm/commit/12b32413cc91f14a336588a9b89f6ed908ef4bcc))
* **08:** WR-01 track scene3Timer to prevent orphaned timeout on Replay ([80e9332](https://github.com/mohitmayank/shared-brainstorm/commit/80e93324e5bcd9a909b80b8d5df05ed63b077e24)), closes [#suggestion-alex](https://github.com/mohitmayank/shared-brainstorm/issues/suggestion-alex)
* **08:** WR-02 + WR-03 isolate install tests + add exhaustiveness guard ([d7a5b9c](https://github.com/mohitmayank/shared-brainstorm/commit/d7a5b9c11d16407310a978bf06d6efee3b3e55cb))
* **tech-debt:** clear all 8 lint errors — install react-hooks plugin + drop dead vars ([48c82dc](https://github.com/mohitmayank/shared-brainstorm/commit/48c82dc6c7aebf08d3c23f81c1956b66b1be7127))
* **tech-debt:** Phase 5 UI polish — hoist [@keyframes](https://github.com/keyframes) pulse to top level + move picking caption beside status pill ([ea00641](https://github.com/mohitmayank/shared-brainstorm/commit/ea0064121c17ed116ec336948ccbbe5444751ad4))
* **tech-debt:** Phase 6 — gate coordinator batch-hint on unresolved questions only ([0469f1f](https://github.com/mohitmayank/shared-brainstorm/commit/0469f1f7f39c5787407e44173943613eeb53cf0f))

## [1.1.0](https://github.com/mohitmayank/shared-brainstorm/compare/v1.0.0...v1.1.0) (2026-05-18)

### Bug Fixes

* **release:** include README and LICENSE in the published npm package ([38e8048](https://github.com/mohitmayank/shared-brainstorm/commit/38e80489cf44bb5e5e542965077513696376fd51))

## 1.0.0 (2026-05-18)

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Playwright/TypeScript E2E automation for the **Healthya** pharmacy patient journey (`https://dev.healthya.co.uk/`), plus a small Express **dashboard** (`dashboard.js`) that lets a non-technical user paste a link/pharmacy, launch a run, and watch live results/traces in the browser instead of the terminal.

Two entry flows:
1. **API Link Journey Flow** — paste a `patient_flow` link (`START_URL`), click Get Started, and let the dynamic journey loop drive itself to completion.
2. **Yopmail Assessment Flow** — open a Yopmail inbox, open the latest assessment email, click Start Assessment, extract the passcode, auto-fill DOB + passcode, then run the same dynamic journey loop.

## Commands

```bash
npm install                    # setup
npm run dashboard               # start the Express dashboard (http://localhost:<port>) — primary way to run tests
npm test                        # playwright test (all specs)
npm run test:ui                 # playwright --ui
npm run test:api-link           # tests/e2e/pasted-link-flow.spec.ts only
npm run test:yopmail            # tests/e2e/yopmail-assessment-flow.spec.ts only
npx playwright test tests/e2e/<file>.spec.ts -g "<test name>"   # single test
npx playwright show-report      # open the last HTML report
```

Config is env-var driven via `.env` (see `playwright.config.ts` and `tests/fixtures/test-data.ts`). Key vars:
- `BASE_URL` — target site (default `https://dev.healthya.co.uk/`)
- `START_URL` — direct `patient_flow` link to run against (skips `/conditions` browsing)
- `CONDITION_DETAIL_PATH` — direct condition detail path, alternative to `START_URL`
- `YOPMAIL_INBOX` — Yopmail inbox name for the Yopmail flow
- `OVERRIDE_ACTIVE_CONDITION` — forces which questionnaire rule set `QuestionnairePage` applies (`shingles` / `weight management` / `erectile-dysfunction`); normally auto-detected or set per-`FlowConfig`, don't hardcode unless writing a fixed-condition spec
- `TD_*` — override any field in `TEST_USER` / booking / shipping fixtures (e.g. `TD_DOB_DAY`, `TD_APPOINTMENT_TYPE`, `TD_PIN`) without editing fixture files
- `TD_API_DEBUG=true` — logs API request/response bodies seen during a run (`run-flow.ts`)

Playwright config: single worker, `fullyParallel: false`, `retries: 1` on CI only, trace **always on**, video always on. Tests are inherently sequential/stateful (one browser walking a live multi-step journey), don't parallelize them.

## Architecture

### The dynamic journey loop (the core of this repo)

`tests/helpers/run-flow.ts` (`runConditionFlow`) is the heart of the automation. The Healthya patient journey isn't a fixed linear script — depending on condition, journey type (`nhs` / `private` / `lifestyle`), and account state, the site can route through steps in different orders (e.g. sign-up before or after questionnaire, drug selection may or may not appear). So instead of a hardcoded step sequence, `run-flow.ts`:

1. Navigates to the start point (`START_URL` direct link, `CONDITION_DETAIL_PATH`, or browsing `/conditions`).
2. Loops (`MAX_ITERATIONS`, currently 8): each iteration calls `detectCurrentStep(page)`, which sniffs the live DOM/URL for a fingerprint of ~15 known `JourneyStep` states (`landing`, `guest_continue`, `product_signup`, `questionnaire_submit`, `sign_up`, `appointment_booking`, `drug_selection`, `cart`, `shipping_address`, `thank_you`, `payment`, `success`, `gender_not_supported`, `dead_end`, `unknown`).
3. Dispatches to the matching page object to handle that step, then loops again — it keeps re-detecting after every action rather than assuming what comes next.
4. Guards against infinite loops via `stepVisits` / `MAX_STEP_VISITS`, and against terminal dead-ends (self-care referral, "not eligible", gender-mismatch popups) by clicking through "End Assessment" / "Back to Home" and stopping gracefully.

When adding a new journey branch, add/adjust a `JourneyStep` detection block in `detectCurrentStep` (order matters — indicators are checked most-specific-first, e.g. `thank_you` must be checked before generic `success`) and a corresponding `case` in the switch statement, not a new fixed sequence.

### Page objects (`tests/page-objects/`)

One class per screen/step (`ConditionsPage`, `ConditionDetailPage`, `QuestionnairePage`, `SignupPage`, `BookingPage`, `PaymentPage`, `CartPage`, `ShippingAddressPage`, `ThankYouPage`, etc.), each owning its own selectors and a `waitForPage()`/action method(s) that `run-flow.ts` calls. `QuestionnairePage` is by far the largest and most fragile piece (dynamic, one-question-at-a-time wizard covering radios, checkboxes, checkbox groups, free-text, dates) — it tracks answered-question state (`answeredRuleKeys`, `answeredGenericQuestions`, `processedCheckboxGroups`) across iterations so re-detecting the same step doesn't re-answer or get stuck.

### Condition-specific questionnaire rules (`tests/page-objects/ConditionQuestionnaireRules.ts`)

Per-condition question→answer mappings (`SHINGLES_RULES`, `WEIGHT_MANAGEMENT_RULES`, `ERECTILE_DYSFUNCTION_RULES`) as `{ questionPattern: RegExp, answerText, control }` tuples. `QuestionnairePage.answerByConditionRules` matches the live question text against these before falling back to a generic answering strategy. Which rule set applies is resolved by `getActiveConditionName()` (`tests/fixtures/test-data.ts`), which reads `OVERRIDE_ACTIVE_CONDITION` — set explicitly via `FlowConfig.questionnaireRulesKey`, or auto-detected from page text (`detectQuestionnaireRulesKeyFromText` / `detectConditionFromText`, duplicated in `run-flow.ts` and the logged-in spec) when a spec doesn't pin the condition ahead of time. Adding a new condition means adding a new `*_RULES` array here plus a detection regex wherever conditions are auto-detected.

### Fixtures (`tests/fixtures/`)

- `test-data.ts` — `TEST_USER` (identity/payment fields, all `TD_*`-overridable) and preference objects (`BOOKING_PREFERENCES`, `CART_PREFERENCES`, `SHIPPING_ADDRESS_PREFERENCES`, `THANK_YOU_PREFERENCES`, `DRUG_SELECTION_PREFERENCES`) consumed by the matching page objects.
- `flow-configs.ts` — `FlowConfig` type + `FLOW_CONFIGS` array describing named scenarios (journey type, condition, booking strategy, payment method). Specs build/pick a `FlowConfig` and hand it to `runConditionFlow`.
- `pharmacies.ts` / `booking-scenarios.ts` / `payment-scenarios.ts` — additional scenario data consumed by the dashboard and scenario-style specs.

### Specs (`tests/e2e/`)

Thin: each spec builds a `FlowConfig`, optionally does flow-specific setup (Yopmail email retrieval, START_URL DOB+PIN gate), then calls `runConditionFlow`. `patient-signup-next-803-retry-booking.spec.ts` is the exception — a scenario-specific test with its own retry logic rather than the generic loop.

### Dashboard (`dashboard.js` + `dashboard-public/index.html`)

Single-file Express server (no build step) serving a static dashboard UI and a small JSON API (`/api/test-data`, `/api/flow-configs`, `/api/pharmacies`, `/api/run-tests`, `/api/latest-artifacts`, `/api/results`, etc.). It shells out to `npx playwright test` (tracked in `activeProcs`/`completedRunIds`), serves `test-results/` and the bundled `playwright-core` trace viewer statically so traces can be viewed in-browser, and can read/patch `tests/fixtures/test-data.ts` by regex (`readPharmacies`, test-data GET/POST) rather than importing it as a module — keep that file's shape (simple `key: "value"` lines) regex-parseable if you edit it. `USER_GUIDE.md` documents the dashboard UI end-to-end for non-technical users; update it when dashboard-facing behavior changes.

## Gotchas specific to this site

- A cookie-consent banner can block interactions on first load of almost any page; call `dismissCookieConsent(page)` (`tests/helpers/cookie-consent.ts`) after every navigation, not just once at the start.
- The site can present the *same logical step* differently depending on entry path (browsed vs. direct link vs. logged-in-with-PIN) — `detectCurrentStep` and the rule-detection regexes intentionally check multiple heading variants/typos (e.g. "Continue to Payement", "Book Private Consulation") because they exist in production copy.
- Dead-end/ineligibility states (self-care, GP referral, gender mismatch, "not eligible") must be treated as a graceful stop, not a failure — see `handleDeadEndTerminalActions` / `handleTerminalBackToHomePopup`.

## Foreign-agent config detected

A `GEMINI.md` file exists at the repo root (Gemini CLI project instructions). If you want its contents considered or migrated, reply `/import` to scan what's importable, then `/import --yes=<digest>` to apply it — I haven't read it as part of this init.

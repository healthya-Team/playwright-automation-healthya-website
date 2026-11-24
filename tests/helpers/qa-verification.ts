import type { Page, Request } from "@playwright/test";

/**
 * Questionnaire Q&A verification: compares what the automation clicked/typed
 * (QuestionnairePage.filledAnswers) against what the submit_questionnaire API
 * call actually sent to the server — the ground truth, not a scrape of a review
 * screen. Same logic as strachan-pharmacy-test; the dashboard renders the
 * `📋 QA_COMPARISON:` line as a table.
 */

export interface QuestionnaireSubmission {
  requestBody: string | Record<string, unknown>;
  responseBody: any;
}

type FilledAnswer = { question: string; answer: string };

/**
 * Recognise a questionnaire submission by its BODY SHAPE (the platform's
 * "answer_detail[N][...]" multipart naming, or an "answer_detail" JSON key)
 * rather than by URL, so it isn't tied to one endpoint name.
 */
function looksLikeQuestionnaireSubmission(body: string | null): boolean {
  if (!body) return false;
  return body.includes("answer_detail[") || /"answer_detail"\s*:/.test(body);
}

/** Starts recording every questionnaire submission this page makes. Multi-step questionnaires submit once per template. */
export function captureQuestionnaireSubmissions(
  page: Page,
): QuestionnaireSubmission[] {
  const submissions: QuestionnaireSubmission[] = [];
  const pendingBodies = new Map<Request, string>();

  page.on("request", (req) => {
    if (!["POST", "PUT", "PATCH"].includes(req.method())) return;
    // postData() is null for a multipart body containing binary content;
    // latin1-decoding the raw bytes keeps the field lines readable as text.
    const body =
      req.postData() || req.postDataBuffer()?.toString("latin1") || null;
    if (body && (req.url().includes("submit_questionnaire") || looksLikeQuestionnaireSubmission(body))) {
      pendingBodies.set(req, body);
    }
  });

  page.on("response", async (res) => {
    const req = res.request();
    const body = pendingBodies.get(req);
    if (body === undefined) return;
    pendingBodies.delete(req);

    let responseBody: unknown = null;
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        responseBody = JSON.parse(text);
      } catch {
        responseBody = text.substring(0, 2000);
      }
    }
    let requestBody: string | Record<string, unknown> = body;
    try {
      requestBody = JSON.parse(body);
    } catch {}
    submissions.push({ requestBody, responseBody });
  });

  return submissions;
}

/**
 * submit_questionnaire is usually multipart/form-data: answer_detail[N]
 * [question_detail_id] + answer_detail[N][answer] pairs. Some answers arrive as
 * "Option title®optionId" — everything from "®" onward is dropped. A plain JSON
 * body ({ answer_detail: [{ question_detail_id, answer }] }) is also supported.
 */
function parseSubmittedAnswers(
  body: string | Record<string, unknown>,
): { id: string; answer: string }[] {
  if (typeof body === "object" && body !== null) {
    const list = (body as any).answer_detail;
    if (!Array.isArray(list)) return [];
    return list
      .filter((a: any) => a && a.question_detail_id != null && a.answer != null)
      .map((a: any) => ({
        id: String(a.question_detail_id),
        answer: String(a.answer).split("®")[0].trim(),
      }));
  }

  const ids: Record<string, string> = {};
  const idRe =
    /name="answer_detail\[(\d+)\]\[question_detail_id\]"\r?\n\r?\n(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(body))) ids[m[1]] = m[2];

  const answers: Record<string, string> = {};
  const ansRe =
    /name="answer_detail\[(\d+)\]\[answer\]"\r?\n\r?\n([\s\S]*?)\r?\n------/g;
  while ((m = ansRe.exec(body))) answers[m[1]] = m[2].split("®")[0].trim();

  return Object.keys(ids)
    .filter((idx) => answers[idx] !== undefined)
    .map((idx) => ({ id: ids[idx], answer: answers[idx] }));
}

// "&nbsp;" must be decoded: after normalizeForMatch strips punctuation it would
// otherwise leave a stray "nbsp" word that breaks matching on identical wording.
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** question_detail_id -> plain-text title (HTML stripped), including conditional child questions. */
function collectQuestionTitles(
  details: any[] | undefined,
  out: Record<string, string> = {},
): Record<string, string> {
  for (const q of details || []) {
    if (q?.id != null) {
      out[String(q.id)] = decodeHtmlEntities(
        String(q.title || "").replace(/<[^>]+>/g, ""),
      )
        .replace(/\s+/g, " ")
        .trim();
    }
    if (Array.isArray(q?.children)) collectQuestionTitles(q.children, out);
  }
  return out;
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The rule engine and the generic fallback can observe the same answered
 * question in one pass, and range/date pickers re-record on every pass — drop
 * identical (question, answer) pairs so the count is real distinct answers.
 */
function dedupeFilledAnswers(raw: FilledAnswer[]): FilledAnswer[] {
  const seen = new Set<string>();
  return raw.filter((f) => {
    const key = `${normalizeForMatch(f.question)} ${normalizeForMatch(f.answer)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface QaRow {
  question: string;
  filledAnswer: string | null;
  submittedAnswer: string | null;
  matched: boolean;
  unverified?: boolean;
}

export interface QaComparison {
  totalSubmitted: number;
  totalFilled: number;
  matchedCount: number;
  mismatches: QaRow[];
  rows: QaRow[];
}

function buildQaComparison(
  rawFilled: FilledAnswer[],
  submissions: QuestionnaireSubmission[],
): QaComparison {
  const filled = dedupeFilledAnswers(rawFilled);

  const submitted: { question: string; answer: string }[] = [];
  for (const { requestBody, responseBody } of submissions) {
    const titles = collectQuestionTitles(
      responseBody?.data?.questionnaire?.questionnaire_template
        ?.question_details,
    );
    for (const { id, answer } of parseSubmittedAnswers(requestBody)) {
      submitted.push({ question: titles[id] || `Question #${id}`, answer });
    }
  }

  // Token-overlap match (words of 4+ letters), not substring containment:
  // adjacent DOM elements concatenate with no space ("NoticeThis consultation")
  // while the API's HTML title has one, which shifts every later character.
  // Shared words must also cover a fair share of the LARGER side, so a 1-word
  // question ("Weight") can't match any long text that merely mentions it.
  const significantWords = (text: string) =>
    new Set(
      normalizeForMatch(text)
        .split(" ")
        .filter((w) => w.length >= 4),
    );

  const usedFilledIdx = new Set<number>();
  const rows: QaRow[] = submitted.map((s) => {
    const submittedWords = significantWords(s.question);
    let bestIdx = -1;
    let bestOverlap = 0;
    filled.forEach((f, idx) => {
      if (usedFilledIdx.has(idx)) return;
      const filledWords = significantWords(f.question);
      const smaller = Math.min(submittedWords.size, filledWords.size) || 1;
      const larger = Math.max(submittedWords.size, filledWords.size) || 1;
      let shared = 0;
      for (const w of submittedWords) if (filledWords.has(w)) shared++;
      if (shared / larger < 0.3) return;
      const overlap = shared / smaller;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIdx = idx;
      }
    });
    const match = bestOverlap >= 0.7 && bestIdx >= 0 ? filled[bestIdx] : null;
    if (match) usedFilledIdx.add(bestIdx);
    return {
      question: s.question,
      filledAnswer: match?.answer ?? null,
      submittedAnswer: s.answer,
      matched:
        !!match &&
        normalizeForMatch(match.answer) === normalizeForMatch(s.answer),
    };
  });

  return {
    totalSubmitted: rows.length,
    totalFilled: filled.length,
    matchedCount: rows.filter((r) => r.matched).length,
    mismatches: rows.filter((r) => !r.matched),
    rows,
  };
}

/**
 * Logs the comparison. The `📋 QA_COMPARISON:` line is always emitted — the
 * dashboard turns it into a table. The ASCII version is only for plain
 * `npx playwright test` runs (RUN_VIA_DASHBOARD unset), or it would show twice.
 */
export function logQaVerification(
  filledAnswers: FilledAnswer[],
  submissions: QuestionnaireSubmission[],
): void {
  if (submissions.length === 0 && filledAnswers.length === 0) return;

  // No submission captured (e.g. a file upload makes the request body
  // unrecoverable): still list what was filled, marked unverified, instead of
  // a false mismatch.
  const comparison: QaComparison =
    submissions.length > 0
      ? buildQaComparison(filledAnswers, submissions)
      : (() => {
          const deduped = dedupeFilledAnswers(filledAnswers);
          return {
            totalFilled: deduped.length,
            totalSubmitted: 0,
            matchedCount: 0,
            mismatches: [],
            rows: deduped.map((f) => ({
              question: f.question,
              filledAnswer: f.answer,
              submittedAnswer: null,
              matched: false,
              unverified: true,
            })),
          };
        })();

  console.log(`📋 QA_COMPARISON: ${JSON.stringify(comparison)}`);

  if (process.env.RUN_VIA_DASHBOARD) return;

  const truncate = (s: string, n: number) =>
    s.length > n ? s.slice(0, n - 1) + "…" : s;
  console.log("");
  console.log("Questionnaire Answer Verification");
  console.log(
    `Filled: ${comparison.totalFilled}   Submitted: ${comparison.totalSubmitted}   Matched: ${comparison.matchedCount}/${comparison.totalSubmitted}`,
  );
  console.log("");
  console.log("Question | Filled Answer | Submitted Answer | Status");
  console.log("------------------------------------------------------");
  comparison.rows.forEach((row, i) => {
    const status = row.unverified
      ? "UNVERIFIED"
      : row.matched
        ? "MATCH"
        : "MISMATCH";
    console.log(
      `Q${i + 1} | ${truncate(row.filledAnswer ?? "(no match)", 30)} | ${truncate(row.submittedAnswer ?? "(unavailable)", 30)} | ${status}`,
    );
  });
  for (const row of comparison.mismatches) {
    console.log("");
    console.log(`Question: ${truncate(row.question, 200)}`);
    console.log(`Filled: ${row.filledAnswer ?? "(no matching filled answer found)"}`);
    console.log(`Submitted: ${row.submittedAnswer}`);
    console.log(
      `Status: ❌ MISMATCH — ${row.filledAnswer === null ? "No corresponding filled answer could be matched to this question" : "Answers are different"}`,
    );
  }
}

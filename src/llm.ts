import Anthropic from "@anthropic-ai/sdk";
import type { Classification, Discipline, ExtractedIntake, InboxItem, Urgency } from "./types.js";

/**
 * LLM-backed reading of an inbox item. The model EXTRACTS structured intake and
 * PROPOSES a classification/urgency plus a few boolean signals. It is never the
 * final authority on safety — src/agent.ts applies deterministic guardrails on
 * top of whatever this returns. If the key is absent or any call/parse fails,
 * callers fall back to the deterministic classifier.
 */

const MODEL = process.env.TRIAGE_MODEL ?? "claude-haiku-4-5-20251001";

export interface LlmTriage {
  classification: Classification;
  urgency: Urgency;
  intake: ExtractedIntake;
  missing_info: string[];
  signals: {
    safeguarding: boolean; // any disclosure of harm, abuse, neglect, unsafe caregiving
    same_day_operational: boolean; // same-day cancel/reschedule needing action today
    clinical_advice_request: boolean; // parent asking for clinical/developmental advice
    prefers_spanish: boolean; // family requested Spanish / message is in Spanish
  };
  rationale: string;
}

export function llmAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

const SYSTEM_PROMPT = `You are the triage reasoning engine for Cedar Kids Therapy, a pediatric
practice offering speech-language pathology (SLP), occupational therapy (OT), and physical
therapy (PT) for children 0-18. You read one inbound inbox item (a pediatrician fax referral,
parent voicemail transcript, parent portal message, or email) and return STRICT JSON only.

Your job is to (a) extract structured intake, (b) classify the item, (c) propose an urgency,
and (d) flag a few safety/operational signals. Downstream code applies final safety guardrails,
so be accurate and literal — do not soften or omit a safety signal to be reassuring.

URGENCY RUBRIC (calibrate carefully — over-escalation is itself a failure):
- P0: safeguarding / imminent harm / mandated-reporter situations. Same-hour human review.
- P1: same-day operational issue requiring prompt staff action today (e.g. same-day cancel/reschedule).
- P2: normal intake, scheduling, billing, or clinical-review workflow. THIS IS THE DEFAULT.
- P3: low-priority admin, FYI, spam.
Default to P2 unless there is a clear safety (P0) or same-day operational (P1) reason. Words like
"URGENT" or many exclamation points do NOT by themselves make something P0 or P1 — judge the substance.

SIGNALS (booleans, judge the substance not the wording):
- safeguarding: ANY hint of harm, abuse, neglect, rough/violent caregiving, or a child being unsafe.
  Example: "he's been more clingy since his dad started getting rough with him" -> safeguarding = true.
- same_day_operational: a same-day cancellation or reschedule, or anything needing staff action today.
- clinical_advice_request: parent asks whether something is normal / should they worry / wants advice.
- prefers_spanish: the family requests Spanish OR the message itself is written in Spanish.

CLASSIFICATION (pick one): new_referral, existing_patient_request, scheduling, clinical_question,
billing_question, missing_paperwork, provider_followup, complaint, safeguarding, spam, other.
If safeguarding signal is present, classification should be "safeguarding".
If a referral is missing core fields (DOB, parent contact, payer), prefer "missing_paperwork".

EXTRACTED INTAKE fields (use null when truly absent; treat "[blank]" as null):
- child_name (string|null)
- dob_or_age (string|null; prefer YYYY-MM-DD if a DOB is given, else an age like "6 years old")
- parent_contact (string|null; combine parent name + phone + email when present)
- discipline (array of "SLP"|"OT"|"PT", or null) — infer from concern when not explicit
  (toe walking/tripping/gait -> PT; sensory/feeding -> OT; speech/articulation/language -> SLP)
- diagnosis_or_concern (string|null)
- payer (string|null) — insurance company / plan
- member_id (string|null)

missing_info: array of human-readable strings naming what's missing or needs confirmation.

Return ONLY a JSON object with exactly these keys:
{"classification","urgency","intake":{...7 fields...},"missing_info":[...],
 "signals":{"safeguarding","same_day_operational","clinical_advice_request","prefers_spanish"},
 "rationale"}`;

const DISCIPLINES: Discipline[] = ["SLP", "OT", "PT"];
const CLASSIFICATIONS: Classification[] = [
  "new_referral",
  "existing_patient_request",
  "scheduling",
  "clinical_question",
  "billing_question",
  "missing_paperwork",
  "provider_followup",
  "complaint",
  "safeguarding",
  "spam",
  "other",
];
const URGENCIES: Urgency[] = ["P0", "P1", "P2", "P3"];

export async function llmTriage(item: InboxItem): Promise<LlmTriage> {
  const userContent = JSON.stringify(
    {
      id: item.id,
      channel: item.channel,
      received_at: item.received_at,
      sender: item.sender,
      subject: item.subject,
      body: item.body,
      attachments: item.attachments,
    },
    null,
    2,
  );

  const resp = await getClient().messages.create({
    model: MODEL,
    max_tokens: 900,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Triage this inbox item. Return STRICT JSON only.\n\n${userContent}`,
      },
    ],
  });

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  return coerce(parseJson(text), item);
}

function parseJson(text: string): Record<string, unknown> {
  // Tolerate prose or code fences around the JSON object.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("LLM returned no JSON object");
  }
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

/** Validate/normalize the model output into a safe, fully-typed LlmTriage. */
function coerce(raw: Record<string, unknown>, item: InboxItem): LlmTriage {
  const rawIntake = (raw.intake ?? {}) as Record<string, unknown>;
  const rawSignals = (raw.signals ?? {}) as Record<string, unknown>;

  const intake: ExtractedIntake = {
    child_name: str(rawIntake.child_name),
    dob_or_age: str(rawIntake.dob_or_age),
    parent_contact: str(rawIntake.parent_contact),
    discipline: disciplines(rawIntake.discipline),
    diagnosis_or_concern: str(rawIntake.diagnosis_or_concern),
    payer: str(rawIntake.payer),
    member_id: str(rawIntake.member_id),
  };

  return {
    classification: oneOf(raw.classification, CLASSIFICATIONS, "other"),
    urgency: oneOf(raw.urgency, URGENCIES, "P2"),
    intake,
    missing_info: stringArray(raw.missing_info),
    signals: {
      safeguarding: bool(rawSignals.safeguarding),
      same_day_operational: bool(rawSignals.same_day_operational),
      clinical_advice_request: bool(rawSignals.clinical_advice_request),
      prefers_spanish: bool(rawSignals.prefers_spanish),
    },
    rationale:
      str(raw.rationale) ?? `Triaged item ${item.id} via LLM extraction.`,
  };
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.toLowerCase() === "null" || t === "[blank]") return null;
  return t;
}

function bool(v: unknown): boolean {
  return v === true || v === "true";
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function disciplines(v: unknown): Discipline[] | null {
  if (!Array.isArray(v)) return null;
  const out = v
    .map((x) => String(x).toUpperCase())
    .filter((x): x is Discipline => (DISCIPLINES as string[]).includes(x));
  return out.length ? Array.from(new Set(out)) : null;
}

function oneOf<T extends string>(v: unknown, allowed: T[], fallback: T): T {
  return typeof v === "string" && (allowed as string[]).includes(v)
    ? (v as T)
    : fallback;
}

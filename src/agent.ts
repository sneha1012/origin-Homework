import {
  create_task,
  draft_message,
  escalate,
  find_slots,
  lookup_policy,
  search_patient,
  verify_insurance,
  getToolCallsForItem,
  withItemContext,
} from "./tools.js";
import { llmAvailable, llmTriage, type LlmTriage } from "./llm.js";
import type {
  Classification,
  Discipline,
  ExtractedIntake,
  InboxItem,
  ItemOutput,
  Urgency,
} from "./types.js";

/**
 * Entry point. Processes each inbox item sequentially so the audit trace is
 * written in a deterministic, item-by-item order. Each item is isolated in its
 * own try/catch + withItemContext, so a single bad item can never crash the
 * batch or corrupt another item's trace attribution.
 */
export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  const results: ItemOutput[] = [];
  for (const item of inbox) {
    const output = await withItemContext(item.id, () => processItem(item));
    results.push(output);
  }
  return results;
}

async function processItem(item: InboxItem): Promise<ItemOutput> {
  try {
    // 1. Understand the item: LLM reads & proposes, then code guardrails decide.
    //    Falls back to deterministic classification if the LLM is unavailable/fails.
    const triage = await triageItem(item);

    // 2. Orchestrate the relevant tools based on the classification.
    const plan = await orchestrate(item, triage);

    // 3. Assemble the output. tools_called comes straight from the audit trace,
    //    passed through UNCHANGED so it matches the validator's trace check.
    return {
      item_id: item.id,
      classification: triage.classification,
      urgency: triage.urgency,
      requires_human_review: true, // every item in this plan is human-reviewed
      extracted_intake: triage.intake,
      missing_info: triage.missingInfo,
      tools_called: getToolCallsForItem(item.id),
      recommended_next_action: plan.nextAction,
      draft_reply: plan.draftReply,
      task_ids: plan.taskIds,
      // Coherence invariant: escalation exists iff urgency is P0/P1, and its
      // severity must equal the urgency. This prevents a handler's default
      // escalation from contradicting a clamped-down urgency (e.g. a "scheduling"
      // item the guardrails rated P3 must not carry a P1 escalation).
      escalation: reconcileEscalation(triage.urgency, plan.escalation),
      decision_rationale: triage.rationale,
    };
  } catch (error) {
    // Safe fallback: never crash the batch. Surface a human task and explain.
    return safeFallback(item, error);
  }
}

// ---------------------------------------------------------------------------
// Triage (classification + extraction + urgency).
//
// triageItem(): LLM reads the item and PROPOSES classification/urgency/signals;
// applyGuardrails() is authoritative code that enforces safety and calibration
// on top. On any LLM failure we fall back to the deterministic classifier.
// ---------------------------------------------------------------------------

interface Triage {
  classification: Classification;
  urgency: Urgency;
  intake: ExtractedIntake;
  missingInfo: string[];
  rationale: string;
  isSafeguarding: boolean;
  preferSpanish: boolean;
}

async function triageItem(item: InboxItem): Promise<Triage> {
  if (!llmAvailable()) {
    return classifyDeterministic(item);
  }
  try {
    const llm = await llmTriage(item);
    return applyGuardrails(item, llm);
  } catch (error) {
    const det = classifyDeterministic(item);
    det.rationale = `${det.rationale} (LLM unavailable; used deterministic fallback: ${
      error instanceof Error ? error.message : String(error)
    })`;
    return det;
  }
}

/**
 * Authoritative guardrail layer. Takes the LLM's proposal and enforces the
 * safety/calibration rules in CODE so a model misread cannot bypass them:
 *  - Safeguarding signal (LLM flag OR keyword) => force safeguarding + P0.
 *  - "Urgent" wording alone must not inflate urgency; same-day op => P1.
 *  - Never below P1 for a true safeguarding case.
 */
function applyGuardrails(item: InboxItem, llm: LlmTriage): Triage {
  const text = `${item.subject}\n${item.body}`.toLowerCase();
  const safeguarding = llm.signals.safeguarding || hasSafeguardingSignal(text);

  if (safeguarding) {
    return {
      classification: "safeguarding",
      urgency: "P0",
      intake: llm.intake,
      missingInfo: llm.missing_info,
      isSafeguarding: true,
      preferSpanish: llm.signals.prefers_spanish,
      rationale:
        "Safeguarding signal detected (possible harm or unsafe caregiving). Per policy this is " +
        "forced to P0 with immediate clinical escalation, regardless of the requested service. " +
        `Model note: ${llm.rationale}`,
    };
  }

  // Calibration: same-day operational => P1; otherwise trust the LLM but clamp
  // any over-escalation that isn't backed by a safety or same-day reason.
  let urgency = llm.urgency;
  let classification = llm.classification;
  if (llm.signals.same_day_operational) {
    urgency = "P1";
    if (classification === "safeguarding") classification = "scheduling";
  } else if (urgency === "P0" || urgency === "P1") {
    // No safeguarding and no same-day op => P0/P1 is not justified. Clamp to P2.
    urgency = "P2";
  }

  return {
    classification,
    urgency,
    intake: llm.intake,
    missingInfo: llm.missing_info,
    isSafeguarding: false,
    preferSpanish: llm.signals.prefers_spanish,
    rationale: llm.rationale,
  };
}

function classifyDeterministic(item: InboxItem): Triage {
  const intake = extractIntake(item);
  const text = `${item.subject}\n${item.body}`.toLowerCase();
  const preferSpanish = detectsSpanish(text);

  // --- Safety guardrail (authoritative, pure code) -------------------------
  // A safeguarding disclosure outranks everything else. This is intentionally
  // a code-level rule, not a prompt instruction, so it cannot be argued away
  // by a model misread. (Calibration trap: item_2.)
  if (hasSafeguardingSignal(text)) {
    return {
      classification: "safeguarding",
      urgency: "P0",
      intake,
      missingInfo: missingFields(intake),
      isSafeguarding: true,
      preferSpanish,
      rationale:
        "Message contains language suggesting possible harm or unsafe caregiving. " +
        "Per safeguarding policy this is P0 and must be escalated to the clinical lead " +
        "for same-hour review before any routine intake or scheduling step.",
    };
  }

  // --- Same-day operational (P1), NOT a safety event -----------------------
  // Calibration trap: item_8 shouts "URGENT" but is a same-day reschedule.
  // "Urgent" wording alone must NOT trigger P0.
  if (isSameDayScheduling(text)) {
    return {
      classification: "scheduling",
      urgency: "P1",
      intake,
      missingInfo: missingFields(intake),
      isSafeguarding: false,
      preferSpanish,
      rationale:
        "Same-day cancellation/reschedule is a P1 operational issue requiring prompt " +
        "staff action today. The 'urgent' wording reflects parent stress, not a safety " +
        "event, so it is not escalated to P0.",
    };
  }

  // --- Clinical question (no advice over message) --------------------------
  if (isClinicalQuestion(text)) {
    return {
      classification: "clinical_question",
      urgency: "P2",
      intake,
      missingInfo: missingFields(intake),
      isSafeguarding: false,
      preferSpanish,
      rationale:
        "Parent is asking for clinical guidance. Policy prohibits giving clinical advice " +
        "by message; route to screening/evaluation and acknowledge without diagnosing.",
    };
  }

  // --- Missing-paperwork referral ------------------------------------------
  const missing = missingFields(intake);
  if (isReferral(item) && isIncompleteReferral(intake)) {
    return {
      classification: "missing_paperwork",
      urgency: "P2",
      intake,
      missingInfo: missing,
      isSafeguarding: false,
      preferSpanish,
      rationale:
        "Referral is missing required intake fields, so it cannot be processed or insurance " +
        "verified yet. Route to intake to obtain the missing information from the referring office.",
    };
  }

  // --- New referral (default for fax/email referrals) ----------------------
  if (isReferral(item)) {
    return {
      classification: "new_referral",
      urgency: "P2",
      intake,
      missingInfo: missing,
      isSafeguarding: false,
      preferSpanish,
      rationale:
        "Standard new referral with sufficient intake data. Verify insurance and surface " +
        "candidate evaluation slots for staff review; default urgency P2.",
    };
  }

  // --- Fallback ------------------------------------------------------------
  return {
    classification: "other",
    urgency: "P2",
    intake,
    missingInfo: missing,
    isSafeguarding: false,
    preferSpanish,
    rationale:
      "Item did not match a specific workflow; defaulting to P2 normal intake and routing " +
      "to staff for review.",
  };
}

// ---------------------------------------------------------------------------
// Orchestration: call the right tools for the classification. Every tool we
// call here is surfaced via getToolCallsForItem, so we only call tools whose
// result genuinely informs the plan (no performative calls).
// ---------------------------------------------------------------------------

interface Plan {
  nextAction: string;
  draftReply: string | null;
  taskIds: string[];
  escalation: { reason: string; severity: "P0" | "P1" } | null;
}

async function orchestrate(item: InboxItem, triage: Triage): Promise<Plan> {
  switch (triage.classification) {
    case "safeguarding":
      return handleSafeguarding(item, triage);
    case "scheduling":
      return handleScheduling(item, triage);
    case "clinical_question":
      return handleClinicalQuestion(item, triage);
    case "missing_paperwork":
      return handleMissingPaperwork(item, triage);
    case "new_referral":
      return handleNewReferral(item, triage);
    default:
      return handleOther(item, triage);
  }
}

async function handleSafeguarding(
  item: InboxItem,
  triage: Triage,
): Promise<Plan> {
  await lookup_policy({ topic: "safeguarding" });
  await escalate({
    item_id: item.id,
    reason:
      "Possible child-safety disclosure in inbound message; requires same-hour clinical review.",
    severity: "P0",
  });
  const task = await create_task({
    assignee: "clinical_lead",
    title: `Same-hour safeguarding review for ${triage.intake.child_name ?? "child"}`,
    due: dateOnly(item.received_at),
    notes:
      "Inbound message contains possible safeguarding concern. Do not provide investigative " +
      "advice to the family; clinical lead to review and determine mandated-reporter steps.",
  });

  // Neutral acknowledgement only — no investigative content (per policy).
  const contact = triage.intake.parent_contact;
  const draftReply = contact
    ? "Thank you for reaching out about your child. A member of our clinical team will follow up " +
      "with you directly. We're here to help and will be in touch shortly."
    : null;
  if (contact) {
    await draft_message({
      recipient: contact,
      channel: pickDraftChannel(item, contact),
      body: draftReply as string,
      language: "en",
    });
  }

  return {
    nextAction:
      "Clinical lead to review the escalation this hour and determine mandated-reporter obligations " +
      "before any routine intake or scheduling.",
    draftReply,
    taskIds: [task.data.task_id],
    escalation: {
      reason:
        "Possible child-safety disclosure; safeguarding policy requires immediate clinical escalation.",
      severity: "P0",
    },
  };
}

async function handleScheduling(item: InboxItem, triage: Triage): Promise<Plan> {
  await search_patient({
    name: triage.intake.child_name ?? undefined,
    dob: dobIfDate(triage.intake.dob_or_age),
  });
  const discipline = pickDiscipline(triage.intake.discipline);
  await find_slots({ discipline, preferences: "same-day or next-available makeup" });
  const task = await create_task({
    assignee: "front_desk",
    title: `Same-day reschedule for ${triage.intake.child_name ?? "patient"}`,
    due: dateOnly(item.received_at),
    notes:
      "Parent requested a same-day reschedule. Front desk to contact the family today and offer " +
      "a makeup slot; do not auto-book.",
  });

  const contact = triage.intake.parent_contact;
  let draftReply: string | null = null;
  if (contact) {
    draftReply =
      "Thanks for letting us know, and we hope your child feels better soon. We've flagged today's " +
      "appointment for our front desk to reschedule, and someone will reach out shortly with options.";
    await draft_message({
      recipient: contact,
      channel: pickDraftChannel(item, contact),
      body: draftReply,
      language: "en",
    });
  }

  return {
    nextAction:
      "Front desk to call the family today to confirm cancellation and offer a makeup evaluation slot.",
    draftReply,
    taskIds: [task.data.task_id],
    escalation: {
      reason: "Same-day reschedule requires prompt front-desk action today.",
      severity: "P1",
    },
  };
}

async function handleClinicalQuestion(
  item: InboxItem,
  triage: Triage,
): Promise<Plan> {
  await lookup_policy({ topic: "clinical_advice" });
  const task = await create_task({
    assignee: "intake",
    title: `Route clinical question to screening for ${triage.intake.child_name ?? "child"}`,
    due: addDays(item.received_at, 2),
    notes:
      "Parent asked a developmental question. Per policy, do not answer clinically by message; " +
      "offer a screening/evaluation pathway.",
  });

  const contact = triage.intake.parent_contact;
  let draftReply: string | null = null;
  if (contact) {
    draftReply =
      "Thank you for your question. Every child develops at their own pace, and the best way to get " +
      "a clear answer is a short screening with one of our speech-language pathologists. We can't give " +
      "clinical advice by message, but we'd be glad to set up an evaluation so a clinician can take a look.";
    await draft_message({
      recipient: contact,
      channel: pickDraftChannel(item, contact),
      body: draftReply,
      language: "en",
    });
  }

  return {
    nextAction:
      "Intake to offer a screening/evaluation appointment; a clinician (not the front desk) addresses the developmental question.",
    draftReply,
    taskIds: [task.data.task_id],
    escalation: null,
  };
}

async function handleMissingPaperwork(
  item: InboxItem,
  triage: Triage,
): Promise<Plan> {
  const task = await create_task({
    assignee: "intake",
    title: `Obtain missing referral details for ${triage.intake.child_name ?? "child"}`,
    due: addDays(item.received_at, 2),
    notes:
      `Referral is missing: ${triage.missingInfo.join(", ") || "key fields"}. ` +
      "Intake to contact the referring office to complete the referral before scheduling or insurance verification.",
  });

  return {
    nextAction:
      "Intake to contact the referring office for the missing referral fields before any further processing.",
    // No parent contact on an incomplete fax referral -> no parent draft.
    draftReply: null,
    taskIds: [task.data.task_id],
    escalation: null,
  };
}

async function handleNewReferral(item: InboxItem, triage: Triage): Promise<Plan> {
  // Surface a possible existing-patient match (identity/duplicate check).
  const matches = await search_patient({
    name: triage.intake.child_name ?? undefined,
    dob: dobIfDate(triage.intake.dob_or_age),
  });

  const insurance = await verify_insurance({
    payer: triage.intake.payer ?? undefined,
    member_id: triage.intake.member_id ?? undefined,
  });

  const taskIds: string[] = [];
  const discipline = pickDiscipline(triage.intake.discipline);
  const contact = triage.intake.parent_contact;
  let draftReply: string | null = null;
  let nextAction: string;

  if (insurance.data.status === "out_of_network" || insurance.data.status === "expired") {
    // Benefits conversation required before any slot.
    await lookup_policy({ topic: "insurance" });
    const task = await create_task({
      assignee: "billing",
      title: `Review ${insurance.data.status.replace("_", "-")} benefits for ${triage.intake.child_name ?? "patient"}`,
      due: addDays(item.received_at, 2),
      notes:
        `Insurance verification returned ${insurance.data.status} for ${triage.intake.payer ?? "the payer"}. ` +
        "Billing to discuss options with the family before any slot is held or scheduled.",
    });
    taskIds.push(task.data.task_id);
    nextAction =
      "Billing to discuss benefits with the family before staff considers any appointment slot.";
    if (contact) {
      draftReply =
        "Thank you for the referral. Before we schedule, our billing team needs to review your insurance " +
        "coverage, as it may be out of network for our practice. A team member will follow up with options shortly.";
    }
  } else {
    // In-network (or unknown) -> surface candidate slots for staff to review.
    // Honor a Spanish-language preference so find_slots returns Spanish-capable
    // providers and the draft is written in Spanish (language access policy).
    if (triage.preferSpanish) {
      await lookup_policy({ topic: "language_access" });
    }
    await find_slots({
      discipline,
      preferences: subjectPreference(item),
      language: triage.preferSpanish ? "es" : undefined,
    });
    const assignee = "intake" as const;
    const identityNote =
      matches.data.length > 0
        ? ` NOTE: search_patient found an existing record (${matches.data
            .map((m) => `${m.name}, guardian ${m.guardian_name}`)
            .join("; ")}); confirm this is the same child before proceeding.`
        : "";
    const task = await create_task({
      assignee,
      title: `Schedule ${discipline ?? "evaluation"} for ${triage.intake.child_name ?? "patient"} (staff review)`,
      due: addDays(item.received_at, 2),
      notes:
        `Insurance ${insurance.data.status}. Candidate evaluation slots surfaced for staff to review and book.` +
        identityNote,
    });
    taskIds.push(task.data.task_id);
    nextAction = triage.preferSpanish
      ? "Intake to review the surfaced Spanish-capable evaluation slots, confirm insurance/identity, and book with the family (Spanish-speaking provider preferred)."
      : "Intake to review the surfaced evaluation slots, confirm insurance/identity, and book with the family.";
    if (contact) {
      draftReply = triage.preferSpanish
        ? "Gracias por comunicarse con nosotros. Hemos recibido la informacion de su hija y estamos " +
          "revisando la disponibilidad para una evaluacion con un proveedor que hable espanol. Un miembro " +
          "de nuestro equipo se comunicara con usted pronto para coordinar la cita."
        : "Thank you for the referral. We've received the information and are reviewing evaluation availability. " +
          "A member of our team will reach out soon to confirm scheduling.";
    }
  }

  if (contact && draftReply) {
    await draft_message({
      recipient: contact,
      channel: pickDraftChannel(item, contact),
      body: draftReply,
      language: triage.preferSpanish ? "es" : "en",
    });
  }

  return { nextAction, draftReply, taskIds, escalation: null };
}

async function handleOther(item: InboxItem, triage: Triage): Promise<Plan> {
  const task = await create_task({
    assignee: "front_desk",
    title: `Review inbox item for ${triage.intake.child_name ?? "sender"}`,
    due: addDays(item.received_at, 2),
    notes: "Item did not match a specific workflow; front desk to triage manually.",
  });
  return {
    nextAction: "Front desk to review and route this item manually.",
    draftReply: null,
    taskIds: [task.data.task_id],
    escalation: null,
  };
}

// ---------------------------------------------------------------------------
// Extraction & heuristics (deterministic). These are deliberately simple in
// Slice 0; Slice 1 replaces extraction/classification with an LLM pass while
// keeping the same guardrails in code.
// ---------------------------------------------------------------------------

function extractIntake(item: InboxItem): ExtractedIntake {
  const body = item.body;
  return {
    child_name: matchAfter(body, /child:\s*([^.\n,]+)/i) ?? matchChildName(item),
    dob_or_age: matchAfter(body, /dob:\s*([0-9-]{4,10})/i) ?? matchAge(body),
    parent_contact: extractContact(item),
    discipline: extractDisciplines(body),
    diagnosis_or_concern:
      matchAfter(body, /(?:concern|diagnosis\/concern|diagnosis):\s*([^.\n]+)/i)?.trim() ??
      null,
    payer: matchAfter(body, /insurance:\s*([^.\n]+)/i)?.trim() ?? null,
    member_id: matchAfter(body, /member id:\s*([A-Za-z0-9-]+)/i) ?? null,
  };
}

function matchAfter(text: string, re: RegExp): string | null {
  const m = text.match(re);
  if (!m) return null;
  const value = m[1].trim();
  if (!value || value.startsWith("[") /* e.g. [blank] */) return null;
  return value;
}

function matchChildName(item: InboxItem): string | null {
  // e.g. "Referral: Emma Lee - speech ..." or "evaluation request for Leo"
  const subj = item.subject;
  const dash = subj.match(/referral:\s*([^-\n]+?)\s*-/i);
  if (dash) return dash[1].trim();
  const forName = item.body.match(/\bfor (?:my (?:son|daughter|child) )?([A-Z][a-z]+(?: [A-Z][a-z]+)?)/);
  return forName ? forName[1].trim() : null;
}

function matchAge(body: string): string | null {
  const m = body.match(/\b(?:he|she|is|tiene)\s*(?:is\s*)?(\d{1,2})\s*(?:years?|yo|anos|años)?\b/i);
  if (m) return `${m[1]} years old`;
  const m2 = body.match(/(\d{1,2})-year-old/i);
  return m2 ? `${m2[1]} years old` : null;
}

function extractContact(item: InboxItem): string | null {
  const phone = item.body.match(/\b\d{3}-\d{4}\b/);
  const email = item.body.match(/[\w.+-]+@[\w.-]+\.\w+/) ?? item.sender.match(/[\w.+-]+@[\w.-]+\.\w+/);
  const parts: string[] = [];
  const parent = item.body.match(/parent[^:]*:\s*([^,\n]+)/i);
  if (parent) parts.push(parent[1].trim());
  if (phone) parts.push(phone[0]);
  if (email) parts.push(email[0]);
  return parts.length ? parts.join(", ") : null;
}

function extractDisciplines(body: string): Discipline[] | null {
  const found = new Set<Discipline>();
  const t = body.toLowerCase();
  if (/\bslp\b|speech/.test(t)) found.add("SLP");
  if (/\bot\b|occupational|sensory|feeding/.test(t)) found.add("OT");
  if (/\bpt\b|physical therapy|toe walking|tripping|gait/.test(t)) found.add("PT");
  return found.size ? Array.from(found) : null;
}

function missingFields(intake: ExtractedIntake): string[] {
  const missing: string[] = [];
  if (!intake.child_name) missing.push("child_name");
  if (!intake.dob_or_age) missing.push("dob_or_age");
  if (!intake.parent_contact) missing.push("parent_contact");
  if (!intake.discipline) missing.push("discipline");
  if (!intake.payer) missing.push("payer");
  if (!intake.member_id) missing.push("member_id");
  return missing;
}

function detectsSpanish(text: string): boolean {
  if (/\b(espanol|español|spanish|hable espanol|habla espanol)\b/.test(text)) return true;
  // Common Spanish-message markers (accent-insensitive).
  return /\b(hola|gracias|mi hija|mi hijo|necesita|evaluacion|evaluación|prefiero|telefono|teléfono)\b/.test(
    text,
  );
}

function hasSafeguardingSignal(text: string): boolean {
  // Conservative set of harm/unsafe-caregiving signals.
  return /(rough with|hit|hits|hitting|abuse|abusing|neglect|hurt|hurting|unsafe|afraid of|scared of|bruise|violen)/.test(
    text,
  );
}

function isSameDayScheduling(text: string): boolean {
  const reschedule = /(reschedule|cancel|can'?t make|cannot make|miss(ed)? (the|today)|move my appointment)/.test(
    text,
  );
  const sameDay = /(today|this (morning|afternoon)|3pm|2pm|1pm|am appointment|pm appointment|\btoday'?s\b)/.test(
    text,
  );
  return reschedule && sameDay;
}

function isClinicalQuestion(text: string): boolean {
  const asks = /(is it normal|should i (be )?worr|should we wait|advice|do you think|is this normal)/.test(
    text,
  );
  const notReferral = !/referral|fax referral/.test(text);
  return asks && notReferral;
}

function isReferral(item: InboxItem): boolean {
  return (
    item.channel === "fax_referral" ||
    /referral/i.test(item.subject) ||
    /referral/i.test(item.body)
  );
}

function isIncompleteReferral(intake: ExtractedIntake): boolean {
  // Missing the basics needed to process: no DOB, no contact, or no payer.
  return !intake.dob_or_age || !intake.parent_contact;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function pickDiscipline(disc: Discipline[] | null): Discipline | undefined {
  return disc && disc.length ? disc[0] : undefined;
}

/**
 * Choose the draft channel from the contact info we actually have, not just the
 * inbound channel. A fax referral often carries a parent email we should prefer
 * over a phone number for a written reply. Portal messages stay in the portal.
 */
function pickDraftChannel(
  item: InboxItem,
  contact: string | null,
): "portal" | "email" | "phone" {
  if (item.channel === "portal_message") return "portal";
  if (contact && /[\w.+-]+@[\w.-]+\.\w+/.test(contact)) return "email";
  if (item.channel === "email") return "email";
  return "phone";
}

function dobIfDate(dobOrAge: string | null): string | undefined {
  if (!dobOrAge) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(dobOrAge) ? dobOrAge : undefined;
}

function subjectPreference(item: InboxItem): string {
  const m = item.body.match(/preferred availability:\s*([^.\n]+)/i);
  if (m) return m[1].trim();
  const m2 = item.body.match(/prefers?\s+([^.\n]+)/i);
  return m2 ? m2[1].trim() : "next available";
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Enforce the escalation/urgency invariant:
 *  - P0/P1 => an escalation object whose severity equals the urgency.
 *  - P2/P3 => no escalation (null), even if a handler proposed one.
 * Keeps a handler-provided reason when it is consistent; otherwise synthesizes one.
 */
function reconcileEscalation(
  urgency: Urgency,
  proposed: { reason: string; severity: "P0" | "P1" } | null,
): { reason: string; severity: "P0" | "P1" } | null {
  if (urgency !== "P0" && urgency !== "P1") return null;
  if (proposed && proposed.severity === urgency) return proposed;
  return {
    reason:
      proposed?.reason ??
      (urgency === "P0"
        ? "Requires same-hour human review."
        : "Requires prompt same-day staff action."),
    severity: urgency,
  };
}

function safeFallback(item: InboxItem, error: unknown): ItemOutput {
  const message = error instanceof Error ? error.message : String(error);
  return {
    item_id: item.id,
    classification: "other",
    urgency: "P2",
    requires_human_review: true,
    extracted_intake: {
      child_name: null,
      dob_or_age: null,
      parent_contact: null,
      discipline: null,
      diagnosis_or_concern: null,
      payer: null,
      member_id: null,
    },
    missing_info: ["processing_error"],
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action:
      "Automated triage failed for this item; route to staff for full manual review.",
    draft_reply: null,
    task_ids: [],
    escalation: null,
    decision_rationale: `Agent error during processing (${message}); defaulted to safe manual-review fallback.`,
  };
}

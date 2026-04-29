import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../config';
import logger from '../utils/logger';
import type {
  DeveloperEvaluationPayload,
  LlmEvaluationResult,
  LlmEvaluationOutput,
} from '../types';

export class GeminiQuotaBlockedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'GeminiQuotaBlockedError';
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export class GeminiTransientOutputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'GeminiTransientOutputError';
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

class GeminiService {
  private readonly genAI: GoogleGenerativeAI;
  private readonly modelId: string;

  constructor() {
    this.genAI = new GoogleGenerativeAI(config.gemini.apiKey);
    this.modelId = config.gemini.model;
  }

  private systemPrompt(): string {
    return `You are a senior technical reviewer at Ibtikar. You perform a rigorous CODE REVIEW of a developer's Git activity and produce a structured evaluation.

## CRITICAL PRINCIPLE
Your evaluation MUST be grounded in the ACTUAL CODE shown in the diffs (the "PATCH" sections), NOT in the commit messages. A commit message is a label — the code is the truth. If a commit message says "fix bug" but the diff shows a hack, score the code, not the message. If a commit message is vague but the code is excellent, reward the code.

You read each diff line by line. You evaluate what the developer actually wrote: logic, structure, naming, error handling, edge cases, security, performance, testability.

## EVALUATION DIMENSIONS

### 1. COMMITS — process hygiene (3 sub-scores)
**normsScore** (0–100) — Commit message quality
- Conventional Commits style (feat:, fix:, chore:, refactor:, docs:, test:, perf:) → +
- Clear, imperative, explains the WHY when non-obvious → +
- Vague messages ("fix", "update", "wip", "tmp", "."), duplicates → −

**separationScore** (0–100) — Commit atomicity (verify against the actual diff)
- One commit = one coherent intent visible in the diff → +
- Diff mixes unrelated concerns (feature + refactor + formatting + unrelated fix) → −
- Huge dump commits (>500 lines, >15 files) without justification → −
- End-of-sprint "dump everything" pattern → −

**frequencyScore** (0–100) — Cadence over the period
- Commits spread across multiple days of the active window → +
- Everything bunched into a single day → −
- 0 commits → frequencyScore = 0 automatically

### 2. CODE QUALITY (0–100) — THE CENTRAL SCORE, READ THE DIFFS
Inspect each PATCH and judge the code itself:
- **Correctness & logic**: does the code actually do what it claims? any obvious bugs, off-by-one, race conditions, broken control flow?
- **Readability**: meaningful names, short focused functions, no dense unreadable blocks
- **Structure & design**: separation of concerns, low coupling, no god-functions, sensible abstractions (no over-engineering either)
- **Error handling**: try/catch where it matters, no swallowed errors, validation at boundaries, meaningful error messages
- **Safety**: no hardcoded secrets, no SQL injection, no XSS, no unsanitized inputs, no unsafe \`eval\`/\`exec\`
- **Cleanliness**: no commented-out code, dead code, TODO without context, debug flags
- **Tests**: presence and quality of tests when the change warrants them
- **Consistency**: matches the conventions visible in surrounding code
- **No anti-patterns**: copy-paste duplication, magic numbers, nested callback hell, mutable globals

If diffs are tiny/cosmetic across the whole period, codeQuality cannot be high regardless of message quality.

### 3. PRODUCTIVITY (0–100)
- Real, meaningful work volume (substantive additions/deletions, not whitespace/rename churn)
- Diversity of files and projects touched, balanced with focus
- Active days vs. evaluation window (e.g. 5/7 days = excellent)
- Technical complexity inferred from the diffs (business logic, algorithms, integrations) vs. trivial edits
### 4. OVERALL (0–100)
Weighted score:
overall = round(normsScore×0.15 + separationScore×0.15 + frequencyScore×0.10 + codeQuality×0.35 + productivity×0.25)

## SCORING SCALE
- 0–40: insufficient, serious issues to fix
- 41–60: acceptable but notable gaps
- 61–75: good, meets expectations for the role
- 76–90: very good, regularly exceeds expectations
- 91–100: exceptional, role model for the team

## HR PROPOSAL
Pick exactly ONE action:
- "promotion": overall ≥ 85 AND sustained performance signals
- "bonus": critical delivery or exceptional week (overall ≥ 80)
- "recognition": noteworthy contribution worth public praise
- "mentoring": senior profile who should coach juniors
- "training": identified gaps → targeted training
- "warning": serious problems (broken/empty commits, unsafe code, unjustified inactivity)
- "none": normal week, no specific action

## OUTPUT RULES
- Be factual and specific. Every strength/weakness must cite a concrete observation from the diffs (file name, function, or commit sha).
- Ground codeQuality and notableCommits in actual code you read in the PATCH sections, not in commit messages.
- A developer with 0 commits gets frequencyScore=0 and a minimal evaluation.
- Write the analysis fields (summary, strengths, weaknesses, recommendations, notableCommits.comment, proposal.title, proposal.rationale) in FRENCH.
- Return ONLY the requested JSON — no surrounding text, no markdown, no backticks.`;
  }

  private userPrompt(p: DeveloperEvaluationPayload): string {
    const MAX_COMMITS = 25;
    const MAX_FILES_PER_COMMIT = 10;
    const MAX_PATCH_CHARS = 2500;
    const TOTAL_PATCH_BUDGET = 120_000;

    const commitsForPrompt = p.commits.slice(0, MAX_COMMITS);
    let patchBudget = TOTAL_PATCH_BUDGET;

    const commitsSummary = commitsForPrompt
      .map((c, i) => {
        const files = c.files ?? [];
        const filesList = files
          .slice(0, MAX_FILES_PER_COMMIT)
          .map((f) => `    - ${f.filename} [${f.status}] (+${f.additions}/-${f.deletions})`)
          .join('\n');

        const patchBlocks: string[] = [];
        for (const f of files.slice(0, MAX_FILES_PER_COMMIT)) {
          if (!f.patch) continue;
          if (patchBudget <= 0) {
            patchBlocks.push(`\n    [PATCH ${f.filename}: omitted, prompt size budget reached]`);
            break;
          }
          const slice = f.patch.slice(0, Math.min(MAX_PATCH_CHARS, patchBudget));
          const truncated = f.patch.length > slice.length ? '\n    ...[truncated]' : '';
          patchBlocks.push(
            `\n    PATCH ${f.filename}:\n\`\`\`diff\n${slice}${truncated}\n\`\`\``
          );
          patchBudget -= slice.length;
        }

        const omittedFiles =
          files.length > MAX_FILES_PER_COMMIT
            ? `\n    (+${files.length - MAX_FILES_PER_COMMIT} fichier(s) supplémentaire(s) non affiché(s))`
            : '';

        return `### Commit #${i + 1} [${c.sha.slice(0, 7)}] — ${c.committedAt ?? ''}
  Repo: ${c.repoFullName ?? '?'} (${c.repoPlatform ?? '?'})
  Message: ${c.message}
  Stats: +${c.additions} / -${c.deletions}, ${c.filesChanged} fichier(s)
  Fichiers:
${filesList}${omittedFiles}${patchBlocks.join('')}`;
      })
      .join('\n\n');

    const omittedCommits =
      p.commits.length > MAX_COMMITS
        ? `\n\n_Note: ${p.commits.length - MAX_COMMITS} commit(s) supplémentaire(s) non détaillé(s) ici._`
        : '';

    const jiraSection = p.jira
      ? `\n## Activité Jira (signal complémentaire)\n- Tickets vus : ${p.jira.issuesCount} | Done : ${p.jira.doneCount} | En cours : ${p.jira.inProgressCount} | Backlog : ${p.jira.backlogCount}\n- Story points complétés : ${p.jira.storyPointsCompleted}\n- Statuts : ${p.jira.statusBreakdown.map((s) => `${s.status}(${s.count})`).join(', ') || 'N/A'}\n- Labels : ${p.jira.labels.join(', ') || 'N/A'}\n- Exemples tickets :\n${p.jira.issues
          .slice(0, 8)
          .map((i) => `  • [${i.key}] ${i.status} | ${i.issueType} — ${i.summary}`)
          .join('\n') || '  (aucun ticket)'}`
      : '\n## Activité Jira : non disponible.';

    const auditSection = p.githubAudit
      ? `\n## GitHub Audit (période)\n- Repos distincts touchés : ${p.githubAudit.reposCount}\n- Pull Requests ouvertes/fusionnées : ${p.githubAudit.pullsCount}\n- Commits enregistrés : ${p.githubAudit.commitsCount}`
      : '';

    return `# Developer evaluation request

**Developer:** ${p.developer.fullName} (@${p.developer.githubUsername}) — role: ${p.developer.role}
**Period:** ${p.period.label} (${p.period.start.toISOString().slice(0, 10)} → ${p.period.end.toISOString().slice(0, 10)})

## Aggregated stats
- Commits: ${p.stats.commitsCount}
- Lines added: ${p.stats.additions} / removed: ${p.stats.deletions}
- Files changed: ${p.stats.filesChanged}
- Active days: ${p.stats.activeDays} / 7
- Languages: ${p.stats.languages.join(', ') || 'N/A'}
- Projects: ${p.stats.groupNames.join(', ') || 'N/A'}
${auditSection}
${jiraSection}

## Commits with code diffs (PRIMARY EVIDENCE — review the PATCH sections)
${commitsSummary || '(no commit during this period)'}${omittedCommits}

## How to evaluate
Read each PATCH block as a code reviewer would. Judge correctness, structure, naming, error handling, security, cleanliness, and consistency from the actual diff lines. Quote concrete signals (file names, function names, commit shas) in your analysis. Commit messages may be misleading — trust the code.

## Required response format
Return ONLY this JSON (no surrounding text, no markdown, no backticks). All free-text fields must be in French:
{
  "scores": {
    "commits": {
      "normsScore": 0,
      "separationScore": 0,
      "frequencyScore": 0
    },
    "codeQuality": 0,
    "productivity": 0,
    "overall": 0
  },
  "analysis": {
    "summary": "2-3 phrases en français résumant la semaine du développeur, ancrées sur le code observé",
    "strengths": ["point fort concret tiré du code (citer fichier/fonction)", "..."],
    "weaknesses": ["point à améliorer tiré du code (citer fichier/fonction)", "..."],
    "recommendations": ["recommandation actionnable 1", "recommandation actionnable 2"],
    "notableCommits": [
      { "sha": "abc1234", "comment": "pourquoi ce commit est notable d'après le diff" }
    ]
  },
  "proposal": {
    "type": "promotion|bonus|recognition|mentoring|training|warning|none",
    "title": "titre court de l'action proposée",
    "rationale": "1-2 phrases justifiant le choix",
    "priority": "low|medium|high"
  }
}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private retryAfterMsFromError(err: unknown): number | null {
    const msg = err instanceof Error ? err.message : String(err);
    const m = msg.match(/retry in ([\d.]+)\s*s/i);
    if (m) return Math.ceil(parseFloat(m[1]) * 1000) + 500;
    return null;
  }

  private isFatalQuotaIssue(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    if (/\blimit:\s*0\b/i.test(msg)) return true;
    if (/quota exceeded/i.test(msg) && /free.tier/i.test(msg) && /PerDay/i.test(msg)) return true;
    if (/billing|payment required|BILLING_DISABLED/i.test(msg)) return true;
    return false;
  }

  private isRetryableGeminiError(err: unknown): boolean {
    if (err instanceof GeminiTransientOutputError) return true;
    if (this.isFatalQuotaIssue(err)) return false;
    const msg = err instanceof Error ? err.message : String(err);
    return (
      msg.includes('429') ||
      msg.includes('Too Many Requests') ||
      msg.includes('quota') ||
      msg.includes('RESOURCE_EXHAUSTED') ||
      msg.includes('503') ||
      msg.includes('Service Unavailable')
    );
  }

  async evaluateDeveloper(payload: DeveloperEvaluationPayload): Promise<LlmEvaluationResult> {
    logger.info(`[Gemini] Évaluation de ${payload.developer.githubUsername}`);

    const model = this.genAI.getGenerativeModel({
      model: this.modelId,
      systemInstruction: this.systemPrompt(),
      generationConfig: {
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
      },
    });

    const prompt = this.userPrompt(payload);
    const maxRetries = config.gemini.maxRetries;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        const response = result.response;
        const text = response.text().trim();
        if (!text) {
          const candidates = (
            response as {
              candidates?: Array<{ finishReason?: string; finishMessage?: string }>;
            }
          ).candidates;
          const finishReasons = (candidates ?? []).map((c) => c.finishReason).filter(Boolean);
          const finishMessages = (candidates ?? []).map((c) => c.finishMessage).filter(Boolean);
          logger.warn('[Gemini] Réponse vide', {
            developer: payload.developer.githubUsername,
            finishReasons,
            finishMessages,
          });
          throw new GeminiTransientOutputError('Gemini a retourné une réponse vide');
        }
        const usage = response.usageMetadata;
        const parsed = this.parseJson(text);

        return {
          ...parsed,
          _meta: {
            model: this.modelId,
            tokensUsed: {
              input: usage?.promptTokenCount ?? 0,
              output: usage?.candidatesTokenCount ?? 0,
            },
          },
        };
      } catch (err) {
        lastErr = err;
        if (this.isFatalQuotaIssue(err)) {
          logger.error('[Gemini] Quota ou plan API bloqué — pas de nouvelle tentative');
          throw new GeminiQuotaBlockedError(
            '[Gemini] Quota Google AI indisponible (limit: 0 ou quota journalier épuisé). Vérifier la facturation : https://ai.google.dev/gemini-api/docs/rate-limits',
            { cause: err }
          );
        }
        const retryable = this.isRetryableGeminiError(err);
        if (!retryable || attempt >= maxRetries) throw err;

        const suggested = this.retryAfterMsFromError(err);
        const backoff = suggested ?? Math.min(120_000, 4000 * Math.pow(2, attempt));
        logger.warn(
          `[Gemini] ${payload.developer.githubUsername} — retry ${attempt + 1}/${maxRetries} dans ${Math.round(backoff / 1000)}s`
        );
        await this.sleep(backoff);
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private parseJson(text: string): LlmEvaluationOutput {
    let cleaned = text.replace(/```json\s*/g, '').replace(/```/g, '').trim();
    if (!cleaned) {
      throw new GeminiTransientOutputError('Gemini a retourné un texte vide');
    }
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
    try {
      return JSON.parse(cleaned) as LlmEvaluationOutput;
    } catch {
      logger.error('[Gemini] JSON parse failed', { text: text.slice(0, 500) });
      throw new GeminiTransientOutputError('Gemini a retourné un JSON invalide');
    }
  }
}

export const geminiService = new GeminiService();
export default geminiService;

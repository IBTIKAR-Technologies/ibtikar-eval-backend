import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../config';
import logger from '../utils/logger';
import type {
  DeveloperEvaluationPayload,
  LlmEvaluationResult,
  LlmEvaluationOutput,
} from '../types';

/** Quota / facturation Google insuffisant — les retries ne servent à rien. */
export class GeminiQuotaBlockedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'GeminiQuotaBlockedError';
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
    return `Tu es un évaluateur technique senior chez Ibtikar, spécialisé dans l'analyse de code et la gestion des performances développeurs.

Tu reçois les commits d'un développeur sur une semaine. Tu dois produire une évaluation STRICTEMENT au format JSON demandé, sans texte avant ou après, sans markdown, sans backticks.

Critères d'évaluation (chacun noté de 0 à 100) :
1. codeQuality : lisibilité, nommage, structure, gestion d'erreurs, absence de duplication
2. commitFrequency : régularité du travail (commits étalés vs tout en un jour), taille raisonnable
3. conventionAdherence : messages de commit clairs (conventional commits), cohérence style
4. technicalComplexity : ampleur et difficulté technique du travail

Ensuite tu proposes UNE action RH/technique moderne adaptée :
- "promotion" : performance exceptionnelle soutenue
- "bonus" : semaine particulièrement productive ou livraison critique
- "recognition" : féliciter publiquement (slack, all-hands)
- "mentoring" : le dev devrait coacher les juniors
- "training" : lacunes identifiées → formation ciblée
- "warning" : problèmes sérieux (commits vides, code cassé, inactivité suspecte)
- "none" : semaine normale sans action particulière

Sois juste, factuel, bienveillant mais honnête. Appuie-toi sur les données fournies.`;
  }

  private userPrompt(p: DeveloperEvaluationPayload): string {
    const commitsSummary = p.commits
      .map((c, i) => {
        const filesStr = (c.files ?? [])
          .slice(0, 5)
          .map((f) => `    - ${f.filename} (+${f.additions}/-${f.deletions})`)
          .join('\n');
        const patchExcerpt = (c.files ?? [])
          .slice(0, 3)
          .map((f) => (f.patch ? `\n    PATCH ${f.filename}:\n${f.patch.slice(0, 1200)}` : ''))
          .join('\n');
        return `Commit #${i + 1} [${c.sha.slice(0, 7)}] ${c.committedAt ?? ''}
  Repo: ${c.repoFullName ?? '?'} (${c.repoPlatform ?? '?'})
  Message: ${c.message}
  Stats: +${c.additions} / -${c.deletions}, ${c.filesChanged} fichier(s)
  Fichiers:
${filesStr}${patchExcerpt}`;
      })
      .join('\n\n');

    return `Développeur évalué : ${p.developer.fullName} (@${p.developer.githubUsername}) — rôle: ${p.developer.role}

Période : ${p.period.label} (du ${p.period.start.toISOString().slice(0, 10)} au ${p.period.end.toISOString().slice(0, 10)})

Statistiques agrégées :
- Commits : ${p.stats.commitsCount}
- Lignes ajoutées : ${p.stats.additions}
- Lignes supprimées : ${p.stats.deletions}
- Fichiers modifiés : ${p.stats.filesChanged}
- Jours actifs : ${p.stats.activeDays} / 7
- Langages : ${p.stats.languages.join(', ') || 'N/A'}
- Projets : ${p.stats.groupNames.join(', ') || 'N/A'}

Détail des commits :
${commitsSummary || '(aucun commit cette semaine)'}

Retourne UNIQUEMENT ce JSON (aucun texte autour) :
{
  "scores": {
    "codeQuality": 0,
    "commitFrequency": 0,
    "conventionAdherence": 0,
    "technicalComplexity": 0,
    "overall": 0
  },
  "analysis": {
    "summary": "2-3 phrases en français",
    "strengths": ["point fort 1", "point fort 2"],
    "weaknesses": ["point à améliorer 1"],
    "recommendations": ["recommandation 1", "recommandation 2"],
    "notableCommits": [
      { "sha": "abc1234", "comment": "pourquoi ce commit est notable" }
    ]
  },
  "proposal": {
    "type": "promotion|bonus|recognition|mentoring|training|warning|none",
    "title": "titre court",
    "rationale": "1-2 phrases qui justifient",
    "priority": "low|medium|high"
  }
}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Extrait un délai conseillé dans le message d’erreur Google (ex. retry in 40.39s). */
  private retryAfterMsFromError(err: unknown): number | null {
    const msg = err instanceof Error ? err.message : String(err);
    const m = msg.match(/retry in ([\d.]+)\s*s/i);
    if (m) return Math.ceil(parseFloat(m[1]) * 1000) + 500;
    return null;
  }

  /** Erreur où attendre ne résout rien (facturation, quota jour à 0, modèle indisponible sur le plan). */
  private isFatalQuotaIssue(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    if (/\blimit:\s*0\b/i.test(msg)) return true;
    if (/quota exceeded/i.test(msg) && /free.tier/i.test(msg) && /PerDay/i.test(msg)) return true;
    if (/billing|payment required|BILLING_DISABLED/i.test(msg)) return true;
    return false;
  }

  private isRetryableGeminiError(err: unknown): boolean {
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
        maxOutputTokens: 2048,
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
            '[Gemini] Quota Google AI indisponible pour ce projet/modèle (souvent limit: 0 sur le free tier ou quota journalier épuisé). Vérifie la facturation et les limites : https://ai.google.dev/gemini-api/docs/rate-limits — ou change GEMINI_MODEL / projet API.',
            { cause: err }
          );
        }
        const retryable = this.isRetryableGeminiError(err);
        if (!retryable || attempt >= maxRetries) {
          throw err;
        }
        const suggested = this.retryAfterMsFromError(err);
        const backoff = suggested ?? Math.min(120_000, 4000 * Math.pow(2, attempt));
        logger.warn(
          `[Gemini] ${payload.developer.githubUsername} — erreur quota/réseau, nouvelle tentative ${attempt + 1}/${maxRetries} dans ${Math.round(backoff / 1000)}s`
        );
        await this.sleep(backoff);
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private parseJson(text: string): LlmEvaluationOutput {
    let cleaned = text.replace(/```json\s*/g, '').replace(/```/g, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
    try {
      return JSON.parse(cleaned) as LlmEvaluationOutput;
    } catch {
      logger.error('[Gemini] JSON parse failed', { text: text.slice(0, 500) });
      throw new Error('Gemini a retourné un JSON invalide');
    }
  }
}

export const geminiService = new GeminiService();
export default geminiService;

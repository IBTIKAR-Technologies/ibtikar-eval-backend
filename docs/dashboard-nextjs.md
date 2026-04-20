# Dashboard Next.js — architecture et liaison avec ce backend

Ce document décrit comment développer une **application Next.js séparée** qui affiche les évaluations, développeurs et groupes **en s’alignant sur la même source de données** que l’API Express `ibtikar-eval-backend`.

---

## 1. Deux façons de se connecter aux données

| Approche | Description | Avantages | Inconvénients |
|----------|-------------|-----------|----------------|
| **A. Via l’API REST** | Le dashboard appelle uniquement `http(s)://…/api/*` (backend Express déjà déployé). | Une seule couche métier ; pas de duplication des schémas Mongoose ; CORS déjà prévu (`DASHBOARD_ORIGIN`). | Dépendance réseau ; le backend doit être joignable depuis le navigateur ou depuis les route handlers Next.js. |
| **B. MongoDB direct** | Next.js utilise `MONGODB_URI` identique et des modèles Mongoose (copiés ou package partagé). | Lecture possible sans passer par Express ; latence locale possible en SSR. | Duplication des schémas et du risque de divergence ; écritures à coordonner avec l’API pour éviter les incohérences. |

**Recommandation :** commencer par **l’approche A** pour le dashboard (graphiques, listes, filtres). Réserver **B** uniquement pour des besoins très spécifiques (agrégations lourdes en lecture seule), idéalement dans des **Route Handlers** ou **Server Actions** pour ne pas exposer la chaîne de connexion au navigateur.

---

## 2. Stack UI du dashboard : shadcn/ui + Highcharts

Le frontend du dashboard **doit** utiliser :

| Couche | Paquets | Rôle |
|--------|---------|------|
| **UI & layout** | [**shadcn/ui**](https://ui.shadcn.com/) (Tailwind CSS + Radix UI) | Tables, filtres, cartes, navigation, formulaires — design system unique et accessible. |
| **Graphiques** | **`highcharts-react-official`** + **`highcharts`** (peer) | Séries temporelles (scores par semaine), colonnes ou camemberts (distribution des `proposal`), tableaux de bord stats. |

Ne pas remplacer Highcharts par Recharts ou Chart.js sur ce projet sans décision d’architecture explicite.

### Installation (après `create-next-app`)

```bash
npx shadcn@latest init
npm install highcharts highcharts-react-official
```

Suivre la doc shadcn pour Next.js (App Router) : chemins `components/ui`, alias `@/`, thème clair/sombre si besoin.

### Highcharts et Next.js App Router

Highcharts s’exécute côté client — déclarer les composants qui l’utilisent avec **`'use client'`**, ou charger le chart via `next/dynamic` avec `{ ssr: false }` si vous voyez des erreurs d’hydratation.

Exemple minimal :

```tsx
'use client';

import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';
import { useMemo } from 'react';

type Props = { categories: string[]; data: number[] };

export function OverallScoreChart({ categories, data }: Props) {
  const options = useMemo(
    () =>
      ({
        chart: { type: 'line' },
        title: { text: 'Score overall par période' },
        xAxis: { categories },
        series: [{ name: 'Overall', type: 'line', data }],
        credits: { enabled: false },
      }) satisfies Highcharts.Options,
    [categories, data]
  );
  return <HighchartsReact highcharts={Highcharts} options={options} />;
}
```

### Données branchées sur l’API

| Besoin UI | Endpoint |
|-----------|----------|
| Courbe / timeline par développeur | `GET /api/evaluations/developer/:developerId/timeline` → `data.series` |
| KPI + répartition propositions + top 5 | `GET /api/evaluations/stats/overview` |

Transformez les dates et scores en `categories` / `series` attendus par Highcharts.

### shadcn/ui — composants typiques pour Ibtikar Eval

`Table`, `Card`, `Badge`, `Button`, `Input`, `Select`, `Tabs`, `Skeleton`, `DropdownMenu`, `Sheet` (filtres responsive), `Separator`, `Avatar` (optionnel avec photo GitHub plus tard).

---

## 3. Variables d’environnement (dashboard Next.js)

### Consommation de l’API REST (approche A)

```env
# URL publique ou interne du backend Express (sans slash final)
NEXT_PUBLIC_API_URL=http://localhost:4000

# Si les appels passent par Route Handler Next (serveur uniquement), vous pouvez omettre NEXT_PUBLIC_ et utiliser API_URL pour ne pas exposer l’URL au bundle client.
```

### Côté backend Express (déjà supporté)

Le fichier `.env` du backend doit autoriser l’origine du dashboard :

```env
DASHBOARD_ORIGIN=http://localhost:3000
```

Pour plusieurs origines : lister séparées par des virgules (voir `src/config/index.ts`).

### MongoDB direct (approche B, optionnel)

```env
MONGODB_URI=mongodb://…/ibtikar_eval
```

Utiliser **exactement la même base** que le backend pour voir les mêmes documents (`developers`, `groups`, `repositories`, `commits`, `evaluations`, `cronruns`).

---

## 4. Contrat HTTP actuel du backend

Base URL : `{BACKEND}/api`

Les réponses de succès suivent en général `{ data: … }`. Les listes paginées ajoutent `pagination`. Les erreurs : `{ error: { message, status } }`.

### Santé

| Méthode | Chemin | Rôle |
|---------|--------|------|
| GET | `/api/health` | Vérifier que l’API et la stack sont vivantes. |

### Développeurs

| Méthode | Chemin | Rôle |
|---------|--------|------|
| GET | `/api/developers` | Liste ; query : `active`, `role`, `group`, `q`. |
| GET | `/api/developers/:id` | Détail + 12 dernières évaluations. |
| POST | `/api/developers` | Création. |
| PATCH | `/api/developers/:id` | Mise à jour. |
| DELETE | `/api/developers/:id` | Soft delete (`isActive: false`). |

### Groupes

| Méthode | Chemin | Rôle |
|---------|--------|------|
| GET | `/api/groups` | Liste avec `repositories` et `leads` peuplés. |
| GET | `/api/groups/:id` | Détail. |
| POST | `/api/groups` | Création (`slug` auto si absent). |
| PATCH | `/api/groups/:id` | Mise à jour. |
| POST | `/api/groups/:id/repositories` | Ajouter un repo (`fullName`, `platform`). |

### Évaluations

| Méthode | Chemin | Rôle |
|---------|--------|------|
| GET | `/api/evaluations/stats/overview` | Stats globales dernière période complétée. |
| GET | `/api/evaluations/developer/:developerId/timeline` | Série pour graphiques (~12 dernières semaines). |
| GET | `/api/evaluations` | Liste paginée ; filtres : `developer`, `group`, `periodStart`, `periodEnd`, `minScore`, `proposalType`, `status`. |
| GET | `/api/evaluations/:id` | Détail avec populations (commits limités). |

### Cron (plutôt admin / outillage)

| Méthode | Chemin | Rôle |
|---------|--------|------|
| POST | `/api/cron/trigger` | Lance un cycle en arrière-plan (202). |
| GET | `/api/cron/runs` | Historique des exécutions. |
| GET | `/api/cron/runs/:id` | Détail d’un run. |
| GET | `/api/cron/status` | Dernier run, planning, estimation prochain lundi (selon config). |

---

## 5. Exemples Next.js (App Router)

### Server Component — lecture via `fetch` (cache Next)

```tsx
// app/page.tsx
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export default async function HomePage() {
  const res = await fetch(`${API}/api/evaluations/stats/overview`, {
    next: { revalidate: 60 },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message ?? 'Erreur API');
  return <pre>{JSON.stringify(json.data, null, 2)}</pre>;
}
```

### Route Handler Next — proxy interne (pas d’exposition de l’URL backend au client)

```ts
// app/api/stats/route.ts
import { NextResponse } from 'next/server';

const BACKEND = process.env.API_URL ?? 'http://localhost:4000';

export async function GET() {
  const r = await fetch(`${BACKEND}/api/evaluations/stats/overview`, {
    cache: 'no-store',
  });
  const body = await r.json();
  return NextResponse.json(body, { status: r.status });
}
```

Le navigateur appelle `/api/stats` sur le domaine Next ; seul le serveur Next connaît `API_URL`.

---

## 6. Pages dashboard suggérées

| Page | Endpoints utiles |
|------|------------------|
| Vue d’ensemble | `GET /api/evaluations/stats/overview` |
| Liste développeurs | `GET /api/developers` (+ filtres) |
| Fiche développeur | `GET /api/developers/:id`, timeline `GET /api/evaluations/developer/:id/timeline` |
| Liste évaluations | `GET /api/evaluations` (+ pagination) |
| Détail évaluation | `GET /api/evaluations/:id` |
| Groupes / repos | `GET /api/groups` |
| Admin cron (optionnel) | `GET /api/cron/status`, `GET /api/cron/runs` |

**UI :** listes et filtres avec **shadcn/ui** ; graphiques (scores, répartition des propositions, tendances) avec **Highcharts** (`highcharts` + `highcharts-react-official`).

---

## 7. Sécurité (à prévoir)

- Aujourd’hui l’API Express est **sans authentification utilisateur** sur ces routes : à **ne pas exposer tel quel sur Internet** sans garde (VPN, Basic Auth inverse proxy, ou futures routes protégées).
- Pour un dashboard interne : même réseau / SSO / middleware Next qui vérifie une session avant d’appeler le backend.

---

## 8. Déploiement

- **Backend** : URL stable (ex. `https://api.eval.ibtikar.example`).
- **Next** : `NEXT_PUBLIC_API_URL` ou `API_URL` pointant vers cette URL ; `DASHBOARD_ORIGIN` côté backend = URL du front (ex. `https://eval.ibtikar.example`).
- **MongoDB** : une seule instance/cluster partagée ; sauvegardes et index inchangés côté backend.

---

## 9. Structure de dépôt possible
```
ibtikar-eval/                    # monorepo optionnel
├── ibtikar-eval-backend/      # ce repo (Express + MongoDB)
└── ibtikar-eval-web/      # Next.js : shadcn/ui + highcharts-react-official + highcharts
```

Sans monorepo : deux dépôts Git distincts, même convention d’URL API et même `MONGODB_URI` si vous utilisez l’approche B en complément.

---

## 10. Schémas MongoDB — collections et champs

Les noms de **collections** ci-dessous sont ceux que Mongoose dérive des modèles (pluriel anglais, minuscules), sauf mention contraire. La base par défaut locale est souvent `ibtikar_eval` (`MONGODB_URI`).

### 10.1 Vue des relations

```
Group (1) ──< Repository.group
Group (n) ──< Developer.groups[]
Repository (1) ──< Commit.repository
Developer (1) ──< Commit.developer (optionnel)
Developer (1) ──< Evaluation.developer
Evaluation ──> groups[], repositories[], commits[] (références)
CronRun : indépendant (journal des cycles d’évaluation)
```

---

### 10.2 Collection `developers` (modèle `Developer`)

| Champ | Type | Oblig. | Description |
|-------|------|--------|-------------|
| `_id` | ObjectId | oui | Identifiant MongoDB |
| `fullName` | string | oui | Nom affiché |
| `email` | string | non | Email (index texte avec fullName) |
| `role` | enum | non | `frontend`, `backend`, `fullstack`, `mobile`, `devops`, `lead`, `qa`, `other` (défaut `other`) |
| `department` | string | non | Service / département |
| `githubUsername` | string | oui | Login GitHub, **unique**, indexé (souvent en minuscules côté app) |
| `githubUserId` | number | non | ID numérique GitHub |
| `githubEmails` | string[] | non | Emails associés au compte (matching commits) |
| `isActive` | boolean | non | Défaut `true` ; `false` = soft delete |
| `joinedAt` | Date | non | Défaut `Date.now` |
| `groups` | ObjectId[] | non | Références vers `groups._id` |
| `createdAt` | Date | auto | Timestamps Mongoose |
| `updatedAt` | Date | auto | Timestamps Mongoose |

**Index / contraintes :** `githubUsername` unique ; index texte sur `fullName` + `email` (recherche `$text` possible).

---

### 10.3 Collection `groups` (modèle `Group`)

| Champ | Type | Oblig. | Description |
|-------|------|--------|-------------|
| `_id` | ObjectId | oui | |
| `name` | string | oui | Nom affiché, **unique** |
| `slug` | string | oui | Identifiant URL-friendly, **unique**, indexé (minuscules) |
| `description` | string | non | |
| `client` | string | non | Client / contexte métier |
| `category` | enum | non | `web`, `mobile`, `fullstack`, `api`, `mixed`, `internal`, `other` (défaut `mixed`) |
| `repositories` | ObjectId[] | non | Références vers `repositories._id` (doublon dénormalisé avec `Repository.group`) |
| `leads` | ObjectId[] | non | Références vers `developers._id` (tech leads) |
| `isActive` | boolean | non | Défaut `true` |
| `createdAt` | Date | auto | |
| `updatedAt` | Date | auto | |

---

### 10.4 Collection `repositories` (modèle `Repository`)

| Champ | Type | Oblig. | Description |
|-------|------|--------|-------------|
| `_id` | ObjectId | oui | |
| `fullName` | string | oui | `OrgName/repo-slug`, **unique**, indexé |
| `name` | string | oui | Nom court du repo |
| `githubRepoId` | number | non | ID repo GitHub |
| `platform` | enum | non | `web`, `mobile`, `backend`, `api`, `library`, `infra`, `other` (défaut `other`) |
| `language` | string | non | Langage principal (GitHub API) |
| `defaultBranch` | string | non | Défaut `main` |
| `isPrivate` | boolean | non | Défaut `true` |
| `isArchived` | boolean | non | Défaut `false` |
| `group` | ObjectId | oui | Référence vers **un** `groups._id` |
| `lastScannedAt` | Date | non | Dernier passage du cron fetch |
| `lastCommitSha` | string | non | Dernier SHA vu |
| `createdAt` | Date | auto | |
| `updatedAt` | Date | auto | |

---

### 10.5 Collection `commits` (modèle `Commit`)

| Champ | Type | Oblig. | Description |
|-------|------|--------|-------------|
| `_id` | ObjectId | oui | |
| `sha` | string | oui | Hash du commit, indexé |
| `repository` | ObjectId | oui | Ref `repositories` |
| `group` | ObjectId | non | Ref `groups` (redondant pratique) |
| `developer` | ObjectId | non | Ref `developers` si auteur matché |
| `authorName` | string | non | |
| `authorEmail` | string | non | |
| `authorGithubLogin` | string | non | Login GitHub auteur |
| `message` | string | non | Message de commit |
| `committedAt` | Date | non | Indexé |
| `url` | string | non | URL GitHub du commit |
| `additions` | number | non | Défaut 0 |
| `deletions` | number | non | Défaut 0 |
| `filesChanged` | number | non | Défaut 0 |
| `files` | sous-doc[] | non | `filename`, `status`, `additions`, `deletions`, `patch` (extrait) |
| `analyzed` | boolean | non | Défaut `false` ; passé à `true` après passage LLM |
| `analyzedAt` | Date | non | |
| `createdAt` | Date | auto | |
| `updatedAt` | Date | auto | |

**Contrainte d’unicité :** couple `(sha, repository)` unique — un même SHA ne peut pas être dupliqué pour le même repo.

---

### 10.6 Collection `evaluations` (modèle `Evaluation`)

Une ligne = **une évaluation pour un développeur sur une période** `[periodStart, periodEnd]` (contrainte unique sur `(developer, periodStart, periodEnd)`).

| Champ | Type | Oblig. | Description |
|-------|------|--------|-------------|
| `_id` | ObjectId | oui | |
| `developer` | ObjectId | oui | Ref `developers`, indexé |
| `periodStart` | Date | oui | Début période (ex. semaine), indexé |
| `periodEnd` | Date | oui | Fin période, indexé |
| `periodLabel` | string | non | Libellé lisible (ex. `Semaine 2026-W16`) |
| `groups` | ObjectId[] | non | Refs `groups` concernés |
| `repositories` | ObjectId[] | non | Refs `repositories` |
| `commits` | ObjectId[] | non | Refs `commits` inclus dans l’analyse |
| `stats` | objet | non | `commitsCount`, `additions`, `deletions`, `filesChanged`, `activeDays`, `languages[]` |
| `scores` | objet | non | `codeQuality`, `commitFrequency`, `conventionAdherence`, `technicalComplexity`, `overall` — chaque score 0–100 ; `overall` indexé |
| `analysis` | objet | non | `summary`, `strengths[]`, `weaknesses[]`, `recommendations[]`, `notableCommits[{ sha, comment }]` |
| `proposal` | objet | non | `type` : `promotion`, `bonus`, `training`, `mentoring`, `recognition`, `warning`, `none` ; `title`, `rationale`, `priority` : `low` \| `medium` \| `high` |
| `model` | string | non | Identifiant modèle LLM (ex. `gemini-2.0-flash`) |
| `tokensUsed` | objet | non | `input`, `output` |
| `status` | enum | non | `pending`, `in_progress`, `completed`, `failed`, `skipped` (défaut `pending`), indexé |
| `error` | string | non | Message si échec |
| `createdAt` | Date | auto | |
| `updatedAt` | Date | auto | |

---

### 10.7 Collection `cronruns` (modèle `CronRun`)

Journal d’exécution des cycles **sync GitHub + fetch commits + évaluations LLM**.

> **Note :** le champ tableau d’erreurs s’appelle `errorLog` en base (pas `errors`), pour éviter un conflit avec l’API Mongoose `Document.errors`.

| Champ | Type | Oblig. | Description |
|-------|------|--------|-------------|
| `_id` | ObjectId | oui | |
| `startedAt` | Date | non | Défaut `Date.now` |
| `finishedAt` | Date | non | |
| `status` | enum | non | `running`, `success`, `partial`, `failed` (défaut `running`), indexé |
| `periodStart` | Date | non | Période couverte par le run |
| `periodEnd` | Date | non | |
| `counters` | objet | non | `reposScanned`, `commitsFetched`, `commitsNew`, `developersEvaluated`, `evaluationsCreated`, `errors` (nombre d’erreurs logiques) |
| `errorLog` | `{ at, message }[]` | non | Détail des erreurs (ex. échec par dev) |
| `trigger` | enum | non | `schedule`, `manual`, `startup` (défaut `schedule`) |
| `createdAt` | Date | auto | |
| `updatedAt` | Date | auto | |

---

### 10.8 Types énumérés récapitulatifs (alignés sur `src/types/index.ts`)

- **Rôle dev** : `frontend` \| `backend` \| `fullstack` \| `mobile` \| `devops` \| `lead` \| `qa` \| `other`
- **Catégorie groupe** : `web` \| `mobile` \| `fullstack` \| `api` \| `mixed` \| `internal` \| `other`
- **Plateforme repo** : `web` \| `mobile` \| `backend` \| `api` \| `library` \| `infra` \| `other`
- **Statut évaluation** : `pending` \| `in_progress` \| `completed` \| `failed` \| `skipped`
- **Type proposition RH** : `promotion` \| `bonus` \| `training` \| `mentoring` \| `recognition` \| `warning` \| `none`
- **Priorité** : `low` \| `medium` \| `high`
- **Statut cron** : `running` \| `success` \| `partial` \| `failed`
- **Déclencheur cron** : `schedule` \| `manual` \| `startup`

---

## 11. Références code backend

- Montage des routes : `src/routes/index.ts`
- CORS : `src/server.ts` + `config.dashboard.origins`
- Modèles Mongoose : `src/models/` — **source de vérité** pour les champs ci-dessus (`Developer.ts`, `Group.ts`, `Repository.ts`, `Commit.ts`, `Evaluation.ts`, `CronRun.ts`)

Pour toute évolution du contrat JSON, **faire évoluer l’API Express en premier**, puis adapter le dashboard — évite la duplication de logique métier si vous restez sur l’approche A.

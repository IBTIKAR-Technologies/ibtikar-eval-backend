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

## 2. Variables d’environnement (dashboard Next.js)

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

## 3. Contrat HTTP actuel du backend

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

## 4. Exemples Next.js (App Router)

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

## 5. Pages dashboard suggérées

| Page | Endpoints utiles |
|------|------------------|
| Vue d’ensemble | `GET /api/evaluations/stats/overview` |
| Liste développeurs | `GET /api/developers` (+ filtres) |
| Fiche développeur | `GET /api/developers/:id`, timeline `GET /api/evaluations/developer/:id/timeline` |
| Liste évaluations | `GET /api/evaluations` (+ pagination) |
| Détail évaluation | `GET /api/evaluations/:id` |
| Groupes / repos | `GET /api/groups` |
| Admin cron (optionnel) | `GET /api/cron/status`, `GET /api/cron/runs` |

---

## 6. Sécurité (à prévoir)

- Aujourd’hui l’API Express est **sans authentification utilisateur** sur ces routes : à **ne pas exposer tel quel sur Internet** sans garde (VPN, Basic Auth inverse proxy, ou futures routes protégées).
- Pour un dashboard interne : même réseau / SSO / middleware Next qui vérifie une session avant d’appeler le backend.

---

## 7. Déploiement

- **Backend** : URL stable (ex. `https://api.eval.ibtikar.example`).
- **Next** : `NEXT_PUBLIC_API_URL` ou `API_URL` pointant vers cette URL ; `DASHBOARD_ORIGIN` côté backend = URL du front (ex. `https://eval.ibtikar.example`).
- **MongoDB** : une seule instance/cluster partagée ; sauvegardes et index inchangés côté backend.

---

## 8. Structure de dépôt possible

```
ibtikar-eval/                 # monorepo optionnel
├── ibtikar-eval-backend/   # ce repo (Express)
└── ibtikar-eval-dashboard/ # nouveau projet create-next-app
```

Sans monorepo : deux dépôts Git distincts, même convention d’URL API et même `MONGODB_URI` si vous utilisez l’approche B en complément.

---

## 9. Références code backend

- Montage des routes : `src/routes/index.ts`
- CORS : `src/server.ts` + `config.dashboard.origins`
- Modèles Mongoose : `src/models/`

Pour toute évolution du contrat JSON, **faire évoluer l’API Express en premier**, puis adapter le dashboard — évite la duplication de logique métier si vous restez sur l’approche A.

# Déploiement Docker (production)

Ce projet peut tourner en production avec Docker Compose :

- `app` : backend Node.js/TypeScript compilé
- `mongo` : MongoDB 7 avec volume persistant

## 1) Préparer l'environnement

1. Copier/mettre à jour `.env` (racine du projet) avec au minimum :

```env
PORT=4000
NODE_ENV=production
MONGODB_URI=mongodb://mongo:27017/ibtikar_eval
GITHUB_TOKEN=...
GITHUB_ORG=IBTIKAR-Technologies
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.0-flash
CRON_SCHEDULE=0 2 * * 1
CRON_TIMEZONE=Africa/Nouakchott
DASHBOARD_ORIGIN=https://dashboard.example.com
```

2. Vérifier que les quotas Gemini sont disponibles (sinon évaluations LLM en échec).

## 2) Build + lancement

```bash
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

## 3) Vérification

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f app
curl http://localhost:4000/api/health
```

## 4) Arrêt / mise à jour

```bash
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up -d
```

## 5) Notes production

- Les données MongoDB persistent dans le volume `mongo_data`.
- L'application écoute sur le port `4000` (mapping `4000:4000`).
- Le cron hebdomadaire s'exécute dans le conteneur `app`.
- Exposer l'API derrière un reverse proxy TLS (Nginx, Traefik, Caddy).

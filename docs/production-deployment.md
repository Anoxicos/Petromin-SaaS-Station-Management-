# Référence de déploiement sur machine virtuelle cloud

Cette référence décrit un déploiement portable sur une machine virtuelle Linux unique. Elle ne vaut ni choix d’un fournisseur cloud ni autorisation de mise en production. Avant d’y placer des données client, il faut convenir des exigences relatives à la machine virtuelle, au stockage, à la destination de sauvegarde, à la localisation des données, à la disponibilité, au RPO/RTO, à la conservation, aux incidents et à l’assistance.

## Avant le déploiement

- Choisir un fournisseur cloud et une région conformes aux exigences juridiques et client concernant la localisation des données ; créer une machine virtuelle avec stockage persistant chiffré et pare-feu n’autorisant en entrée que TCP 80/443.
- Faire pointer le domaine de déploiement vers la machine et attendre la propagation DNS. Caddy obtient et renouvelle le certificat TLS ; les ports 80 et 443 doivent être accessibles.
- Créer dans Auth0 une application Web classique et une API pour le domaine de production. Ajouter `https://<domain>/auth/callback` aux URL de rappel autorisées et configurer l’audience de l’API de production.
- Copier `.env.production.example` vers `.env.production`, remplacer chaque valeur fictive et limiter l’accès au compte de déploiement (`chmod 600 .env.production`). Utiliser des secrets forts et distincts pour `POSTGRES_PASSWORD` et `STATION_APP_PASSWORD` ; ne pas ajouter le fichier renseigné au contrôle de version.
- Configurer `OFFSITE_RESTIC_REPOSITORY` et un `RESTIC_PASSWORD` unique pour un dépôt Restic chiffré situé hors de la machine virtuelle. Les dépôts compatibles S3 utilisent une URI `s3:` ; fournir dans l’environnement la clé d’accès compatible AWS, le secret, éventuellement le jeton de session et la région correspondante. Ne réutilisez ni un compartiment ni des identifiants nécessaires à l’administration de la machine virtuelle de production.
- Laisser les variables de conservation hors site vides tant que la politique fournisseur/client n’est pas approuvée ; sans valeur, tous les instantanés de reprise sont conservés. Si une politique est approuvée, configurez une ou plusieurs valeurs `OFFSITE_KEEP_LAST`, `OFFSITE_KEEP_DAILY`, `OFFSITE_KEEP_WEEKLY`, `OFFSITE_KEEP_MONTHLY` ou `OFFSITE_KEEP_YEARLY`. Elles régissent les instantanés de reprise et ne définissent pas la durée légale de conservation des dossiers clients.
- Configurer la fréquence de sauvegarde approuvée et, une fois convenus, des objectifs positifs `RPO_TARGET_SECONDS` et `RTO_TARGET_SECONDS`. Si un dépôt distant est configuré, le contrôle de santé du service de sauvegarde exige des instantanés locaux et hors site récents. Restaurez le dépôt distant vers une nouvelle base de données avec `docker compose --env-file .env.production -f compose.production.yaml -p station-platform-prod exec backup sh /scripts/restore-offsite.sh station_platform_offsite_restore`, puis vérifiez un point de données applicatif avant de considérer la reprise comme démontrée.

## Démarrage et inspection

Depuis le répertoire du dépôt, conservez le même nom de projet dans chaque commande afin de rattacher les volumes persistants :

```sh
docker compose --env-file .env.production -f compose.production.yaml -p station-platform-prod up --build -d
docker compose --env-file .env.production -f compose.production.yaml -p station-platform-prod ps
```

La base de données n’est publiée sur aucun port de l’hôte. Seul le proxy Caddy expose les ports 80 et 443. L’application utilise une image de production compilée et s’exécute sans privilèges ; l’initialisation de la base utilise des mots de passe distincts pour l’administrateur et l’exécution. Les migrations sont terminées avant le démarrage de l’application. Le service Prometheus privé collecte les métriques à `http://app:9464/metrics` et conserve les métriques agrégées dans son propre volume. En production, sa console n’est accessible que sur le réseau Compose privé ; ne lui ajoutez aucune publication publique. La règle fournie enregistre l’indisponibilité d’une cible ; le routage des notifications externes, les seuils d’alerte et les objectifs de niveau de service restent à convenir.

Avant l’intégration, vérifiez `https://<domain>/health`, l’état des conteneurs et le service de sauvegarde. Le point de santé vérifie la connexion à la base ; il ne signifie pas que le compte Auth0, les paramètres légaux, la sauvegarde hors site ou l’acceptation client sont prêts. N’effectuez l’initialisation ponctuelle du super-administrateur qu’après la connexion de la personne concernée et la fourniture de son sujet d’identité vérifié, comme indiqué dans le README.

## Mises à jour et reprise

1. Prenez et vérifiez un instantané récent avant une mise à jour ; conservez l’image et l’instantané précédents.
2. Récupérez ou copiez la révision source examinée, puis réutilisez la commande `docker compose ... up --build -d`. Vérifiez la fin des migrations, la santé des conteneurs, la connexion HTTPS et les scénarios d’acceptation pertinents.
3. Effectuez l’exercice de reprise vers une base de données distincte décrit dans le guide d’exploitation. Lorsque des objectifs de reprise approuvés sont configurés, l’exercice compare l’âge observé de l’instantané et la durée de restauration à ces objectifs.
4. Conservez séparément les preuves de reprise locale et hors site. Un instantané sur la même machine virtuelle ne protège pas contre la perte de l’hôte ou du stockage. Effectuez et consignez une restauration distante ; ne déclarez pas M13 terminé sur la seule base de la configuration du dépôt ou de tests locaux.

Utilisez `docker compose ... logs` pour consulter les journaux des conteneurs. Réservez l’accès au shell et à la base aux opérateurs du fournisseur. N’inscrivez pas de jetons, mots de passe, données client ou contenu de facture dans les journaux de déploiement ni les messages d’assistance.

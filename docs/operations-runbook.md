# Guide d’exploitation de la plateforme des stations

Ce guide concerne le prototype actuel sous Docker/PostgreSQL. L’hébergement de production, les horaires d’assistance, l’objectif de disponibilité, la politique de sauvegarde hors site, le RPO et le RTO ne sont pas convenus ; ne présentez pas les contrôles du prototype local comme des garanties de production.

## Contrôles réguliers des services

- Vérifiez `docker compose ps` et confirmez que la base de données et l’application sont en bonne santé. Le contrôle de l’application appelle `/health` et confirme que celle-ci peut joindre PostgreSQL.
- L’application expose aussi des métriques texte Prometheus sur le port `9464` de son écouteur privé Docker. Le service Prometheus fourni interroge `http://app:9464/metrics` toutes les 15 secondes. Il fournit des compteurs bornés par catégorie de route, méthode et classe de statut, des plages de latence, des jauges de mémoire/durée du processus et du pool de connexions à la base, sans étiquettes de client, utilisateur, URL ou transaction. L’écouteur n’est pas publié sur l’hôte et ne passe pas par Caddy. Les compteurs repartent de zéro au redémarrage de l’application.
- Prometheus interroge l’application et son propre état toutes les 15 secondes. Vérifiez son état de santé et la cible `station-platform-app` dans `/targets` ; la règle `StationPlatformMetricsTargetUnavailable` se déclenche après une minute d’échec des interrogations. `monitoring/prometheus.yml` configure une conservation locale de 15 jours pour les métriques agrégées ; toute autre durée requise par la politique de télémétrie du fournisseur doit être examinée par les opérations. En production, le port de la console est privé et aucune destination Alertmanager n’est configurée.
- Les journaux de requêtes de l’application sont des objets JSON séparés par des sauts de ligne ; ils contiennent un identifiant de requête, la méthode, une catégorie de route fixe, le statut de réponse et la durée. Les réponses incluent le même `X-Request-Id`. Les chemins, paramètres de requête, corps, identifiants de compte et en-têtes sont volontairement exclus. Utilisez l’identifiant pour relier un signalement aux résultats de `docker compose logs` sans copier les données opérationnelles de l’utilisateur.
- Confirmez que le service de sauvegarde est sain. Il ne le devient qu’après la création d’un instantané terminé et si son indicateur de réussite date de moins de deux fois l’intervalle de sauvegarde configuré. Il s’agit d’un indicateur local de fraîcheur, pas d’une preuve de bon fonctionnement de la reprise hors site.
- Examinez `docker compose logs --since=1h app backup db prometheus` pour repérer les erreurs répétées. Ne copiez pas de jetons d’accès, mots de passe, dossiers clients ou contenu de facture dans les notes d’assistance.
- Utilisez la vue d’ensemble du super-administrateur pour les nombres de clients, stations et utilisateurs ainsi que l’état des abonnements et de l’intégration. Pour l’assistance opérationnelle propre à un client, utilisez son espace et son historique d’audit.
- Attribuez les demandes d’assistance uniquement à un compte super-administrateur fournisseur configuré. Les changements ou suppressions d’attribution sont visibles dans la conversation fournisseur ; la base rejette l’attribution à un utilisateur client.

## Livraison et migrations

1. Avant la livraison, exécutez dans CI les contrôles de régression du code et de la base.
2. Gardez les identités de migration PostgreSQL `station_admin`/`station_owner` séparées de l’identité d’exécution `station_app`.
3. Avant toute modification du schéma de production, créez et vérifiez un instantané récent. Appliquez les migrations suivies par le service de migration et confirmez le numéro de migration dans le schéma obtenu.
4. Déployez la compilation correspondante de l’application et vérifiez `/health`, l’état de l’application et de la sauvegarde, les interrogations Prometheus et l’accès authentifié à l’espace.
5. Conservez l’image applicative et l’instantané précédents jusqu’à acceptation de la livraison. Le plan de retour arrière doit tenir compte des migrations à sens unique et des écritures intervenues depuis le déploiement.

## Exercice de sauvegarde et restauration

Dans le prototype local, le service de sauvegarde crée un instantané dès son démarrage, puis répète l’opération selon `BACKUP_INTERVAL_SECONDS` (24 heures par défaut). Il remplace de façon atomique le dernier instantané achevé et conserve le fichier précédent si l’export échoue.

Pour tester la reprise sans remplacer la base active :

1. Confirmez que le service de sauvegarde est sain et qu’un instantané récent a été créé avec succès.
2. Choisissez un nouveau nom de base correspondant à `^[a-z][a-z0-9_]{2,62}$` ; le script de restauration refuse une cible existante.
3. Restaurez avec `docker compose exec backup sh /scripts/restore-latest.sh station_platform_restore_YYYYMMDD`. Le script refuse une destination existante, vérifie que la migration restaurée correspond à la source active, contrôle les tables clés protégées par RLS, confirme la présence de l’échéancier de crédit M3, de l’index d’historique des compteurs M2 et de la devise de collecte quotidienne, et vérifie que `station_app` n’a ni privilège de superutilisateur ni contournement de RLS.
4. Consignez les bornes supérieures prudentes de l’âge de l’instantané et de la durée de restauration calculées par le script. Les intervalles horodatés à la seconde sont arrondis au supérieur, afin que la précision de mesure ne présente pas un résultat comme meilleur qu’il ne l’est. `RPO_TARGET_SECONDS` et `RTO_TARGET_SECONDS` sont des paramètres facultatifs, vides par défaut. Une fois les objectifs approuvés par le fournisseur et le client, inscrivez des durées entières positives dans `.env` ; l’exercice échouera si l’une des bornes supérieures dépasse son objectif. `.env.example` ne présume aucun objectif.
5. Si un dépôt chiffré hors site est configuré, restaurez-le sans remplacer l’instantané local ni la base active : `docker compose exec backup sh /scripts/restore-offsite.sh station_platform_offsite_restore`. Tant que la sauvegarde distante est activée, le contrôle de santé du service exige des instantanés hors site récents.
6. CI exécute `/scripts/recovery-targets-test.sh` pour vérifier les objectifs absents, les valeurs mal formées, nulles ou trop longues ainsi que les limites de mesure inférieure, égale ou supérieure à l’objectif. CI vérifie aussi une sauvegarde Restic chiffrée vers un dépôt local et sa restauration dans une base distincte. Cette intégration ne prouve pas la connectivité à un stockage objet cloud.
7. Effectuez les contrôles de reprise applicatifs convenus et consignez le résultat ainsi que le point de données récupéré. Gardez la base restaurée séparée jusqu’à une décision de reprise autorisée.

L’instantané local est conservé dans un volume Docker sur le même hôte et n’assure pas la protection hors site. Le chemin Restic chiffré prend en charge les dépôts du système de fichiers et compatibles S3 ; les identifiants de production, la connectivité au point de terminaison, l’examen de la région et de la localisation des données, les objectifs et une véritable restauration distante nécessitent encore le déploiement. Aucun RPO/RTO contractuel n’est actuellement défini ; obtenir les mêmes valeurs dans un test local ne prouve pas la capacité de reprise en production.

## Incident d’authentification ou d’accès

- Avant de modifier des appartenances client, vérifiez le service et la configuration Auth0, la santé de l’application et l’expiration des jetons/sessions.
- En cas de suspicion d’accès croisé entre clients, interrompez le trafic client, préservez les journaux d’audit et de service pertinents, relevez les identifiants de requête et la période touchée, puis suivez le processus d’incident contractuel lorsqu’il sera défini. N’envoyez pas de secrets ni de données personnelles dans les messages ordinaires d’assistance.
- Révoquez ou corrigez l’appartenance d’un utilisateur via la route administrateur auditée. Ne modifiez pas directement une facture émise, un relevé validé, une journée clôturée, un mouvement de stock, un grand livre de paiement, un enregistrement importé, un instantané de relevé de facturation ni une preuve d’intégration : utilisez le parcours de rectification ou d’annulation prévu.
- Avant le lancement, consignez dans le contrat les rôles d’intervention, les obligations de notification client et les délais de réponse. Ces conditions restent à définir.

## Intégration et transfert au client

- Créez uniquement un compte propriétaire déjà authentifié et vérifié par Auth0. Créez le client et ses stations avec le mode de compteur, le fuseau horaire et l’heure de coupure confirmés. Laissez la convention de délimitation de la journée vide jusqu’à confirmation par les opérations de la station.
- Utilisez la liste de contrôle attribuée aux rôles pour suivre les règles de station, produits/tarifs, équipements/étalonnage, profil financier, règles de stock, rapprochement de l’historique, confidentialité/conservation, formation/assistance et acceptation du pilote. Une tâche ne peut être terminée qu’avec une note ; seuls les super-administrateurs peuvent y déroger en indiquant un motif.
- Ne considérez pas une liste de contrôle terminée comme un substitut à l’approbation juridique/comptable, au rapprochement de l’historique source, à l’acceptation REC authentifiée ou à une décision de pilote signée.
- Gardez les connecteurs ERP propres au client, l’import de fichiers bancaires, la configuration de facturation légale, les montants des frais et les engagements d’assistance dans le périmètre convenu séparément.

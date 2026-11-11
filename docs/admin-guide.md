# Guide d’administration client et plateforme

Ce guide décrit les réglages administratifs disponibles dans le prototype actuel. Il ne remplace ni les procédures opérationnelles du client, ni un avis juridique, ni un contrat de service convenu.

## Configuration du propriétaire et du responsable client

1. Un super-administrateur fournisseur crée le client à partir d’un compte propriétaire déjà authentifié et vérifié. Ne créez jamais un compte en devinant une identité ou une adresse électronique.
2. Examinez la liste de contrôle d’intégration et attribuez chaque tâche au rôle client responsable. Consignez les éléments justificatifs ; ne dérogez à une tâche qu’en indiquant un motif.
3. Créez chaque station avec son mode de compteur, son fuseau horaire, son heure de coupure et sa convention de délimitation de la journée, tous confirmés. Ces valeurs doivent être explicites : ne choisissez pas une valeur par commodité.
4. Ajoutez les produits, affectez-les aux stations et saisissez les tarifs à effet daté fournis par le client.
5. Créez les équipements et consignez les affectations pompe/pistolet/cuve. Saisissez les points réels du barème d’étalonnage des cuves avant d’utiliser les conversions de jaugeage. Enregistrez les remplacements ou remises à zéro de compteur avec le parcours autorisé et motivé.
6. Ajoutez les membres du personnel et leurs accès aux stations en leur accordant uniquement les droits nécessaires.
7. Configurez les clients, comptes de crédit, bons, fournisseurs, recettes de prestation et stocks d’ouverture uniquement à partir de données sources approuvées par le client.
8. Le comptable doit fournir et approuver les règles de facturation avant l’activation de l’émission de factures légales.

## Imports d’historique et archives

Les propriétaires, responsables et comptables peuvent préparer des fichiers CSV/XLSX, examiner la validation des lignes et confirmer explicitement un lot entièrement valide. Après confirmation, utilisez la recherche d’archives pour filtrer par plage de dates, station ou type exact d’écriture. Les résultats anciens sont chargés par pages et chaque page affichée peut être téléchargée en CSV. L’archive est immuable et ne crée ni factures ni ventes. Avant d’importer l’historique d’un client, convenez de la période maximale, du rapprochement avec les sources et de la personne responsable de la numérisation des documents papier ; la limite technique de taille d’un lot ne constitue pas cette limite métier.

## Rôles et actions sensibles

- Les caissiers saisissent les relevés, comptages et ventes du quotidien dans les stations auxquelles ils ont accès.
- Les propriétaires et responsables administrent la configuration des stations et approuvent les dérogations de crédit autorisées en indiquant un motif.
- Les comptables examinent les paramètres financiers et accèdent aux vues financières et d’audit qui leur sont permises.
- Les super-administrateurs du fournisseur créent les clients et les accompagnent depuis l’administration de la plateforme.

L’autorisation côté serveur et les règles de sécurité au niveau des lignes PostgreSQL appliquent les limites entre clients et stations. Consultez l’historique d’audit pour examiner les opérations sensibles. Les événements d’audit sont ajoutés sans possibilité de modification. Ne partagez pas de comptes pour contourner les restrictions de rôle.

## Forfaits, abonnements et assistance

Les tarifs des forfaits, devises, dates d’effet et jour/fuseau horaire de facturation des abonnements doivent être renseignés explicitement. Les abonnements sont conditionnés à un contrat. L’examen interne d’un relevé ne constitue ni une facture légale émise ni une preuve de paiement. Les connecteurs ERP et l’import de fichiers bancaires font l’objet d’un périmètre distinct.

Les demandes d’assistance fournisseur ne peuvent être attribuées qu’aux super-administrateurs fournisseur configurés. Avant le lancement, définissez dans les conditions client les horaires, canaux et délais de réponse, ainsi que les engagements de disponibilité, de conservation et de reprise.

## Sécurité et reprise

Consultez le [guide d’exploitation](operations-runbook.md) pour les contrôles de service, migrations, sauvegardes, exercices de restauration et gestion des incidents. La santé Docker locale et les instantanés conservés sur le même hôte sont des contrôles de développement ; ils ne garantissent ni la disponibilité en production ni la reprise après sinistre hors site. Conservez les secrets de compte dans le coffre configuré ; ne les inscrivez jamais dans les notes client ni dans la documentation.

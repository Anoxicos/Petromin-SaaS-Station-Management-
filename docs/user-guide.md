# Guide d’utilisation de la plateforme des stations

Ce guide décrit les parcours disponibles dans le prototype actuel. Les écrans et actions accessibles dépendent du client, de la station et du rôle qui vous sont attribués. Utilisez la date métier configurée pour la station et suivez les procédures locales pour les comptages de caisse et de stock.

## Démarrer une journée de station

1. Connectez-vous, puis ouvrez l’espace du bon client et de la bonne station.
2. Vérifiez la station et la date métier affichées dans l’écran des opérations quotidiennes. Le fuseau horaire et l’heure de coupure configurés pour la station déterminent la journée métier.
3. Saisissez les relevés selon le mode configuré : par pistolet, ou par pompe/totalisateur avec une ventilation par produit dont la somme correspond au volume du compteur.
4. Saisissez séparément les totaux en espèces et par carte. Le personnel saisit les totaux carte, qui peuvent être rapprochés du règlement du terminal. Les estimations de ventes calculées à partir des compteurs sont informatives : ne les saisissez pas une seconde fois comme ventes.
5. Saisissez les jaugeages des cuves pour la journée métier. L’application convertit la hauteur à l’aide du barème de jauge actif, uniquement dans la plage fournie.
6. Examinez les alertes et rapprochez les totaux. Un responsable peut effectuer la clôture lorsque toutes les données requises sont présentes.

## Ventes, soldes clients et factures

- Enregistrez une vente avec ses lignes et ses modes de règlement. La transaction enregistrée conserve ses prix et ses montants.
- Utilisez un compte client pour les ventes à crédit. Les ventes dépassant la limite de crédit sont bloquées. Seul un propriétaire ou un responsable autorisé peut saisir un motif de dérogation ; le motif et l’auteur sont conservés dans le grand livre du crédit et l’historique d’audit.
- Si la direction du client a convenu de plusieurs échéances, ajoutez les lignes d’échéance à la vente avant de la comptabiliser. Leur somme doit correspondre à la part à crédit. Si aucun échéancier personnalisé n’est saisi, l’échéance configurée sur le compte devient une échéance unique ; sans condition de paiement configurée, la vente n’a pas d’échéance tant qu’aucune n’est saisie. Aucun intérêt ni frais de retard n’est ajouté.
- Pour une vente échelonnée, choisissez soit un règlement imputé au solde global de la vente, soit un règlement imputé à une échéance précise. Ces modes ne peuvent pas être mélangés pour une même vente. Si un avoir réduit la créance, continuez avec une imputation au niveau de la vente. Si un paiement a déjà été affecté à une échéance, aucun avoir ajustant la créance n’est autorisé tant que le client n’a pas défini de règle de ventilation. Un paiement ne constitue pas une nouvelle vente.
- Les bons peuvent être émis et utilisés comme mode de règlement d’une vente ; leur solde restant est suivi.
- La facturation n’est disponible que si un profil de facturation approuvé par le comptable existe. Pour l’impression ou l’enregistrement en PDF, utilisez l’instantané de facture conservé. Ne modifiez pas une facture émise : utilisez le parcours prévu pour les avoirs.

## Stocks, réceptions et prestations

- Enregistrez les réceptions fournisseur pour la bonne station, le bon produit et, le cas échéant, la bonne cuve.
- Ne corrigez le stock d’un article qu’en indiquant un motif clair. Les réceptions comptabilisées et les mouvements de stock sont immuables.
- Lorsqu’une prestation est comptabilisée, sa recette consomme les composants configurés ; ces sorties ne sont pas des ventes d’articles.
- Comparez le stock théorique de carburant au volume net obtenu par jaugeage étalonné. Un propriétaire ou responsable peut enregistrer une tolérance absolue approuvée par le client pour chaque carburant ; l’application signale les valeurs qui la dépassent. Aucune tolérance n’est préremplie et ce signal ne bloque jamais la clôture. La politique de tolérance et d’escalade pour les espèces et les cartes reste à définir.

## Rapports et corrections

Consultez le rapport quotidien pour les totaux par station et par client. Vous pouvez le télécharger sous forme de classeur Excel ou l’imprimer/l’enregistrer en PDF. Les ventes comptabilisées dans l’application et leur part à crédit sont présentées par devise ; les montants espèces/carte saisis pour la station restent séparés et ne sont pas ajoutés aux ventes. Le crédit ouvert correspond aux ventes comptabilisées jusqu’à la date métier choisie et tient compte des paiements et avoirs ultérieurs ; les soldes d’ouverture importés sans station ne figurent pas dans ce total par station. Les avoirs restent des écritures distinctes dans l’export comptable. L’export comptable standard est disponible en classeur Excel ; l’API fournit aussi un export CSV. Les imports CSV/XLSX sont préparés et validés avant leur comptabilisation. Vérifiez l’aperçu et le fichier source avant de confirmer. Pour corriger un relevé validé ou une clôture, utilisez le parcours de rectification numéroté et indiquez le motif ; ne modifiez jamais l’écriture d’origine en dehors de l’application.

## Besoin d’aide ?

Ouvrez une demande d’assistance depuis l’espace client en indiquant la station, la date métier et une brève description. N’incluez pas de mots de passe, de jetons d’accès, de données de carte bancaire ni de renseignements personnels superflus. Les horaires et délais de réponse dépendent des conditions de service convenues avec votre fournisseur.

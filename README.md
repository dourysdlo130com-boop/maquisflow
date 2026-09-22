# MaquisFlow V1.1

Prototype fonctionnel avec vraie base SQLite locale et espace restaurant.

## Prérequis
- Node.js 22 ou plus récent.

## Lancer
```bash
npm start
```
Puis ouvrir http://localhost:3000

## Compte de démonstration
- Email: admin@chezawa.ci
- Mot de passe: admin123

Le restaurant de démonstration est **Chez Awa**.

## Parcours client
- Menu: http://localhost:3000/restaurant?restaurant=chez-awa&table=5
- Le panier crée une vraie commande dans `data/maquisflow.sqlite` puis ouvre WhatsApp avec un message prérempli.

## Parcours restaurant
- http://localhost:3000/admin
- Dashboard
- Commandes et changement de statut
- Ajout/modification/suppression de produits
- Liste des tables et URLs de QR

## Base de données
SQLite est créée automatiquement au premier démarrage dans `data/maquisflow.sqlite`.

## Important
C'est une V1.1 de démonstration. Pour la production, il faudra notamment: vraie authentification robuste, HTTPS, gestion des rôles, sauvegardes, validation plus stricte, stockage d'images, QR imprimables, vraie intégration WhatsApp Business API, paiement et hébergement avec base managée.

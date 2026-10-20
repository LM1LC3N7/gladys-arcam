# Arcam pour Gladys

Pilotez vos amplis-tuners, processeurs et amplis **Arcam** (séries AVR, AV,
SA, ST, PA, ainsi que les processeurs JBL Synthesis SDP-55 et SDP-58 de
même protocole) depuis Gladys, en local, sans aucun cloud : allumage, veille,
volume, sourdine, source et mode audio de la zone 1.

> **Important.** Cette intégration n'a jamais été testée avec un vrai appareil :
> elle a été écrite d'après la bibliothèque `arcam-fmj` (celle de Home
> Assistant) et testée avec un faux appareil seulement. Vos retours sont les
> bienvenus. Intégration non officielle, sans lien avec Arcam.

## Installation

1. Sur l'appareil, activez le **contrôle IP** (menu de configuration, réglages
   réseau ou « Control ») et, pour pouvoir l'allumer depuis Gladys, gardez le
   **réseau actif en veille** (par exemple « HDMI & IP On » en veille sur les
   AVR, « Network standby » sur les SA).
2. Donnez à l'appareil une **adresse IP fixe** dans votre box (bail DHCP
   réservé) : l'adresse est l'identité de l'appareil dans Gladys.
3. Dans Gladys, installez l'intégration **Arcam**, puis ouvrez sa
   configuration.
4. Saisissez les adresses IP, séparées par des virgules (par exemple
   `192.168.1.40, 192.168.1.41` ; port 50000 par défaut). Le bouton
   **Chercher les appareils** peut aussi les trouver (recherche SSDP,
   facultative : elle ne traverse pas tous les réseaux).
5. Choisissez le **plafond de volume** (40 par défaut, sur l'échelle 0 à 99 de
   l'afficheur).
6. Les appareils apparaissent dans l'onglet **Découverte** : créez-les.

L'intégration garde une connexion TCP ouverte avec chaque appareil (port 50000) : les changements faits sur l'appareil, sa télécommande ou
l'application Arcam arrivent tout de suite dans Gladys. Certains appareils
n'acceptent qu'un seul client de contrôle IP à la fois : si une autre
application ne s'y connecte plus, c'est peut-être la raison.

## Ce que vous obtenez

| Fonction   | Type Gladys                    | Remarque                                                      |
| ---------- | ------------------------------ | ------------------------------------------------------------- |
| Marche     | état binaire (lecture seule)   | 1 allumé, 0 en veille ou injoignable                          |
| Allumer    | bouton                         | seulement si le réseau reste actif en veille                  |
| Veille     | bouton                         | met l'appareil en veille                                      |
| Volume     | musique / volume (0 à 99)      | l'échelle de l'afficheur, plafonné ; pas sur les amplis PA    |
| Sourdine   | bouton (télévision / sourdine) | chaque appui lit l'état puis règle l'inverse                  |
| Source     | liste                          | les entrées du modèle ; la liste ne fait que grandir          |
| Mode audio | liste                          | modes de décodage stéréo (2 ch) et multicanal ; AVR seulement |

Volontairement, aucun **interrupteur** : un « éteins tout » ou « allume
tout » d'un assistant vocal ou d'une scène ne réveille ni ne coupe votre ampli.

Le modèle est lu à la connexion (réponse AMX de l'appareil) : il choisit les
sources, les modes audio et la façon d'envoyer chaque commande (écriture
directe sur les SA, ST et PA, codes de télécommande RC5 sur les AVR). Un
modèle inconnu est traité comme la série AVR450, comme le fait `arcam-fmj`.

## Plafond de volume

Le volume demandé depuis Gladys (tableau de bord, scène, assistant vocal) ne
dépasse jamais le plafond de la configuration : un volume plus fort est ramené
au plafond. Le plafond est relu juste avant l'envoi : une nouvelle valeur
enregistrée s'applique tout de suite. Le volume réglé sur l'appareil lui-même
(bouton, télécommande, application) n'est pas modifié par l'intégration, sauf
dans deux cas où Gladys le rendrait audible :

- **Retirer la sourdine** : si le volume de l'appareil dépasse le plafond, il
  est d'abord ramené au plafond, puis la sourdine est retirée. Si le volume
  ne peut pas être lu, rien n'est envoyé.
- **Allumer** : après le réveil, le volume est relu et ramené au plafond s'il
  le dépasse. Si l'appareil met du temps à se réveiller, l'intégration
  revérifie toutes les 2,5 s pendant 15 s environ ; au-delà, le volume n'est
  pas corrigé.

## Mode audio

Les modes de décodage dépendent du signal reçu : stéréo (PCM, analogique)
ou multicanal (Dolby, DTS…). La liste montre les deux familles, marquées
« (2 ch) » et « (multi-ch) ». Avant chaque changement, le format du signal
est relu : un mode de l'autre famille est refusé sans rien envoyer.

## Veille et reconnexion

- En **veille avec réseau actif**, l'appareil reste joignable : l'état Marche
  passe à 0, le bouton Allumer le réveille, et les autres commandes sont
  refusées par l'appareil (« refusé par l'appareil »).
- En **veille sans réseau**, ou éteint, l'appareil ne répond plus : il est
  affiché éteint, cité dans le statut de l'intégration, et l'intégration
  réessaie de s'y connecter à intervalles espacés (10 s, puis le double à
  chaque échec, jusqu'à 5 minutes). Le bouton Allumer ne peut rien dans ce
  cas.
- L'adresse est l'identité de l'appareil : si elle change, un nouvel appareil
  apparaît dans la Découverte. D'où l'adresse IP fixe.

## Commandes

Chaque commande reçoit une réponse en moins de 4 secondes (Gladys attend 5
secondes). Une commande partie vers l'appareil sans confirmation est signalée
« envoyée, sans confirmation » ; l'état poussé par l'appareil montre ensuite
ce qu'il a fait. Une commande qui n'a pas pu partir est signalée « rien
envoyé » : c'est le cas de toute commande, Veille comprise, vers un appareil
non connecté. Veille et sourdine passent avant les commandes en attente.

## Boutons de la configuration

- **Chercher les appareils** : recherche SSDP par Gladys, puis chaque adresse
  locale qui répond est interrogée sur le port 50000.
- **Vérifier les appareils** : l'état de connexion, la marche et le volume de
  chaque appareil, et le plafond en vigueur.

## Données et confidentialité

L'intégration ne demande ni compte ni mot de passe : le contrôle IP Arcam
n'en a pas. Elle garde dans `/data/arcam.json` la liste des appareils connus
(adresse, modèle, version, options des listes). Rien ne sort de votre réseau
local.

## Limites connues

- Zone 1 seulement (pas encore la zone 2).
- Pas encore de préréglages radio, d'informations DAB/FM, d'égaliseur, de
  balance ni de luminosité de l'afficheur.
- Sur l'ST60, l'entrée « Réseau / USB » n'est pas affichée comme source.
- Jamais testé avec un vrai appareil : les réponses réelles peuvent différer.

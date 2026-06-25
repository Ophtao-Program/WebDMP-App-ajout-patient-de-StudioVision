# WebDMP Assistant

Application desktop (Electron + Python) pour faciliter le dépôt de documents dans **Mon Espace Santé / Web DMP**, en s'appuyant sur la base de données StudioVision.

## Fonctionnalités

- **Détection automatique du patient** ouvert dans StudioVision (via COM Interop)
- **Liste des derniers documents** PDF/images du patient (comptes rendus, imagerie…)
- **Lecture des notes/observations** de la base Access
- **Copie en un clic** du contenu dans le presse-papier → coller dans le Web DMP
- **Ouverture intégrée** du portail Web DMP avec session persistante (pas de reconnexion à chaque patient)
- **Mémorisation de l'identifiant e-CPS** en local

## Architecture

```
webdmp-app/
├── src/
│   ├── main.ts              # Processus Electron principal
│   ├── preload.ts           # Bridge sécurisé main ↔ renderer
│   └── renderer/
│       ├── index.html       # Interface utilisateur
│       ├── renderer.ts      # Logique UI
│       └── guide_dmp.html   # Guide d'utilisation
├── python/
│   └── dmp_connector.py     # Connecteur Python : StudioVision + Access
├── dist/                    # Fichiers compilés (généré par npm run build)
├── Installer.bat            # Installation en un clic
└── Lancer WebDMP.bat        # Lancement rapide
```

## Installation

1. Installer [Node.js LTS](https://nodejs.org)
2. Installer [Python 3.10+](https://python.org)
3. Double-cliquer **`Installer.bat`**

## Configuration

Éditer `python/dmp_connector.py` (lignes 20-21) pour adapter les chemins :

```python
FICHIER_MDB = Path(r"C:\chemin\vers\PUBLIC.MDB")
DEST_PHOTOS = Path(r"C:\chemin\vers\dossier_photos")
```

Si les noms des champs Access de votre StudioVision diffèrent :
```python
_FIELD_CODE   = "Code patient"   # Nom du champ code patient dans le formulaire
_FIELD_NOM    = "NOM"
_FIELD_PRENOM = "Prénom"
```

## Workflow quotidien

1. Ouvrir StudioVision avec le dossier du patient
2. Lancer WebDMP Assistant → **Détecter le patient**
3. Cliquer **Ouvrir Web DMP** → se connecter avec CPS/e-CPS (une fois par session)
4. Dans l'onglet **Documents** : consulter et ouvrir les fichiers à déposer
5. Dans l'onglet **Notes** : copier le texte → coller dans le champ DMP

## Dépendances

- `electron` ^30
- `python` pyodbc, pywin32
- Pilote Microsoft Access Database Engine 2016 (64 bits)

---

## Dépannage / diagnostic (v6)

Le connecteur Python lit désormais la base avec `SELECT *` puis accès par nom de
colonne (méthode éprouvée du projet de migration), et **remonte les erreurs** au
lieu de les avaler. Deux commandes pour valider directement sur la vraie base,
sans passer par l'interface :

```bat
REM 1. Confirmer le schéma réel (tables + colonnes) de VOTRE PUBLIC.MDB
python python\dmp_connector.py --diagnostic

REM 2. Tester info + documents + comptes-rendus pour un code patient donné
python python\dmp_connector.py --self-test <code-patient>
```

`--self-test` affiche le nombre de documents/notes trouvés, un exemple de chaque,
et la trace complète en cas d'erreur SQL. C'est l'outil à lancer en premier si
un patient ressort vide.

Chemins surchargés par variables d'environnement (utile en tâche de fond / multi-poste) :

```bat
set WEBDMP_MDB=C:\StudioVision\PUBLIC.MDB
set WEBDMP_PHOTOS=M:\PHOTOS
python python\dmp_connector.py --self-test <code-patient>
```

### Corrections apportées en v6
- **Documents** : la requête utilisait `SELECT ID, ...` ; or la table `Documents`
  n'a pas de colonne `ID`. Remplacé par `SELECT *` + lecture par nom.
- **Comptes-rendus** : ils sont lus dans la table `Consultation` (DOMINANTE,
  REFRACTION, Ordonnance, AV, TOD…), et non plus dans `Documents.TEXTE`.
- **NIR** : champ `NumSecu` (et non `SS`).
- **main.ts** : l'extraction JSON privilégiait `{`, ce qui cassait le parsing des
  listes (documents/notes) ; corrigé pour prendre le premier délimiteur `{` ou `[`.

---

## Enregistreur d'actions Web DMP (v7)

Nouveau module permettant de **journaliser chaque action** effectuée sur le portail
Mon Espace Santé, afin de construire ensuite le rejeu automatique du dépôt.

### Utilisation
1. Détecter le patient (bouton « Détecter le patient actif »).
2. Section **⏺ Enregistreur d'actions** → **Démarrer l'enregistrement**.
   La fenêtre Web DMP s'ouvre automatiquement si elle ne l'est pas déjà.
3. Effectuer **manuellement** un dépôt de document complet sur le portail.
   Chaque clic, saisie, choix de menu, upload de fichier et soumission est capturé
   en direct (compteur d'actions visible).
4. **Arrêter** : deux fichiers sont écrits dans le dossier des journaux.

### Fichiers produits
Dans `%APPDATA%\webdmp-app\dmp_logs\` (bouton **📁 Dossier des journaux**) :
- `session_<date>_<heure>.log`   — journal **lisible** (à relire ensemble) ;
- `session_<date>_<heure>.jsonl` — une action par ligne, **format machine** pour
  générer le scénario de rejeu (sélecteur CSS + XPath de chaque élément) ;
- `index.jsonl` — récapitulatif de toutes les sessions.

### Ce qui est capturé pour chaque action
Type d'action, libellé visible de l'élément, `id`/`name`/`role`/`aria-label`,
sélecteur CSS robuste, XPath absolu, label de formulaire associé, valeur saisie,
fichier uploadé (nom/taille/type), option de menu choisie, apparition de modales.

### Confidentialité
Les champs **mot de passe / OTP / code à usage unique** ne sont **jamais** journalisés
en clair : seules la longueur et la présence d'une saisie sont notées (`●●●●●`).

### Étape suivante (rejeu automatique)
Le `.jsonl` servira de base à un moteur de rejeu : ouverture auto de la fenêtre DMP,
navigation, sélection du fichier du patient détecté, remplissage des champs et
soumission — l'utilisateur ne validant plus que l'authentification e-CPS sur mobile.

---

## Dépôt automatique sur le DMP (v8)

À partir du parcours appris par l'enregistreur, l'application **automatise tout le
dépôt** d'un document, sauf la validation e-CPS sur mobile (imposée par Pro Santé Connect).

### Utilisation
1. Détecter le patient dans StudioVision.
2. Onglet **Documents** : cocher **un** document.
3. Choisir le **Type de document DMP** (mémorisé pour la fois suivante) et la visibilité.
4. **Envoyer le document sélectionné au DMP**.
5. La fenêtre DMP s'ouvre, le bouton e-CPS est cliqué : **valider sur le téléphone**.
6. Le reste se déroule tout seul : sélection du patient, formulaire d'ajout, envoi du
   fichier, type, visibilité, validation, confirmation et signature. La progression
   s'affiche étape par étape.

### Comment le fichier est envoyé sans le sélecteur Windows
Le moteur pose le fichier directement sur le champ `#file` via le protocole DevTools
d'Electron (`DOM.setFileInputFiles`), ce qui évite la boîte de dialogue de Windows.

### Sûreté (dépôt dans un dossier médical réel)
- Contrôle préalable : format (`jpeg, jpg, txt, pdf, rtf, tif, tiff`) et taille ≤ 5 Mo.
- Chaque étape attend sa précondition (URL/élément) ; au moindre écart, le moteur
  **s'arrête** et rend la main dans la fenêtre DMP — aucune étape de validation n'est
  cliquée deux fois.

### Limite connue
La sélection du patient repose sur sa présence dans la liste « Mes patients » du
portail (recherche par nom de famille). Si le patient n'y est pas, il faudra ajouter
une étape de recherche par **INS** — prévue pour une prochaine version.

### Correctif 403 (bounce OIDC)
Symptôme : après validation e-CPS, page « État HTTP 403 — Interdit » sur
`/index2.formjs`. Cause : le moteur réinjectait un clic de soumission sur la page
de bounce `/index2`, alors qu'elle se soumet déjà seule → double soumission d'un
jeton OIDC à usage unique → 403. Corrigé : plus aucune injection sur `/index2`
(la page gère seule), avec un unique filet de sécurité déclenché seulement si la
page reste bloquée plus de 12 s.

### Correctif « titre manquant » + détection des refus de formulaire
Symptôme : le dépôt allait jusqu'au formulaire puis échouait sur « Délai dépassé »,
le portail réclamant « Vous devez fournir un titre pour le document ». Cause : le
champ obligatoire `#TitreDocument` n'était pas rempli (en manuel, il se pré-remplit
depuis le nom de fichier via la boîte Windows, ce que la pose par CDP ne déclenche
pas). Corrigé : une étape **Titre** remplit `#TitreDocument` (titre proposé dans
l'UI, pré-rempli depuis la description StudioVision du document). De plus, après
soumission, le moteur **détecte un refus** (retour sur `ajoutdocument.formajoutdocument`)
et **affiche le message d'erreur réel** au lieu d'expirer.

---

## Mode tâche de fond (v9)

L'option **« Tâche de fond »** (cochée par défaut dans le bloc de dépôt) masque la
fenêtre Web DMP : seul l'écran d'**authentification e-CPS** s'affiche, puis la
fenêtre se masque et tout le dépôt se déroule en arrière-plan.

Fonctionnement :
- la fenêtre DMP est créée **masquée** (`show:false`, sans throttling d'arrière-plan
  pour rester réactive) ;
- elle s'**affiche automatiquement** dès qu'une page d'authentification Pro Santé
  Connect est détectée — vous validez sur votre téléphone ;
- une fois l'authentification passée (`mespatients/raz`), elle se **masque** et la
  suite (patient, ajout, fichier, type, titre, validation, confirmation) s'exécute
  sans fenêtre visible ;
- si vous êtes déjà authentifié (session encore valide), elle **reste masquée** du
  début à la fin ;
- en cas d'**erreur**, la fenêtre se **réaffiche** pour vous permettre de reprendre
  la main manuellement.

Décocher la case rétablit le comportement classique (fenêtre visible en permanence).

### Correctif « Erreur générale non identifiée » (ré-authentification)
Symptôme : si on s'authentifie une première fois (p. ex. via « Démarrer
l'enregistrement »), qu'on ferme la fenêtre, puis qu'on lance un dépôt, le DMP
affichait « Erreur générale non identifiée » (passage `wallet auth → callbackoidc`).
Cause : à la réouverture, l'application rechargeait le tunnel OIDC (`PSC_URL`) alors
qu'une session DMP était déjà active — relancer OIDC sur une session active casse.
Corrigé : dès qu'une session a été ouverte (`dmpAuthenticated`), la fenêtre va
directement à la page DMP (`DMP_HOME`) qui réutilise la session, sans repasser par
OIDC. Le tunnel OIDC n'est utilisé que s'il n'y a pas encore de session. L'attente
de fin d'authentification reconnaît la page « Mes Patients » via l'URL *ou* la
présence des liens patients (DMP_HOME peut atterrir à la racine).

---

## Mode service — envoi par Ctrl+Alt+D depuis StudioVision (v11)

Permet d'alimenter le DMP **sans ouvrir l'interface** : on travaille dans
StudioVision, on sélectionne un document, et `Ctrl+Alt+D` l'envoie au DMP du patient.

### Mise en route (une fois par session)
Lancer **`Se-Connecter-WebDMP.bat`** :
1. la fenêtre DMP s'ouvre pour l'**authentification e-CPS** (validez sur mobile) ;
2. elle se **masque** ; une icône WebDMP apparaît près de l'horloge ;
3. le raccourci global **Ctrl+Alt+D** est actif.

### Usage au quotidien
- Dans StudioVision, **sélectionnez un document** dans la liste de la fiche patient.
- **Ctrl+Alt+D** → une petite fenêtre s'ouvre : patient + document + **type DMP
  pré-rempli** (depuis la description StudioVision) + titre. Confirmez → envoi en fond.
- La session e-CPS est réutilisée : **aucune reconnexion** tant que le service tourne.
  Si elle a expiré, la fenêtre DMP réapparaît pour revalider, puis l'envoi reprend.
- Icône près de l'horloge : envoyer le document courant, rétablir la connexion,
  ouvrir les journaux, quitter.

### Détails techniques
- Lecture du document sélectionné : `dmp_connector.py --get-selected-document`
  (Méthode A — contrôles liés au registre courant du sous-formulaire `SFDoc`),
  avec garde sur la ligne vide « nouvel enregistrement ».
- Type DMP suggéré : correspondance description StudioVision → type DMP
  (`suggest_dmp_type`), confirmée/modifiable dans la fenêtre.
- Réutilise intégralement le moteur de dépôt validé (auth, CDP `setFileInputFiles`,
  titre, détection des refus de formulaire, mode tâche de fond).
- Le mode normal (interface complète) reste disponible via `Lancer WebDMP.bat`.

### Limite connue
La sélection du patient sur le portail repose sur sa présence dans « Mes Patients »
(recherche par nom). Si absent, prévoir une recherche par INS (version ultérieure).

### Lanceur sans fenêtre (v12)
Le `.bat` ouvrait une console qui devait rester ouverte (la fermer tuait le service)
et affichait des erreurs « 'À' n'est pas reconnu… » dues aux commentaires accentués
sous `chcp 65001`. Corrigé : `.bat` 100 % ASCII (commentaires `REM`), et surtout un
lanceur **`Se-Connecter-WebDMP (sans fenetre).vbs`** qui démarre Electron directement
(sans console). Première exécution : fenêtre visible le temps de l'install/compilation ;
ensuite, plus aucune fenêtre terminal.

### Message « patient non enregistré » (v13)
L'étape patient renvoyait un message technique interne quand le nom n'était pas dans
« Mes patients ». Remplacé par un message clair et actionnable : il faut d'abord ajouter
le patient depuis le portail (Mon Espace Santé Pro) avec sa carte Vitale ou son INS, puis
relancer l'envoi. Le cas « liste vide » comme le cas « patient absent parmi d'autres »
aboutissent au même message.

### Correctif critique : dépôt sur le mauvais patient (v14)
En mode service, après un premier envoi la fenêtre restait (masquée) sur le
récapitulatif du patient précédent. Au dépôt suivant, le moteur voyait une page
`/dmp/recapitulatif` et **sautait la sélection du patient** → le document partait
dans le dossier du patient précédent. Corrigé : l'étape patient **revient toujours
à « Mes patients » (`mespatients/raz`) puis sélectionne le bon patient par son nom**,
sans jamais se fier à la page ouverte. Le saut conditionnel a été supprimé.

### Lanceur : plus aucune fenêtre, même en première exécution (v14)
Le `.vbs` basculait sur le `.bat` visible quand `node_modules` était absent (cas de
chaque mise à jour), et la console restait ouverte. Désormais le `.vbs` exécute
`npm install` + `npm run build` **en masqué** si nécessaire, puis lance
`electron.exe` directement (application graphique, sans console). Une boîte de
dialogue n'apparaît qu'en cas d'échec d'installation. Conseil : décompresser une
mise à jour par-dessus le dossier existant conserve `node_modules` et rend le
démarrage instantané.

### Confidentialité : retrait des données patient du code (v14)
Le message « patient non enregistré » n'affiche plus la liste des autres patients
présents dans « Mes patients ». Toutes les références à des patients réels (noms,
codes, chemins d'exemple) ont été retirées du code et des commentaires.

### Verrou mono-instance + nom d'application (v15)
Deux correctifs liés. Le raccourci `Ctrl+Alt+D` échouait (« déjà utilisé ») parce
que plusieurs instances de l'application tournaient en même temps — chacune tentant
de réserver le raccourci global, seule la première y parvenant. Ajout d'un **verrou
mono-instance** (`app.requestSingleInstanceLock`) : toute exécution supplémentaire se
ferme aussitôt et signale que l'application est déjà active. Une seule instance vit à
la fois, donc le raccourci se réserve sans conflit.

Par ailleurs, les notifications affichaient « electron.app.Electron » et le nom
« WebDMP » était utilisé par endroits. Le nom affiché est désormais **WebDMP Assistant**
partout (notifications via `setAppUserModelId`, info-bulle et menu de l'icône). Le nom
interne (et donc les chemins de config/journaux) reste inchangé.

### Connexion fiable, statut, ordre des fenêtres et journaux (v16)
Quatre améliorations du mode service.

**Reconnexion fiable.** « Se connecter / vérifier la connexion » se contentait de
ramener la fenêtre sur sa page courante (parfois périmée) sans réauthentifier, et la
connexion initiale au démarrage était capricieuse. Désormais une fonction unique force
le chargement de la liste patients (page authentifiée) : si la session est valide c'est
terminé, sinon la fenêtre PSC s'affiche pour la validation e-CPS, puis se masque.

**Statut au clic.** Un clic gauche sur l'icône teste réellement la session (chargement
de la liste patients en arrière-plan, détection d'une redirection vers Pro Santé Connect)
et indique « session active » ou « non connecté ». L'info-bulle reflète le dernier état.

**Ordre des fenêtres.** Quand l'authentification e-CPS est nécessaire pendant un envoi,
la fenêtre du portail passe désormais devant la fenêtre de validation (au lieu d'être
cachée derrière), pour pouvoir valider sans la déplacer.

**Deux journaux** (remplacent le « dossier des journaux ») : `journal_technique.txt`
(trace horodatée de chaque opération, pour l'informaticien) et `rapport_medecin.txt`
(uniquement les envois réussis/échoués, par patient, datés).

### Changement de patient : gestion auto de « Confirmation d'accès à un autre DMP » (v17)
Le portail interdit deux DMP ouverts simultanément. Après un premier dépôt, le DMP du
patient reste ouvert ; au dépôt suivant pour un AUTRE patient, le clic sur le patient
mène à la page « Confirmation d'accès à un autre DMP »
(`/dmp/confirmationouvertureautre/…`) au lieu du récapitulatif. L'ancien code attendait
le récapitulatif et **expirait au bout de 20 s** (« Délai dépassé »), comme l'ont montré
les journaux : 1ᵉʳ patient OK, puis échec systématique au changement de patient.

Correctif : après le clic sur le patient, on surveille pendant ~25 s l'arrivée du
récapitulatif OU de la page de confirmation (détectée par la présence du lien « Oui »,
dont l'URL contient `confirmopendmp`). Si la confirmation apparaît, on clique « Oui »
une fois — ce qui ferme automatiquement l'autre DMP — puis on poursuit jusqu'au
récapitulatif. Le dépôt enchaîne alors normalement, sans intervention manuelle.

### Suppression du dialogue Windows « Comment voulez-vous ouvrir ce type d'élément ? » (v17)
Au lancement, une page (Pro Santé Connect) pouvait tenter d'ouvrir un lien externe ou un
protocole applicatif local, déclenchant ce dialogue Windows par-dessus la fenêtre. Sur la
fenêtre DMP, on refuse désormais les pop-ups (`setWindowOpenHandler`) et on bloque toute
navigation vers un schéma non http(s) (`will-navigate`/`will-redirect`). L'authentification
e-CPS par téléphone n'en a pas besoin, donc aucun impact fonctionnel.

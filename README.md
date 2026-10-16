# KSTermus

> Client SSH, SFTP et terminal local pour Windows, pensé pour les équipes qui administrent des serveurs au quotidien.
> Inspiré de **Termius** (hosts, keychain, SFTP), **tmux** (panneaux, préfixe, sessions détachées) et **Warp** (palette de commandes, blocs, workflows paramétrés).

Éditeur : **CYBERISK** · Licence : propriétaire (UNLICENSED) · Version : **1.4.0**

---

## Sommaire

1. [Fonctionnalités](#fonctionnalités)
2. [Installation](#installation)
3. [Premier démarrage](#premier-démarrage)
4. [Guide d'utilisation](#guide-dutilisation)
   - [Hosts et connexions SSH](#hosts-et-connexions-ssh)
   - [Terminaux locaux](#terminaux-locaux)
   - [Split, préfixe tmux et sessions détachées](#split-préfixe-tmux-et-sessions-détachées)
   - [Palette, blocs et snippets façon Warp](#palette-blocs-et-snippets-façon-warp)
   - [SFTP](#sftp)
   - [Éditeur de fichiers distants (normal et sudo)](#éditeur-de-fichiers-distants-normal-et-sudo)
   - [Historique des éditions](#historique-des-éditions)
   - [Keychain et mots de passe](#keychain-et-mots-de-passe)
   - [Port forwarding](#port-forwarding)
   - [Known hosts](#known-hosts)
   - [Verrouillage et Windows Hello](#verrouillage-et-windows-hello)
   - [Recherche dans le terminal](#recherche-dans-le-terminal)
5. [Raccourcis clavier](#raccourcis-clavier)
6. [Sécurité](#sécurité)
7. [Données et sauvegarde](#données-et-sauvegarde)
8. [Développement](#développement)
9. [Architecture](#architecture)
10. [Tests](#tests)
11. [Construire la version Windows](#construire-la-version-windows)
12. [Limites connues](#limites-connues)
13. [Historique des versions](#historique-des-versions)

---

## Fonctionnalités

| Domaine | Ce que fait KSTermus |
|---|---|
| **Hosts** | Groupes, couleurs, recherche, duplication, commande au démarrage, import d'un fichier `~/.ssh/config` |
| **Authentification** | Mot de passe, clé du keychain (avec passphrase), agent SSH (OpenSSH / Pageant), **2FA / OTP** (Google Authenticator, Duo…) |
| **Jump host** | Connexion via un ou plusieurs bastions (ProxyJump), pour SSH, SFTP, éditeur et tunnels ; import de `ProxyJump` depuis `~/.ssh/config` |
| **Reconnexion auto** | Après une coupure réseau ou une mise en veille : nouvel essai à 2, 4, 8, 15 puis 30 s, compte à rebours, tunnels relancés automatiquement |
| **Verrouillage** | Écran verrouillé après inactivité (sessions et tunnels conservés), au verrouillage de Windows et en veille, **Windows Hello** (visage, empreinte, PIN) |
| **Recherche** | `Ctrl+Shift+F` dans tout terminal : surlignage, compteur `2/6`, casse, mot entier, regex |
| **Terminal SSH** | Onglets, reconnexion en un clic, copie à la sélection (une seule écriture, au relâchement de la souris), liens cliquables, 10 000 lignes d'historique |
| **Terminal local** | PowerShell 7, Windows PowerShell, cmd, Git Bash, distributions WSL (détection automatique) ; bash/zsh/fish sous Linux/macOS |
| **Split** | Jusqu'à 8 panneaux par onglet, **mélange local + SSH**, séparateurs déplaçables, zoom d'un panneau, diffusion de la saisie |
| **tmux** | Préfixe `Ctrl+B` (ou `Ctrl+A`), 20 commandes, sessions locales **détachables et rattachables**, espaces de travail sauvegardés |
| **Warp** | Palette de commandes (`Ctrl+Shift+P`), blocs de commandes (navigation, copie de la sortie), snippets paramétrés `{{param}}` |
| **SFTP** | Navigation, envoi multiple, téléchargement, renommage, création de dossier, suppression récursive, progression |
| **Éditeur** | Édition directe de fichiers distants, **en sudo** si besoin, coloration (25 langages), recherche/remplacement, détection des conflits, CRLF conservé |
| **Historique** | Chaque ouverture et chaque enregistrement crée une version **chiffrée** ; différences et restauration en un clic |
| **Mots de passe** | Boutons **afficher / masquer** et **copier** partout ; presse-papiers effacé automatiquement après 30 s |
| **Keychain** | Import OpenSSH / PEM / PuTTY `.ppk`, génération ed25519 / RSA 4096, export, copie de la clé publique |
| **Tunnels** | Local `-L`, distant `-R`, dynamique SOCKS5 `-D`, démarrage / arrêt, état en direct |
| **Sécurité** | Coffre AES-256-GCM + scrypt, vérification des empreintes serveur (TOFU), alerte bloquante si une empreinte change |
| **Fenêtre** | Barre de titre intégrée, taille/position mémorisées, instance unique, confirmation à la fermeture, plein écran |

---

## Installation

### Option 1 — Installateur fourni (recommandé)

1. Copie le dossier du projet sur le PC (il contient `INSTALLER-KSTermus.cmd` et `package-windows\`).
2. Double-clique sur **`INSTALLER-KSTermus.cmd`**.
3. Le script :
   - reconstitue l'archive à partir des parties `package-windows\KSTermus-win-x64.zip.00X` ;
   - vérifie son empreinte **SHA-256** (indiquée dans `package-windows\manifest.txt`) ;
   - ferme KSTermus s'il tourne, l'installe dans `%LOCALAPPDATA%\Programs\KSTermus` ;
   - crée les raccourcis **Bureau** et **menu Démarrer**, puis lance l'application.

Une mise à jour s'installe de la même façon : le coffre (`%APPDATA%\KSTermus`) n'est jamais touché.

### Option 2 — Depuis les sources

Prérequis : **Node.js 20+** et **npm**.

```powershell
npm install
npm start
```

---

## Premier démarrage

1. Choisis un **mot de passe maître** (8 caractères minimum). Il chiffre tout le coffre.
   **Il ne peut pas être récupéré** : sans lui, les données sont perdues.
2. Ajoute tes serveurs (**Hosts → + Nouveau host**) ou importe un fichier `~/.ssh/config`.
3. Ouvre un terminal local avec **Ctrl+Shift+T**, ou une connexion avec **Ctrl+T**.

---

## Guide d'utilisation

### Hosts et connexions SSH

- **+ Nouveau host** : nom, groupe, adresse, port, utilisateur, mode d'authentification, mot de passe, mot de passe sudo (optionnel), commande au démarrage, couleur.
- **Double-clic** sur une carte ou bouton **SSH** : ouvre un terminal. **SFTP** : ouvre l'explorateur de fichiers.
- **🔑** sur une carte : copie le mot de passe (effacé du presse-papiers après 30 s).
- **Importer config** : lit un fichier `~/.ssh/config` (`Host`, `HostName`, `User`, `Port`, `IdentityFile`). Les clés non chiffrées sont ajoutées au keychain ; les hosts arrivent dans le groupe « Importés ».
- **Passer par (jump host)** : choisis un autre host comme bastion. Le bastion peut lui-même passer par un autre (5 rebonds max., boucles détectées). La carte affiche `↪ via Bastion → …`. Tout passe par le bastion : terminal, SFTP, éditeur, tunnels.
- **2FA / OTP** : si le serveur demande un code (PAM `google-authenticator`, Duo, etc.), une fenêtre affiche **la vraie question du serveur**. Le mot de passe enregistré est envoyé automatiquement, puis seul le code t'est demandé.
- **Reconnexion automatique** (activable dans Paramètres) : si la connexion tombe (réseau, Wi-Fi, mise en veille, redémarrage du serveur), le panneau affiche un compte à rebours, puis réessaie à 2, 4, 8, 15 puis 30 s, 20 fois au maximum. Boutons **Reconnecter maintenant** et **Annuler**. Quand le réseau revient, la reconnexion est immédiate. Un `exit` volontaire ne déclenche **pas** de reconnexion.
- À la **première connexion**, KSTermus affiche l'empreinte SHA-256 du serveur. Vérifie-la sur le serveur avec :
  ```bash
  ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
  ```

### Terminaux locaux

Section **Local** de la barre latérale :

- **Shells installés** : détection automatique (PowerShell 7, Windows PowerShell, cmd, Git Bash, chaque distribution WSL). Bouton **☆** pour choisir le shell par défaut.
- **Ouvrir** ouvre un nouvel onglet. **⫿ À droite** divise le dernier onglet terminal utilisé.
- Dans un terminal local sous Windows, **Ctrl+V** colle aussi (comme dans Windows Terminal).
- Le titre du panneau suit le titre envoyé par le shell (dossier courant de PowerShell, `user@host:~` de bash…).

### Split, préfixe tmux et sessions détachées

**Diviser** : boutons ◫ de la barre, menu de chaque panneau, `Ctrl+Shift+D` / `Ctrl+Shift+E`, ou préfixe puis `%` / `"`.
Le menu de split propose : *même shell / même host*, n'importe quel **shell local** ou n'importe quel **host SSH**. Un onglet peut donc mélanger PowerShell, WSL et trois serveurs.

**Préfixe** (comme tmux) : appuie sur **Ctrl+B**, relâche, puis une touche. Un badge orange confirme que le préfixe est actif (2,5 s).

| Après le préfixe | Action |
|---|---|
| `%` / `"` | Diviser à droite / en bas |
| `←` `↑` `→` `↓` / `o` | Changer de panneau / panneau suivant |
| `z` | Agrandir / restaurer le panneau |
| `x` | Fermer le panneau |
| `d` | **Détacher** le panneau local (la session continue en arrière-plan) |
| `s` | **Rattacher** une session détachée |
| `c` | Nouveau terminal local |
| `n` / `p` / `0…9` / `w` | Onglet suivant / précédent / numéro / liste |
| `,` | Renommer l'onglet |
| `S` | Sauvegarder l'espace de travail |
| `b` | Diffusion de la saisie à tous les panneaux |
| `[` / `]` | Commande précédente / suivante |
| `y` | Copier la sortie de la dernière commande |
| `:` | Palette de commandes |
| `?` | Aide |
| préfixe deux fois | Envoie le vrai `Ctrl+B` au shell |

Le préfixe se règle dans **Paramètres** : `Ctrl+B` (tmux), `Ctrl+A` (screen) ou désactivé.

**Sessions détachées** : un panneau local détaché (⏏ ou préfixe `d`) **continue de tourner** : compilation, `npm run dev`, `docker compose logs -f`… Sa sortie est mise en tampon (400 Ko) et réaffichée quand tu le rattaches (**Local ▸ Sessions locales ▸ Rattacher** ou préfixe `s`).
Les sessions vivent tant que KSTermus est ouvert. À la fermeture de la fenêtre, une confirmation indique combien de sessions seront arrêtées.

**Espaces de travail** : bouton 💾 de la barre (ou préfixe `S`) pour enregistrer la disposition de l'onglet : l'arbre des panneaux, le shell ou le host de chacun, les proportions et la diffusion. **Local ▸ Espaces de travail ▸ Ouvrir** recrée tout et relance les connexions.

### Palette, blocs et snippets façon Warp

- **Palette de commandes** : `Ctrl+Shift+P` (ou préfixe `:`). Recherche floue sur toutes les actions : nouveaux shells, connexions, SFTP, ouverture de fichiers, snippets, espaces de travail, actions de panneau, navigation. `↑↓` puis `Entrée`.
- **Blocs de commandes** : chaque commande validée est repérée par un trait vert dans la marge.
  - `Ctrl+Shift+↑` / `Ctrl+Shift+↓` : remonter / redescendre de commande en commande.
  - `Ctrl+Shift+O` ou ⧉ dans l'en-tête du panneau : copie **uniquement la sortie** de la dernière commande.
- **Snippets paramétrés** (« workflows ») : dans une commande, écris `{{nom}}` ou `{{nom:valeur par défaut}}`. Les valeurs sont demandées à l'envoi.
  ```bash
  docker logs -f --tail {{lignes:200}} {{conteneur:api}}
  sudo systemctl restart {{service:nginx}} && systemctl status {{service}} --no-pager
  ```
- **Diffusion** (`Ctrl+Shift+B`) : la saisie, et les snippets, partent vers tous les panneaux de l'onglet. Les bordures passent en orange tant qu'elle est active.

### SFTP

- Navigation par **double-clic**, `↑` (parent), `⌂` (dossier personnel) ou chemin tapé puis `Entrée`.
- Par fichier : **📝** éditer, **🛡** éditer en sudo, **⤓** télécharger, **✎** renommer, **🗑** supprimer.
- **⤒ Envoyer** (plusieurs fichiers), **+ Dossier**, **📝 Ouvrir…** (ouvre ou crée un fichier dans le dossier courant).
- La suppression d'un dossier est **récursive** (une confirmation est demandée).

### Éditeur de fichiers distants (normal et sudo)

Ouvrir un fichier :
- **SFTP** : double-clic sur le fichier, ou 📝 / 🛡 ;
- **Terminal SSH** : bouton **📝 Éditer**, puis chemin absolu, `~/…` ou relatif, avec la case **Ouvrir en sudo** ;
- **Palette** : « Ouvrir un fichier sur … ».

Fonctionnement :
- **Coloration** détectée par extension ou par nom (nginx, Dockerfile, `.env`, `sshd_config`, YAML, PHP, Java, Python…), modifiable dans le sélecteur.
- `Ctrl+S` enregistrer · `Ctrl+F` rechercher · `Ctrl+H` remplacer · `Ctrl+G` aller à la ligne · `Ctrl+/` commenter.
- **Fins de ligne** : un fichier CRLF reste en CRLF. On peut basculer en cliquant `LF`/`CRLF` dans la barre d'état.
- **Conflits** : à l'enregistrement, KSTermus vérifie que le fichier n'a pas changé sur le serveur depuis son ouverture (empreinte SHA-256). En cas de conflit, tu peux annuler, **voir les différences** ou **écraser**.
- **Permission refusée** : KSTermus propose de rouvrir ou d'enregistrer **en sudo**.
- Un fichier inexistant est créé au premier enregistrement.
- Un **dossier** (chemin terminé par `/`, ou dossier existant) ouvre un **sélecteur de fichiers** : filtre, navigation, `..`, et création d'un nouveau fichier. En sudo si le dossier est protégé.
- Fichiers binaires et fichiers de plus de 8 Mo refusés.

**Comment fonctionne le mode sudo**
1. KSTermus teste d'abord `sudo -k -n true` : si sudo est en **NOPASSWD**, aucun mot de passe n'est envoyé.
2. Sinon, il utilise le **mot de passe sudo** du host, ou à défaut son mot de passe SSH, ou te le demande (avec l'option « Mémoriser dans le coffre »).
3. **Lecture** : `sudo -k -S cat -- fichier`. Le mot de passe passe sur l'entrée standard, jamais dans la ligne de commande.
4. **Écriture** : le contenu est d'abord envoyé par SFTP dans `/tmp/.kstermus-<aléatoire>` (droits `600`), puis `sudo sh -c 'cat tmp > fichier'`. Le **propriétaire et les droits du fichier sont conservés**, et le fichier temporaire est supprimé.
5. `-k` force sudo à relire le mot de passe à chaque fois : le mot de passe ne peut jamais se retrouver écrit dans le fichier, même si sudo l'avait mis en cache.

### Historique des éditions

- Chaque **ouverture** et chaque **enregistrement** d'un fichier distant crée une version (40 au maximum par fichier ; une version identique à la précédente n'est pas dupliquée).
- Dans l'éditeur, **🕘 Historique** : liste des versions, **différences** avec le contenu actuel de l'éditeur, **↺ Restaurer cette version** (le contenu revient dans l'éditeur, puis `Ctrl+S` pour l'appliquer sur le serveur), **⤓ Copie locale**.
- Section **Historique** de la barre latérale : tous les fichiers édités, par host, avec le nombre de versions. On peut tout rouvrir ou supprimer l'historique d'un fichier.
- Les versions sont **chiffrées avec la clé du coffre** (`%APPDATA%\KSTermus\history\*.kst`) et re-chiffrées si tu changes de mot de passe maître.

### Keychain et mots de passe

- **Importer une clé** : coller le contenu ou choisir un fichier (OpenSSH, PEM, PuTTY `.ppk`), avec sa passphrase éventuelle.
- **Générer** : ed25519 (recommandé) ou RSA 4096, avec passphrase optionnelle. La clé publique est copiée directement, prête pour `~/.ssh/authorized_keys`.
- Tous les champs mot de passe ont **👁 afficher / masquer** et **⧉ copier**. Sur un host existant, 👁 récupère le mot de passe enregistré.
- Toute copie d'un secret est **effacée du presse-papiers après 30 secondes** si elle n'a pas été remplacée entre-temps.

### Port forwarding

| Type | Usage typique |
|---|---|
| **Local (-L)** | `127.0.0.1:5433 → db:5432` via le serveur : accéder à une base privée depuis ton PC |
| **Distant (-R)** | Le serveur écoute sur un port et renvoie vers ton PC (démo, webhook). `GatewayPorts` est requis pour écouter hors `127.0.0.1` |
| **Dynamique (-D)** | Proxy **SOCKS5** local : configure ton navigateur sur `127.0.0.1:port` pour sortir par le serveur |

Un tunnel coupé (et non arrêté par toi) est **relancé automatiquement** (2, 4, 8, 15 puis 30 s, 20 tentatives au maximum). Tu peux désactiver ce comportement tunnel par tunnel.

### Known hosts

La liste des empreintes acceptées. Si l'empreinte d'un serveur change, la connexion est **bloquée**, avec l'ancienne et la nouvelle empreinte affichées : il peut s'agir d'une réinstallation ou d'une attaque de type *man-in-the-middle*. **Oublier** permet de réaccepter après vérification.

### Verrouillage et Windows Hello

**Verrouiller l'écran** (`Ctrl+Shift+L` ou 🔒 ▸ *Verrouiller l'écran*) masque l'interface **sans couper** les sessions SSH, les terminaux locaux ni les tunnels. Pendant le verrou, le process principal refuse toute demande de l'interface (mots de passe, état du coffre, saisie dans les terminaux) sauf le déverrouillage, et un mot de passe copié est retiré du presse-papiers.

| Réglage (Paramètres) | Effet |
|---|---|
| **Verrouillage automatique** | Après 1, 5, **15** (défaut), 30, 60 min ou 4 h sans clavier ni souris dans KSTermus ; *Jamais* pour désactiver |
| **Verrouiller avec Windows** | Verrouille aussi sur `Win+L` et à la mise en veille (activé par défaut) |
| **Windows Hello** | *Écran verrouillé* : visage, empreinte ou PIN au lieu du mot de passe maître. *Écran + démarrage* : aussi pour ouvrir le coffre au lancement |

- Déverrouiller : mot de passe maître ou bouton **🙂 Windows Hello** (proposé automatiquement à l'ouverture de l'écran).
- Après 3 mots de passe faux, attente croissante (2, 4, 8 … 60 s).
- **Tout fermer** : 🔒 ▸ *Tout fermer et verrouiller le coffre*, ou le lien sous le formulaire de l'écran verrouillé (deux clics). Les sessions sont fermées et la clé est effacée de la mémoire.
- *Écran + démarrage* garde la clé du coffre dans `%APPDATA%\KSTermus\hello.kst`, chiffrée par **DPAPI** (liée à ta session Windows) et libérée seulement après Hello. Changer le mot de passe maître met ce fichier à jour ; *Désactivé* le supprime.

### Recherche dans le terminal

`Ctrl+Shift+F` (ou préfixe `/`, ou la palette) ouvre une barre de recherche dans le panneau actif. Le texte sélectionné est repris automatiquement.

- `Entrée` / `Maj+Entrée` : résultat suivant / précédent ; `Échap` ferme.
- Options **Aa** (casse), **ab** (mot entier), **.\*** (expression régulière).
- Toutes les occurrences sont surlignées, avec un compteur (`2/6`, `aucun`) et des repères dans la barre de défilement.
- `Ctrl+F` seul reste envoyé au shell (bash, vim, less l'utilisent). Pour qu'il ouvre la recherche : **Paramètres ▸ Recherche dans le terminal**.

---

## Raccourcis clavier

| Touche | Action |
|---|---|
| `Ctrl+Shift+P` | Palette de commandes |
| `Ctrl+Shift+F` | Rechercher dans le terminal |
| `Ctrl+Shift+L` | Verrouiller l'écran (sessions conservées) |
| `Ctrl+T` | Nouvelle connexion (shell local ou host) |
| `Ctrl+Shift+T` | Nouveau terminal local (shell par défaut) |
| `Ctrl+B` puis … | Préfixe tmux (voir plus haut) |
| `Ctrl+Shift+D` / `Ctrl+Shift+E` | Diviser à droite / en bas |
| `Alt+Flèches` | Changer de panneau |
| `Ctrl+Shift+Entrée` | Agrandir / restaurer le panneau |
| `Ctrl+Shift+B` | Diffusion de la saisie |
| `Ctrl+Shift+W` | Fermer le panneau (ou l'onglet) |
| `Ctrl+Shift+↑` / `↓` | Commande précédente / suivante |
| `Ctrl+Shift+O` | Copier la sortie de la dernière commande |
| `Ctrl+Tab`, `Ctrl+1…9` | Changer d'onglet |
| `Ctrl+Shift+C` / `V` | Copier / coller dans le terminal (clic droit = coller) |
| `Ctrl+C` (avec sélection) / `Ctrl+V` | Copier / coller façon Windows Terminal — sans sélection, `Ctrl+C` envoie bien ^C au shell |
| `Ctrl+S` | Enregistrer le fichier (éditeur) |
| `Ctrl +` / `Ctrl −` / `Ctrl 0` | Taille du texte |
| `F11` | Plein écran |
| `Ctrl+Shift+I` | Outils de développement |

`Ctrl+W` n'est **pas** utilisé : il reste « effacer le mot précédent » dans le shell.

---

## Sécurité

- **Coffre chiffré** : AES-256-GCM, clé dérivée du mot de passe maître par **scrypt** (N = 2¹⁷, r = 8, p = 1). Écriture atomique (fichier temporaire puis renommage).
- **Rien en clair sur disque** : hosts, mots de passe, clés privées, snippets, tunnels, empreintes et historique des éditions sont tous chiffrés.
- **Processus de rendu isolé** : `contextIsolation`, `sandbox`, `nodeIntegration: false`, CSP stricte. Le renderer ne reçoit jamais les mots de passe ni les clés privées, sauf action explicite (👁 / ⧉).
- **Aucune donnée affichée n'est interprétée comme HTML** (noms de fichiers SFTP, titres…), pour éviter les injections.
- **Vérification des clés d'hôte** obligatoire (TOFU + alerte bloquante si l'empreinte change).
- **sudo** : mot de passe uniquement sur stdin, `-k` systématique, fichier temporaire en `600`.
- **Écran verrouillé** (`Ctrl+Shift+L`, inactivité, `Win+L`, veille) : sessions conservées, toutes les requêtes de l'interface refusées par le process principal sauf le déverrouillage, délai croissant après 3 échecs.
- **Windows Hello** : vérification via l'API Windows `UserConsentVerifier`. Pour le démarrage, la clé du coffre est protégée par DPAPI : quelqu'un qui contrôle ta session Windows **et** passe Hello peut ouvrir le coffre. Garde *Écran verrouillé* seul si tu veux que le mot de passe maître reste obligatoire au lancement.
- **Tout fermer et verrouiller** (🔒) : ferme toutes les sessions SSH, tunnels et terminaux locaux, puis efface la clé de la mémoire.

---

## Données et sauvegarde

| Élément | Emplacement |
|---|---|
| Application | `%LOCALAPPDATA%\Programs\KSTermus` |
| Coffre chiffré | `%APPDATA%\KSTermus\vault.kst` |
| Historique des éditions (chiffré) | `%APPDATA%\KSTermus\history\*.kst` |
| Clé Windows Hello (DPAPI, optionnelle) | `%APPDATA%\KSTermus\hello.kst` |
| Position / taille de la fenêtre | `%APPDATA%\KSTermus\window-state.json` |

**Migrer vers un autre PC** : copie le dossier `%APPDATA%\KSTermus` (ou **Paramètres ▸ Exporter**), installe KSTermus, remets le dossier en place, puis déverrouille avec le même mot de passe maître.

---

## Développement

```bash
npm install          # dépendances (dont le PTY natif précompilé)
npm start            # lancer en mode développement
npm test             # tests d'intégration (voir « Tests »)
npm run dist:dir     # application Windows dépliée dans dist/win-unpacked
npm run dist         # installateur NSIS + version portable (nécessite Wine sous Linux)
```

Régénérer l'icône (Python 3 + Pillow) :
```bash
python3 build/make-icon.py
```

---

## Architecture

```
src/
├── main/                      Processus principal (Node.js / Electron)
│   ├── main.js                Fenêtre, IPC, coffre, gestion de la fenêtre
│   ├── vault.js               Coffre chiffré + historique chiffré
│   ├── ssh-manager.js         Connexions SSH, shells, SFTP, tunnels L/R/SOCKS
│   ├── remote-editor.js       Lecture / écriture de fichiers distants (SFTP ou sudo), conflits
│   ├── local-pty.js           Terminaux locaux (ConPTY), détection des shells, sessions détachables
│   ├── lock.js                Verrouillage d'écran : inactivité, filtrage IPC, anti force brute
│   ├── hello.js               Windows Hello (WinRT via PowerShell) + clé DPAPI au démarrage
│   ├── keys.js                Validation des clés privées, empreintes
│   └── ssh-config.js          Import ~/.ssh/config
├── preload.js                 Pont sécurisé renderer ↔ main (contextBridge)
└── renderer/                  Interface (HTML / CSS / JS sans framework)
    ├── index.html
    ├── styles.css
    └── app.js                 Vues, onglets, panneaux, éditeur, palette, préfixe tmux
build/
├── make-icon.py               Génération de l'icône (PNG + ICO multi-tailles)
└── after-pack.js              Injection de l'icône et des infos de version dans le .exe
assets/                        icon.png, icon.ico, icon-1024.png
test/run-tests.js              Tests d'intégration
```

**Principales dépendances** : `electron`, `ssh2` (SSH/SFTP en JavaScript pur), `@xterm/xterm` (+ fit, web-links, search), `@lydell/node-pty` (PTY précompilé, ConPTY sous Windows), `codemirror` 5 (éditeur), `diff` (différences de l'historique), `electron-builder`, `resedit`.

**Flux d'un terminal** : `xterm.js` (renderer) → IPC `ssh:write` → `SshManager` (canal SSH) ou `LocalManager` (PTY) → la sortie revient par l'IPC `term:data`, routée par identifiant de session vers le bon panneau.

---

## Tests

Les tests d'intégration utilisent un **vrai serveur SSH** :

```bash
# Exemple sous Linux : sshd de test sur 127.0.0.1:2222
#   utilisateur kst (sudo avec mot de passe), utilisateur kstnp (sudo NOPASSWD)
#   fichier root:root 640 /etc/kst-test/site.conf dans un dossier 750
KST_HOST=127.0.0.1 KST_PORT=2222 KST_USER=kst KST_PASS='…' \
KST_AUTH_KEYS=/home/kst/.ssh/authorized_keys npm test
```

38 tests couvrent :
- **le coffre** : chiffrement, mauvais mot de passe, changement de mot de passe ;
- **SSH** : TOFU, empreinte modifiée, authentification par mot de passe et par clé avec passphrase, shell interactif ;
- **SFTP** : envoi, téléchargement, renommage, suppression récursive ;
- **l'éditeur** : CRLF, conflit, permission refusée, dossier ouvert par erreur (sélecteur), sudo avec mot de passe, sudo NOPASSWD, mauvais mot de passe, droits et propriétaire conservés, mot de passe jamais écrit dans le fichier, fichier binaire refusé ;
- **l'historique** : chiffrement et re-chiffrement ;
- **les tunnels** : -L, -R, SOCKS5, port déjà occupé, relance automatique après coupure ;
- **le 2FA et les jump hosts** : OTP en 2 tours (mot de passe auto + code), mauvais code, annulation, 2 rebonds jusqu'à un serveur OTP, boucle détectée, bastion injoignable ;
- **la reconnexion** : `exit` = fin propre, coupure TCP = reconnexion ;
- **les terminaux locaux** : lancement, détacher avec mise en tampon, rattacher, terminer ;
- **le verrouillage** : délai d'inactivité, IPC bloqués sauf déverrouillage, anti force brute, vérification du mot de passe, ouverture par clé ;
- **Windows Hello** (simulé hors Windows) : disponibilité, vérification, annulation, Hello non configuré, clé du coffre jamais stockée en clair.

L'interface a aussi été testée de bout en bout avec Playwright (Electron sous Xvfb).

---

## Construire la version Windows

Depuis Linux (sans Wine) :

```bash
npm install
# Binaire PTY Windows précompilé, si npm l'a ignoré sur Linux :
npm pack @lydell/node-pty-win32-x64@1.2.0-beta.15
mkdir -p node_modules/@lydell/node-pty-win32-x64
tar xzf lydell-node-pty-win32-x64-*.tgz -C node_modules/@lydell/node-pty-win32-x64 --strip-components=1
npm run dist:dir     # → dist/win-unpacked/KSTermus.exe (icône et version injectées par build/after-pack.js)
```

`asar` est désactivé pour que ConPTY trouve ses fichiers (`conpty.dll`, `OpenConsole.exe`, worker).

---

## Limites connues

- Les sessions locales détachées s'arrêtent quand KSTermus est fermé : il n'y a pas de serveur en arrière-plan comme avec tmux.
- Pas de synchronisation entre PC : migration manuelle du dossier `%APPDATA%\KSTermus`.
- L'exécutable n'est pas signé : Windows SmartScreen peut afficher un avertissement au premier lancement.
- Les blocs de commandes sont repérés au moment où tu valides une commande avec Entrée. Sans intégration au shell, une commande lancée autrement (historique du shell rappelé par un raccourci propre au shell, par exemple) peut ne pas être repérée.
- Windows Hello : si la fenêtre de vérification s'ouvre derrière KSTermus, elle clignote dans la barre des tâches.
- L'éditeur refuse les fichiers binaires et ceux de plus de 8 Mo.

---

## Historique des versions

| Version | Contenu |
|---|---|
| **1.4.0** | Verrouillage d'écran (sessions conservées) : automatique après inactivité, avec Windows et en veille, `Ctrl+Shift+L` ; déverrouillage Windows Hello (écran, et au démarrage en option) ; recherche dans le terminal (`Ctrl+Shift+F`) ; version affichée sur l'écran de verrouillage ; badge d'authentification des cartes host mieux aligné |
| **1.3.0** | 2FA / OTP (keyboard-interactive), jump hosts multi-rebonds (+ import ProxyJump), reconnexion automatique des terminaux SSH et des tunnels, distinction fin de session / coupure |
| **1.2.2** | Presse-papiers : plus de double collage (Ctrl+Shift+V / Ctrl+V), une seule copie par sélection (plus de doublons dans Win+V), Ctrl+C copie si du texte est sélectionné, Ctrl+V colle sous Windows |
| **1.2.1** | Éditeur : ouvrir un dossier (ex. `/opt/app/`) affiche un sélecteur de fichiers (SFTP ou sudo) avec création de fichier au lieu d'une erreur ; message d'erreur sudo nettoyé |
| **1.2.0** | Terminaux locaux (PowerShell, cmd, WSL, Git Bash), panneaux mixtes local + SSH, préfixe tmux, sessions détachables, espaces de travail, palette de commandes, blocs de commandes, snippets paramétrés, éditeur distant (normal et sudo) avec conflits et CRLF, historique chiffré des éditions, afficher / copier les mots de passe |
| **1.1.0** | Icône intégrée au .exe, split de l'espace de travail, diffusion de la saisie, zoom de panneau, barre de titre intégrée, mémorisation de la fenêtre, instance unique, confirmation à la fermeture |
| **1.0.0** | Première version : hosts, keychain chiffré, terminal SSH, SFTP, snippets, port forwarding, known hosts |

# Directives et Règles Globales du Projet

Ce projet est une extension Chrome développée et exécutée dans un environnement d'entreprise strict. 
Toute modification de code ou ajout de script doit respecter scrupuleusement les règles suivantes.

---

## 1. Respect Strict de Chrome Extension Manifest V3 (MV3)

L'extension doit être 100 % conforme aux spécifications Google Chrome Manifest V3 :

- **Aucun code hébergé à distance (Zero Remote Code) :**
  - L'intégralité du code (scripts JavaScript, CSS, images, bibliothèques tierces) doit être packagée localement dans l'extension.
  - Aucun chargement dynamique de script depuis un CDN ou un serveur distant (`<script src="https://...">` ou `import()` distant formellement interdits).
- **Architecture Service Worker (Background) :**
  - Le script d'arrière-plan fonctionne sous forme de **Service Worker** éphémère.
  - Ne jamais supposer un état persistant en mémoire : utiliser `chrome.storage.local` ou `chrome.storage.session` pour persister les états nécessaires.
  - Ne pas utiliser `window`, `document`, ou d'éléments liés au DOM dans le service worker.
  - Utiliser l'API `chrome.alarms` pour les planifications ou vérifications périodiques, et jamais de `setInterval`/`setTimeout` de longue durée (qui sont tués lors de la mise en veille du service worker).
- **APIs Modernes Manifest V3 :**
  - Utiliser `chrome.action` (et non `chrome.browserAction` ou `chrome.pageAction` qui sont dépréciés).
  - Utiliser `chrome.declarativeNetRequest` si un filtrage/modification de requêtes est nécessaire (à la place de `chrome.webRequestBlocking`).
- **Principe du Moindre Privilège dans `manifest.json` :**
  - Ne demander que les permissions strictement nécessaires (`activeTab`, `storage`, etc.).
  - Restreindre au maximum les `host_permissions`.
- **Politique de Sécurité du Contenu (CSP) stricte :**
  - Aucun script inline dans les fichiers HTML (popup, options, sidepanel) : tous les scripts doivent être dans des fichiers `.js` séparés et attachés via `addEventListener`.
  - Pas d'attributs HTML exécutables (`onclick="..."`, `onload="..."`, etc.).

---

## 2. Sécurité Entreprise & Prévention des Alertes (EDR, Antivirus, SOC, Proxy/DLP)

Le code est exécuté sur un poste de travail professionnel surveillé par des outils de sécurité d'entreprise (EDR, DLP, antivirus, passerelles proxy, SOC). **Aucun script, outil, agent ou processus ne doit générer de faux positifs ni déclencher inutilement d'alertes de sécurité.**

### A. Interdiction totale de l'injection et de l'évaluation dynamique de code
- **Bannissement absolu de `eval()` et de tous ses dérivés :**
  - Interdiction stricte d'utiliser `eval()`, `new Function()`, `setTimeout(string)`, `setInterval(string)` ou tout mécanisme équivalent.
  - Interdiction de contourner cette règle en utilisant une autre méthode d'exécution dynamique ou obfusquée.
  - Toujours privilégier des méthodes sûres comme `JSON.parse()` avec gestion des erreurs (`try/catch`) ou des accès explicites aux propriétés des objets.
- **Aucune exécution dynamique indirecte :**
  - Ne jamais générer, construire ou exécuter dynamiquement du code JavaScript.
  - Ne jamais demander à un IDE, serveur de langage, extension, plugin, agent IA ou outil externe d'exécuter du code JavaScript généré dynamiquement.
  - Cette interdiction s'applique également lorsque l'exécution est effectuée indirectement par un outil ou un processus lancé par l'agent.

### B. Manipulation sécurisée du DOM
- Bannir l'utilisation non sécurisée de `innerHTML`, `outerHTML` ou `document.write()` avec des données non fiables.
- Privilégier systématiquement `textContent`, `document.createElement()`, `classList` et `setAttribute()`.
- Si du rendu HTML dynamique est indispensable, utiliser une bibliothèque de désinfection éprouvée comme DOMPurify.
- Ne jamais injecter directement dans le DOM des données provenant d'une source externe ou non fiable.

### C. Interdiction d'exécuter automatiquement des fichiers ou scripts
- Ne jamais exécuter automatiquement des fichiers `.js`, `.ts`, `.sh`, `.command`, `.py` ou tout autre fichier contenant du code exécutable.
- Ne jamais exécuter de scripts présents sur le Bureau, dans Téléchargements, dans des dossiers temporaires ou dans tout autre emplacement contrôlé par l'utilisateur sans nécessité explicite.
- Avant toute exécution de code, vérifier qu'elle est réellement nécessaire et demander l'autorisation explicite de l'utilisateur si elle n'est pas strictement requise par la tâche.
- Privilégier systématiquement l'analyse statique, la lecture des fichiers, le parsing ou la transformation des données sans exécution lorsque cela est possible.

### D. Interdiction des méthodes d'exécution indirectes ou sensibles
- Ne jamais utiliser `osascript` pour exécuter du JavaScript ou lancer dynamiquement du code.
- Ne jamais utiliser de commandes shell permettant de construire puis d'exécuter dynamiquement du code.
- Ne jamais utiliser de chaînes d'exécution telles que `curl | sh`, `wget | sh` ou toute méthode similaire permettant de télécharger puis d'exécuter du code.
- Ne jamais télécharger puis exécuter automatiquement un script ou un programme.
- Ne jamais utiliser de mécanisme permettant de contourner les restrictions de sécurité du système, de l'EDR, de l'antivirus ou de l'environnement professionnel.

### E. Respect des outils de sécurité de l'entreprise
- Ne jamais désactiver, contourner, modifier ou tenter d'éviter les protections EDR, antivirus, DLP, proxy ou autres mécanismes de sécurité.
- Si une action risque raisonnablement de déclencher une alerte de sécurité, arrêter l'opération et rechercher une alternative plus sûre.
- Si aucune alternative sûre n'existe, demander l'autorisation de l'utilisateur avant toute exécution.
- Ne jamais considérer une alerte de sécurité comme un obstacle à contourner.

### F. Règle de priorité avant toute exécution
Avant d'exécuter une commande, un script ou un outil :
1. Vérifier si l'exécution est réellement nécessaire.
2. Privilégier une méthode statique ou non exécutable lorsqu'elle permet d'obtenir le même résultat.
3. Vérifier que l'action ne repose pas sur une évaluation dynamique de code.
4. Vérifier qu'aucun outil intermédiaire (IDE, serveur de langage, plugin, agent ou extension) ne va exécuter indirectement du code de manière non sécurisée.
5. Utiliser la méthode la moins privilégiée et la moins risquée possible.
6. En cas de doute, ne pas exécuter et demander confirmation à l'utilisateur.

> **Règle absolue :** Aucune fonctionnalité, aucun outil, aucun agent et aucun processus intermédiaire ne doit contourner les règles de sécurité définies dans ce fichier.

### G. Transparence du Code (Zéro Obfuscation)
- **Aucune technique d'obfuscation :**
  - Le code doit être clair, direct, lisible et documenté.
  - Ne jamais utiliser d'encodage suspect de chaînes (ex: chaînes hexadécimales excessives, `\x..`, arrays de caractères masqués, XOR, packers JS).
  - Pas de chaînes Base64 décodées pour être exécutées.
- **Scripts et commandes auxiliaires :**
  - Ne jamais générer de scripts shell/bash douteux (ex: `curl | bash`, téléchargement d'exécutables ou binaires non vérifiés, modification de registres ou fichiers système).
  - Toutes les commandes doivent rester des commandes de développement standard (`npm`, `node`, `git`).

### H. Réseau, Confidentialité et Fuite de Données (DLP / Anti-Exfiltration)
- **Aucun flux réseau non autorisé :**
  - Aucun tracking, analytics tierces (Google Analytics externe, Mixpanel, trackers invisibles), pixels espions, ou requêtes de télémétrie.
  - Toute requête réseau (`fetch`) doit être explicitement justifiée, pointer uniquement vers les endpoints autorisés par le projet, et gérer correctement les erreurs réseau.
- **Protection des Données Sensibles :**
  - Ne jamais journaliser (`console.log`) de données personnelles (PII), jetons d'accès, mots de passe, clés d'API ou données internes de l'entreprise.
  - Ne jamais stocker de données d'authentification ou confidentielles en clair dans des storages non sécurisés.

### I. Isolation des Content Scripts et Communication Sécurisée
- **Vérification de l'expéditeur (Message Passing) :**
  - Dans tous les écouteurs `chrome.runtime.onMessage` ou `chrome.runtime.onConnect`, vérifier l'identité de l'expéditeur :
    ```javascript
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      // S'assurer que le message provient bien de notre propre extension
      if (sender.id !== chrome.runtime.id) {
        return;
      }
      // Valider la structure et le type du message avant traitement
      // ...
    });
    ```
- **Pas d'exposition d'APIs privilégiées :**
  - Ne jamais exposer d'APIs Chrome sensibles aux scripts de la page web hôte via `window.postMessage` sans validation stricte et filtrage des origines.

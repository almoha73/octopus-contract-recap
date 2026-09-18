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

Le code est exécuté sur un poste de travail professionnel surveillé par des outils de sécurité d'entreprise (EDR, DLP, passerelles proxy). **Aucun script ne doit générer de faux positifs ou d'alertes de sécurité.**

### A. Interdiction Totale de l'Injection et Évaluation de Code
- **Bannissement absolu de `eval()` et dérivés :**
  - Interdiction stricte d'utiliser `eval()`, `new Function()`, `setTimeout(string)`, `setInterval(string)`.
  - Toujours utiliser des méthodes sûres comme `JSON.parse()` avec gestion d'erreurs (`try/catch`) ou des accès explicites aux propriétés d'objets.
- **Manipulation sécurisée du DOM :**
  - Bannir l'utilisation non sécurisée de `innerHTML`, `outerHTML`, ou `document.write()` avec des données non fiables.
  - Privilégier systématiquement `textContent`, `document.createElement()`, `classList`, `setAttribute()`.
  - Si du rendu HTML dynamique est indispensable, utiliser une bibliothèque de désinfection éprouvée (ex. DOMPurify).

### B. Transparence du Code (Zéro Obfuscation)
- **Aucune technique d'obfuscation :**
  - Le code doit être clair, direct, lisible et documenté.
  - Ne jamais utiliser d'encodage suspect de chaînes (ex: chaînes hexadécimales excessives, `\x..`, arrays de caractères masqués, XOR, packers JS).
  - Pas de chaînes Base64 décodées pour être exécutées.
- **Scripts et commandes auxiliaires :**
  - Ne jamais générer de scripts shell/bash douteux (ex: `curl | bash`, téléchargement d'exécutables ou binaires non vérifiés, modification de registres ou fichiers système).
  - Toutes les commandes doivent rester des commandes de développement standard (`npm`, `node`, `git`).

### C. Réseau, Confidentialité et Fuite de Données (DLP / Anti-Exfiltration)
- **Aucun flux réseau non autorisé :**
  - Aucun tracking, analytics tierces (Google Analytics externe, Mixpanel, trackers invisibles), pixels espions, ou requêtes de télémétrie.
  - Toute requête réseau (`fetch`) doit être explicitement justifiée, pointer uniquement vers les endpoints autorisés par le projet, et gérer correctement les erreurs réseau.
- **Protection des Données Sensibles :**
  - Ne jamais journaliser (`console.log`) de données personnelles (PII), jetons d'accès, mots de passe, clés d'API ou données internes de l'entreprise.
  - Ne jamais stocker de données d'authentification ou confidentielles en clair dans des storages non sécurisés.

### D. Isolation des Content Scripts et Communication Sécurisée
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

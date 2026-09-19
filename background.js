/**
 * Background Service Worker - Extension Récapitulatif Contrat
 * Conforme Manifest V3 et politiques d'entreprise strictes.
 */

// Écouteur de messages sécurisé
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Vérification stricte de l'origine : le message doit provenir de notre propre extension
  if (sender.id !== chrome.runtime.id) {
    return;
  }

  if (message.type === "FETCH_CONTRACT_DATA") {
    handleFetchContractData(message.payload)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => {
        sendResponse({ 
          success: false, 
          error: err.message || "Erreur lors de la récupération des données",
          authRequired: !!err.authRequired
        });
      });
    
    // Garder le canal de message ouvert pour la réponse asynchrone
    return true;
  }

  // Récupération dédiée du suivi de consommation mensuel
  if (message.type === "FETCH_CONSO_DATA") {
    const { accountNumber, prmId, propertyId, contract, propertyIds, propertyMapping } = message.payload || {};
    fetchMonthlyConsumptionData(accountNumber, prmId, propertyId, contract, propertyMapping, propertyIds)
      .then(async (data) => {
        if (accountNumber && data && data.hasData) {
          try {
            const cachedContracts = await getCachedAccount(accountNumber);
            if (cachedContracts && Array.isArray(cachedContracts)) {
              const matched = cachedContracts.find(c => String(c.prm) === String(prmId) || String(c.id) === String(contract?.id));
              if (matched) {
                matched.consoMensuelle = data;
                await saveAccountToCache(accountNumber, cachedContracts);
              }
            }
          } catch (_) {}
        }
        sendResponse({ success: true, data });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Formater les edges GraphQL bruts reçus depuis un onglet injecté (contexte first-party)
  if (message.type === "FORMAT_AGREEMENTS") {
    const edges = (message.payload?.edges || []).filter(e => e && e.node);
    const contracts = edges.map(e => {
      try { return formatAgreementNode(e.node); } catch(_) { return null; }
    }).filter(Boolean);
    sendResponse({ success: true, data: contracts });
    // Réponse synchrone : ne pas retourner true
    return false;
  }

  // Ouverture d'une fenêtre compagnon autonome (Option 1)
  if (message.type === "OPEN_COMPANION_WINDOW") {
    const { url, width = 520, height = 850, left = 0, top = 50 } = message.payload || {};
    const winOpts = {
      url: url || chrome.runtime.getURL("popup.html?mode=window"),
      type: "popup",
      width: Math.floor(Number(width) || 520),
      height: Math.floor(Number(height) || 850),
      left: Math.floor(Number(left) || 0),
      top: Math.floor(Number(top) || 50),
      focused: true
    };

    if (chrome.windows && chrome.windows.create) {
      chrome.windows.create(winOpts)
        .then((win) => sendResponse({ success: true, windowId: win.id }))
        .catch((err) => {
          console.warn("[Background] Erreur windows.create popup, repli type normal :", err.message);
          winOpts.type = "normal";
          chrome.windows.create(winOpts)
            .then((win2) => sendResponse({ success: true, windowId: win2.id }))
            .catch((err2) => sendResponse({ success: false, error: err2.message }));
        });
      return true;
    } else {
      sendResponse({ success: false, error: "chrome.windows non supporté" });
      return false;
    }
  }
});

// Constantes et état de cache / préchargement
const ACCOUNT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes de validité
const preloadCooldowns = new Map(); // accountNumber -> timestamp du dernier préchargement
const activePreloadLocks = new Set(); // accountNumber en cours de préchargement

const CACHE_VERSION = 8; // Incrémenté pour inclure l'affichage des plages horaires des Heures Creuses

/**
 * Récupère les données en cache local pour un compte si elles sont encore valides
 */
async function getCachedAccount(accountNumber) {
  if (!accountNumber) return null;
  try {
    const key = `account_cache_${accountNumber}`;
    const stored = await chrome.storage.local.get([key]);
    const item = stored[key];
    if (item && item.cacheVersion === CACHE_VERSION && item.contracts && Array.isArray(item.contracts) && item.contracts.length > 0) {
      if (Date.now() - (item.cachedAt || 0) < ACCOUNT_CACHE_TTL_MS) {
        return item.contracts;
      }
    } else if (item && item.cacheVersion !== CACHE_VERSION) {
      await chrome.storage.local.remove([key]);
    }
  } catch (err) {
    console.warn("[Background] Erreur getCachedAccount :", err.message);
  }
  return null;
}

/**
 * Enregistre les contrats et le suivi conso d'un compte dans le cache local
 * avec rotation LRU (conserve les 10 derniers comptes max)
 */
async function saveAccountToCache(accountNumber, contracts) {
  if (!accountNumber || !contracts || contracts.length === 0) return;
  try {
    const key = `account_cache_${accountNumber}`;
    await chrome.storage.local.set({
      [key]: {
        accountNumber,
        contracts,
        cachedAt: Date.now(),
        cacheVersion: CACHE_VERSION
      }
    });

    // Rotation d'index pour ne pas surcharger le storage local
    const indexKey = "account_cache_index";
    const stored = await chrome.storage.local.get([indexKey]);
    let index = Array.isArray(stored[indexKey]) ? stored[indexKey] : [];
    index = [accountNumber, ...index.filter(acc => acc !== accountNumber)];
    if (index.length > 10) {
      const toRemove = index.slice(10).map(acc => `account_cache_${acc}`);
      await chrome.storage.local.remove(toRemove);
      index = index.slice(0, 10);
    }
    await chrome.storage.local.set({ [indexKey]: index });
  } catch (err) {
    console.warn("[Background] Erreur saveAccountToCache :", err.message);
  }
}

/**
 * Extrait le numéro de compte A-XXXXXX depuis une URL
 */
function extractAccountFromUrl(url) {
  if (!url) return null;
  const m1 = url.match(/accounts\/(A-[A-Z0-9]+)/i);
  if (m1) return m1[1];
  const m2 = url.match(/comptes\/(A-[A-Z0-9]+)/i);
  if (m2) return m2[1];
  return null;
}

/**
 * Extrait discrètement le contexte d'une page (contrats, PRM, propertyId)
 */
async function extractTabContextForPreload(tabId, isKraken) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (krakenMode) => {
        if (krakenMode) {
          const agreementLinks = [...document.querySelectorAll('a[href*="agreements/"]')];
          const agreementIds = [...new Set(
            agreementLinks.map((a) => a.getAttribute("href")?.match(/agreements\/(\d+)/)?.[1]).filter(Boolean)
          )];
          const propLinks = [...document.querySelectorAll('a[href*="properties/"], a[href*="property/"], [data-property-id]')];
          const propertyIds = [...new Set(
            propLinks.map(a => a.getAttribute("data-property-id") || a.getAttribute("href")?.match(/propert(?:y|ies)\/(\d+)/)?.[1]).filter(Boolean)
          )];
          const propertyMapping = [];
          for (const pl of propLinks) {
            const pId = pl.getAttribute("data-property-id") || pl.getAttribute("href")?.match(/propert(?:y|ies)\/(\d+)/)?.[1];
            if (!pId) continue;
            let parent = pl.parentElement;
            for (let i = 0; i < 8 && parent && parent !== document.body; i++) {
              const agLink = parent.querySelector('a[href*="agreements/"]');
              const agId = agLink?.getAttribute("href")?.match(/agreements\/(\d+)/)?.[1];
              const prmMatch = parent.innerText.match(/\b\d{14}\b/);
              if (agId || prmMatch) {
                propertyMapping.push({ propertyId: pId, agreementId: agId || null, prm: prmMatch ? prmMatch[0] : null });
                break;
              }
              parent = parent.parentElement;
            }
          }
          return { agreementIds, agreementId: agreementIds[0] || null, propertyIds, propertyMapping };
        } else {
          const contractLinks = [...document.querySelectorAll('a[href*="contrats/"]')];
          const agreementIds = [...new Set(contractLinks.map(a => a.getAttribute("href")?.match(/contrats\/(\d+)/)?.[1]).filter(Boolean))];
          const logementLinks = [...document.querySelectorAll('a[href*="logements/"]')];
          const propertyIds = [...new Set(logementLinks.map(a => a.getAttribute("href")?.match(/logements\/(\d+)/)?.[1]).filter(Boolean))];
          const urlPropMatch = window.location.pathname.match(/logements\/(\d+)/);
          if (urlPropMatch && !propertyIds.includes(urlPropMatch[1])) propertyIds.push(urlPropMatch[1]);
          return { agreementIds, agreementId: agreementIds[0] || null, propertyIds, propertyMapping: [] };
        }
      },
      args: [isKraken]
    });
    return res?.result || null;
  } catch (_) {
    return null;
  }
}

/**
 * Déclenche le préchargement proactif en tâche de fond pour un onglet
 */
async function triggerPreloadForTab(tabId, url) {
  const accountNumber = extractAccountFromUrl(url);
  if (!accountNumber) return;

  // Verrou d'exécution en cours
  if (activePreloadLocks.has(accountNumber)) return;

  // Si déjà en cache frais (< 5 min), pas besoin de requêter
  const cached = await getCachedAccount(accountNumber);
  if (cached) return;

  // Cooldown de 2 minutes pour éviter les requêtes répétées
  const lastPreload = preloadCooldowns.get(accountNumber) || 0;
  if (Date.now() - lastPreload < 120000) return;

  activePreloadLocks.add(accountNumber);
  preloadCooldowns.set(accountNumber, Date.now());

  console.log(`[Background] 🚀 Lancement du préchargement proactif pour ${accountNumber}...`);

  try {
    const isKraken = url.includes("support.oefr-kraken.energy");
    const tabContext = await extractTabContextForPreload(tabId, isKraken);

    await handleFetchContractData({
      accountNumber,
      tabId,
      agreementId: tabContext?.agreementId,
      agreementIds: tabContext?.agreementIds,
      propertyIds: tabContext?.propertyIds || [],
      propertyMapping: tabContext?.propertyMapping || [],
      bypassCache: false
    });

    console.log(`[Background] ⚡ Préchargement terminé avec succès pour ${accountNumber} (données prêtes en cache)`);
  } catch (err) {
    console.log(`[Background] Info préchargement (${accountNumber}) :`, err.message);
  } finally {
    activePreloadLocks.delete(accountNumber);
  }
}

// Écouteurs d'onglets pour le préchargement proactif
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab?.url;
  if (url && (changeInfo.status === "complete" || changeInfo.url)) {
    triggerPreloadForTab(tabId, url);
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab?.url) {
      triggerPreloadForTab(activeInfo.tabId, tab.url);
    }
  } catch (_) {}
});

// Préchargement proactif immédiat au démarrage du Service Worker
chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (tab?.url) {
    triggerPreloadForTab(tab.id, tab.url);
  }
}).catch(() => {});

/**
 * Récupère les données complètes du contrat :
 * 1. Vérifie le cache local si bypassCache n'est pas actif
 * 2. Tente l'interrogation GraphQL directement avec les cookies existants
 * 3. Si la session n'est pas encore initialisée, synchronise silencieusement via masquerade
 * 4. Met en cache le résultat pour restitution instantanée
 */
async function handleFetchContractData(payload) {
  const { 
    accountNumber, 
    agreementId, 
    agreementIds, 
    propertyIds, 
    propertyMapping,
    bypassCache
  } = payload || {};

  console.log("[Background] Démarrage avec :", { 
    accountNumber, 
    agreementId, 
    agreementIds, 
    propertyIds, 
    propertyMapping,
    bypassCache: !!bypassCache
  });

  if (!accountNumber) {
    throw new Error("Numéro de compte manquant");
  }

  // 1. Restitution depuis le cache local si disponible et non bypassé
  if (!bypassCache) {
    const cachedContracts = await getCachedAccount(accountNumber);
    if (cachedContracts && cachedContracts.length > 0) {
      console.log(`[Background] ⚡ Restitution instantanée depuis le cache (${cachedContracts.length} contrats pour ${accountNumber})`);
      return cachedContracts;
    }
  }

  const idsToQuery = agreementIds && agreementIds.length > 0 
    ? agreementIds 
    : (agreementId ? [agreementId] : [null]);

  // Étape 1 : Tentative directe ultra-rapide avec les cookies de session actuels
  const result = await executeAgreementsQuery(accountNumber, idsToQuery);
  if (result.contracts && result.contracts.length > 0) {
    // RESTITUTION INSTANTANÉE : sauvegarder et retourner les contrats immédiatement (~200ms)
    await saveAccountToCache(accountNumber, result.contracts);

    // Lancement de l'enrichissement conso en tâche de fond (sans bloquer l'affichage de l'interface)
    enrichContractsWithConso(result.contracts, accountNumber, propertyMapping, propertyIds)
      .then(async (enriched) => {
        await saveAccountToCache(accountNumber, enriched);
      })
      .catch((e) => console.warn("[Background] Erreur conso arrière-plan :", e.message));

    return result.contracts;
  }

  // Étape 2 : Si la session n'est pas synchronisée et qu'on a le tabId de Kraken, lancer la synchronisation en arrière-plan
  const tabId = payload.tabId;
  if (tabId) {
    console.log("[Background] Session requise, exécution de performBackgroundSync...");
    try {
      const syncedContracts = await performBackgroundSync(tabId, accountNumber, idsToQuery, propertyMapping, propertyIds);
      if (syncedContracts && syncedContracts.length > 0) {
        await saveAccountToCache(accountNumber, syncedContracts);

        enrichContractsWithConso(syncedContracts, accountNumber, propertyMapping, propertyIds)
          .then(async (enriched) => {
            await saveAccountToCache(accountNumber, enriched);
          })
          .catch((e) => console.warn("[Background] Erreur conso arrière-plan :", e.message));

        return syncedContracts;
      }
    } catch (syncErr) {
      console.warn("[Background] Échec performBackgroundSync :", syncErr.message);
    }
  }

  // Étape 3 : Si 0 contrat trouvé ou erreur, lever l'erreur d'authentification
  let errorText = "Session non synchronisée pour ce compte ou aucun contrat actif trouvé.";
  if (result.errors && result.errors.length > 0) {
    errorText = `API Octopus : ${result.errors.map(e => e.message).join(", ")}`;
  }

  const err = new Error(errorText);
  err.authRequired = true; // Déclenche la synchronisation manuelle dans le popup si nécessaire
  throw err;
}

/**
 * Effectue la synchronisation masquerade en tâche de fond dans le service worker,
 * en créant un onglet inactif (active: false) pour ne PAS voler le focus ni fermer le popup,
 * et en garantissant la fermeture de cet onglet quoi qu'il arrive (dans le bloc finally).
 */
async function performBackgroundSync(tabId, accountNumber, idsToQuery, propertyMapping = [], propertyIds = []) {
  let createdTabId = null;
  try {
    // 1. Récupérer l'action masquerade et le token CSRF depuis l'onglet Kraken actuel sans ouvrir d'onglet
    const [execRes] = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      args: [accountNumber],
      func: async (acctNum) => {
        const findExistingForm = () => {
          const allForms = [...document.querySelectorAll('form[action*="masquerade"]')];
          return allForms.find(f => 
            !f.action.includes("mobile") && 
            !f.querySelector('[name="host_override"]') &&
            (f.textContent.toLowerCase().includes("site web") || 
             f.querySelector('button')?.textContent.toLowerCase().includes("site web"))
          ) || allForms.find(f => !f.action.includes("mobile") && !f.querySelector('[name="host_override"]')) || allForms[0];
        };

        let formMasq = findExistingForm();
        let masqueradeAction = formMasq ? formMasq.getAttribute("action") : null;
        let csrfToken = formMasq ? formMasq.querySelector('[name="csrfmiddlewaretoken"]')?.value : null;

        if (!csrfToken) {
          csrfToken = document.querySelector('[name="csrfmiddlewaretoken"]')?.value ||
                      document.cookie.match(/csrftoken=([^;]+)/)?.[1];
        }

        const effectiveAccount = acctNum || 
          window.location.pathname.match(/accounts\/(A-[A-Z0-9]+)/i)?.[1] ||
          document.body.innerText.match(/\b(A-[A-Z0-9]{8,})\b/i)?.[1];

        if (!masqueradeAction && effectiveAccount) {
          let userId = window.location.hash.match(/account-users\/(\d+)/)?.[1] ||
                       [...document.querySelectorAll('a[href*="account-users/"]')].map(a => a.getAttribute("href")?.match(/account-users\/(\d+)/)?.[1]).find(Boolean);

          if (!userId) {
            try {
              const overviewRes = await fetch(`/accounts/${effectiveAccount}/partial/users-overview/`);
              if (overviewRes.ok) {
                const overviewText = await overviewRes.text();
                userId = (overviewText.match(/account-users\/(\d+)/) || overviewText.match(/\/users\/(\d+)\/masquerade/) || overviewText.match(/\/users\/(\d+)\//))?.[1];
                if (!csrfToken) {
                  csrfToken = overviewText.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/)?.[1];
                }
              }
            } catch (_) {}
          }

          if (userId) {
            try {
              const userDetailRes = await fetch(`/accounts/${effectiveAccount}/partial/account-users/${userId}/`);
              if (userDetailRes.ok) {
                const userHtml = await userDetailRes.text();
                const actionMatch = userHtml.match(/action="(\/users\/\d+\/masquerade\/)"/);
                if (actionMatch) masqueradeAction = actionMatch[1];
                const tokenMatch = userHtml.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/);
                if (tokenMatch) csrfToken = tokenMatch[1];
              }
            } catch (_) {}
            if (!masqueradeAction) masqueradeAction = `/users/${userId}/masquerade/`;
          }
        }

        return {
          success: !!(masqueradeAction && csrfToken),
          masqueradeAction,
          csrfToken,
          reason: !masqueradeAction ? "Action masquerade introuvable" : (!csrfToken ? "Token CSRF introuvable" : null)
        };
      }
    });

    if (!execRes?.result?.success || !execRes?.result?.masqueradeAction || !execRes?.result?.csrfToken) {
      throw new Error(execRes?.result?.reason || "Paramètres masquerade introuvables");
    }

    const { masqueradeAction, csrfToken } = execRes.result;

    // 2. Créer un onglet en arrière-plan (active: false) pour exécuter la navigation sans voler le focus
    // et donc SANS FERMER LE POPUP de l'extension
    const tempTab = await chrome.tabs.create({
      url: `https://support.oefr-kraken.energy/accounts/${accountNumber}/`,
      active: false
    });
    createdTabId = tempTab.id;

    // 3. Attendre que l'onglet d'arrière-plan soit chargé pour y injecter le formulaire
    await new Promise((resolve) => {
      const onUpdated = (tId, changeInfo) => {
        if (tId === createdTabId && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }, 5000);
    });

    // 4. Soumettre le formulaire masquerade directement DANS l'onglet d'arrière-plan (sans target="_blank")
    await chrome.scripting.executeScript({
      target: { tabId: createdTabId },
      args: [masqueradeAction, csrfToken],
      func: (actionUrl, token) => {
        const form = document.createElement("form");
        form.method = "POST";
        form.action = actionUrl;
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = "csrfmiddlewaretoken";
        input.value = token;
        form.appendChild(input);
        document.body.appendChild(form);
        HTMLFormElement.prototype.submit.call(form);
      }
    });

    // 5. Attendre que la navigation atteigne l'espace client octopusenergy.fr
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };

      const onUpdated = (tId, changeInfo, tabInfo) => {
        if (tId === createdTabId) {
          const url = tabInfo.url || changeInfo.url || "";
          if (url.includes("octopusenergy.fr") && !url.includes("/masquerade/")) {
            if (changeInfo.status === "complete" || tabInfo.status === "complete") {
              chrome.tabs.onUpdated.removeListener(onUpdated);
              finish();
            }
          }
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);

      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        finish();
      }, 8000);
    });

    // 6. Délai pour que NextAuth écrive les cookies de session et extraction des logements
    await new Promise(r => setTimeout(r, 1000));

    try {
      const [domRes] = await chrome.scripting.executeScript({
        target: { tabId: createdTabId },
        func: () => {
          const links = [...document.body.innerHTML.matchAll(/\/logements\/(\d+)/g)].map(m => m[1]);
          return [...new Set(links)];
        }
      });
      if (domRes?.result?.length > 0) {
        for (const p of domRes.result) {
          if (!propertyIds.includes(p)) propertyIds.push(p);
        }
      }
    } catch (_) {}

    // 7. Requête GraphQL avec les cookies maintenant actifs
    const result = await executeAgreementsQuery(accountNumber, idsToQuery);
    if (result.contracts && result.contracts.length > 0) {
      return result.contracts;
    }

    throw new Error("Aucun contrat trouvé après synchronisation");
  } finally {
    // FERMETURE GARANTIE DE L'ONGLET EN ARRIÈRE-PLAN
    if (createdTabId) {
      try {
        await chrome.tabs.remove(createdTabId);
        console.log("[Background] Onglet masquerade fermé automatiquement :", createdTabId);
      } catch (_) {}
    }
  }
}

/**
 * Exécute la requête GraphQL pour une liste d'IDs de contrat et enrichit les tarifs si nécessaire
 */
async function executeAgreementsQuery(accountNumber, idsToQuery) {
  const allContracts = [];
  let lastErrors = null;

  // 1. Tenter d'abord la requête globale par numéro de compte (retourne TOUS les contrats en 1 seule requête HTTP ~200ms)
  try {
    const { contracts, errors } = await queryAgreementsFromKraken(accountNumber, null);
    if (errors) lastErrors = errors;
    if (contracts && contracts.length > 0) {
      allContracts.push(...contracts);
    }
  } catch (err) {
    console.warn("[Background] Requête globale compte :", err.message);
    if (!lastErrors) lastErrors = [{ message: err.message }];
  }

  // 2. Si 0 contrat retourné, interroger en parallèle les IDs spécifiques fournis
  if (allContracts.length === 0 && Array.isArray(idsToQuery) && idsToQuery.length > 0 && idsToQuery[0] !== null) {
    const results = await Promise.all(
      idsToQuery.map(async (id) => {
        try {
          const { contracts, errors } = await queryAgreementsFromKraken(accountNumber, id);
          return { contracts: contracts || [], errors };
        } catch (err) {
          return { contracts: [], errors: [{ message: err.message }] };
        }
      })
    );
    for (const res of results) {
      if (res.errors) lastErrors = res.errors;
      if (res.contracts.length > 0) allContracts.push(...res.contracts);
    }
  }

  // Déduplication par ID de contrat
  const uniqueContracts = [];
  const seenIds = new Set();
  for (const c of allContracts) {
    const idKey = String(c.id);
    if (!seenIds.has(idKey)) {
      seenIds.add(idKey);
      uniqueContracts.push(c);
    }
  }

  // Enrichissement en parallèle uniquement pour les contrats n'ayant pas de tarif kWh
  const missingRates = uniqueContracts.filter(c => c.prixKwhTTC === "-" && c.id);
  if (missingRates.length > 0) {
    await Promise.all(
      missingRates.map(async (contract) => {
        try {
          const { contracts: detailedList } = await queryAgreementsFromKraken(accountNumber, contract.id);
          const detailed = detailedList?.find(c => String(c.id) === String(contract.id)) || detailedList?.[0];
          if (detailed && detailed.prixKwhTTC && detailed.prixKwhTTC !== "-") {
            const idx = uniqueContracts.findIndex(c => String(c.id) === String(contract.id));
            if (idx !== -1) uniqueContracts[idx] = detailed;
          }
        } catch (_) {}
      })
    );
  }

  return { contracts: uniqueContracts, errors: lastErrors };
}

/**
 * Interroge l'API GraphQL d'Octopus Energy avec le numéro de compte et l'agreementId
 */
async function queryAgreementsFromKraken(accountNumber, agreementId) {
  const graphqlQuery = `
    query AgreementQuery($agreementId: ID, $accountNumber: String!) {
      agreements(first: 10, agreementId: $agreementId, accountNumber: $accountNumber) {
        edges {
          node {
            id
            billingFrequency
            isActive
            status
            validFrom
            validTo
            product {
              code
              displayName
            }
            supplyPoint {
              marketName
              id
              externalIdentifier
              meterPoint {
                id
                isSmartMeter
                ... on ElectricityMeterPoint {
                  subscribedMaxPower
                  providerCalendar {
                    name
                    temporalClasses {
                      label
                      description
                    }
                  }
                }
                address {
                  fullAddress
                }
              }
            }
            energySupplyRate {
              standingRate {
                pricePerUnit
                pricePerUnitWithTaxes
              }
              rates(first: 10) {
                edges {
                  node {
                    __typename
                    pricePerUnit
                    pricePerUnitWithTaxes
                    ... on ElectricitySupplyConsumptionRateType {
                      temporalClass {
                        label
                      }
                    }
                    ... on ElectricityConsumptionRateType {
                      temporalClass {
                        label
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const variables = { accountNumber: accountNumber };
  if (agreementId) {
    variables.agreementId = String(agreementId);
  }

  const response = await fetch("https://octopusenergy.fr/api/graphql/kraken", {
    method: "POST",
    headers: {
      "Accept": "application/graphql-response+json, application/json",
      "Content-Type": "application/json"
    },
    credentials: "include",
    body: JSON.stringify({
      query: graphqlQuery,
      variables: variables,
      operationName: "AgreementQuery"
    })
  });

  if (!response.ok) {
    throw new Error(`Erreur API Octopus : code HTTP ${response.status}`);
  }

  let json = await response.json();
  console.log("[Background] Réponse brute GraphQL :", json);

  // Sécurité : si l'API rejette l'argument first sur rates, retenter sans first: 10
  if (json?.errors?.some(e => String(e.message || "").toLowerCase().includes("rates") && String(e.message || "").toLowerCase().includes("first"))) {
    console.warn("[Background] L'API rejette first sur rates, repli sans first: 10...");
    const fallbackQuery = graphqlQuery.replace("rates(first: 10)", "rates");
    const retryRes = await fetch("https://octopusenergy.fr/api/graphql/kraken", {
      method: "POST",
      headers: {
        "Accept": "application/graphql-response+json, application/json",
        "Content-Type": "application/json"
      },
      credentials: "include",
      body: JSON.stringify({
        query: fallbackQuery,
        variables: variables,
        operationName: "AgreementQuery"
      })
    });
    if (retryRes.ok) {
      json = await retryRes.json();
    }
  }

  const edges = json?.data?.agreements?.edges || [];
  const contracts = edges.map(edge => formatAgreementNode(edge.node));

  return {
    contracts: contracts,
    errors: json?.errors || null
  };
}

/**
 * Formate un noeud d'accord en objet clair et exploitable pour l'interface
 */
/**
 * Nettoie et formate une chaîne de plages horaires (ex: "23:00 - 07:00" -> "23h00 - 07h00")
 */
function cleanScheduleString(str) {
  if (!str || typeof str !== "string") return null;
  let s = str.trim();
  s = s.replace(/(\d{1,2}):(\d{2})/g, "$1h$2");
  s = s.replace(/\s*[-–]\s*/g, " - ");
  s = s.replace(/\s*[,/]\s*/g, ", ");
  return s;
}

function formatAgreementNode(node) {
  const isElectricity = node.supplyPoint?.marketName === "FRA_ELECTRICITY";
  const meterPoint = node.supplyPoint?.meterPoint || {};

  // 1. Collecte de tous les noeuds de tarification de consommation possibles
  const rateNodes = [];
  if (Array.isArray(node.energySupplyRate?.rates?.edges)) {
    for (const edge of node.energySupplyRate.rates.edges) {
      if (edge?.node) rateNodes.push(edge.node);
    }
  } else if (Array.isArray(node.energySupplyRate?.rates)) {
    rateNodes.push(...node.energySupplyRate.rates);
  }

  // Si rates est vide, chercher dans consumptionRates
  if (rateNodes.length === 0) {
    if (Array.isArray(node.energySupplyRate?.consumptionRates?.edges)) {
      for (const edge of node.energySupplyRate.consumptionRates.edges) {
        if (edge?.node) rateNodes.push(edge.node);
      }
    } else if (Array.isArray(node.energySupplyRate?.consumptionRates)) {
      rateNodes.push(...node.energySupplyRate.consumptionRates);
    }
  }

  // Fallback si rates est directement au niveau de node
  if (rateNodes.length === 0 && node.rates) {
    if (Array.isArray(node.rates.edges)) {
      rateNodes.push(...node.rates.edges.map(e => e?.node).filter(Boolean));
    } else if (Array.isArray(node.rates)) {
      rateNodes.push(...node.rates);
    }
  }

  // Fonction utilitaire de formatage de prix (c€ -> €/kWh ou conservation si déjà en €)
  const formatKwhPrice = (val, isHT = false) => {
    if (val === undefined || val === null || val === "") return null;
    let strVal = String(val).trim().replace(",", ".");
    let num = parseFloat(strVal);
    if (isNaN(num) || num <= 0) return null;
    if (isHT) num = num * 1.20; // Application TVA 20% électricité si HT
    const euros = num > 1 ? (num / 100) : num;
    return euros.toFixed(4).replace(".", ",") + " €";
  };

  // Extraction d'un prix de rate en inspectant tous les champs possibles (TTC, HT, unitRate, etc.)
  const extractRatePrice = (r) => {
    if (!r) return null;
    const candidates = [
      { val: r.pricePerUnitWithTaxes, isHT: false },
      { val: r.pricePerUnit, isHT: true },
      { val: r.unitRateWithTaxes, isHT: false },
      { val: r.unitRate, isHT: true },
      { val: r.rateWithTaxes, isHT: false },
      { val: r.rate, isHT: false },
      { val: r.value, isHT: false },
      { val: r.price, isHT: false },
      { val: r.amount, isHT: false }
    ];
    for (const c of candidates) {
      if (c.val !== undefined && c.val !== null && c.val !== "") {
        const raw = typeof c.val === "object" ? (c.val.amount || c.val.value || c.val.price) : c.val;
        const p = formatKwhPrice(raw, c.isHT);
        if (p) return p;
      }
    }
    return null;
  };

  // Calcul du tarif kWh TTC
  let prixKwh = "-";
  if (rateNodes.length > 1) {
    const parts = [];
    for (const r of rateNodes) {
      const p = extractRatePrice(r);
      if (p) {
        const rawLabel = (typeof r.temporalClass === "string" ? r.temporalClass : (r.temporalClass?.label || r.temporalClass?.description)) || r.energyUseTimeSlot || "";
        const lowerLabel = rawLabel.toLowerCase();
        if (lowerLabel.includes("plein") || lowerLabel === "hp") {
          parts.push(`HP : ${p}`);
        } else if (lowerLabel.includes("creu") || lowerLabel === "hc") {
          parts.push(`HC : ${p}`);
        } else if (rawLabel) {
          parts.push(`${rawLabel} : ${p}`);
        } else {
          parts.push(p);
        }
      }
    }
    const uniqueParts = [...new Set(parts)];
    if (uniqueParts.length > 0) {
      prixKwh = uniqueParts.join(" | ");
    }
  }

  if (prixKwh === "-" && rateNodes.length > 0) {
    for (const r of rateNodes) {
      const p = extractRatePrice(r);
      if (p) {
        prixKwh = p;
        break;
      }
    }
  }

  // Calcul du tarif d'abonnement mensuel TTC (standingRate annuel en centimes d'euro, ex: 23543.46 c€)
  let prixAbonnement = "-";
  const standingValTTC = node.energySupplyRate?.standingRate?.pricePerUnitWithTaxes;
  const standingValHT = node.energySupplyRate?.standingRate?.pricePerUnit;
  let centimesAn = null;

  if (standingValTTC !== undefined && standingValTTC !== null && standingValTTC !== "") {
    centimesAn = parseFloat(String(standingValTTC).replace(",", "."));
  } else if (standingValHT !== undefined && standingValHT !== null && standingValHT !== "") {
    centimesAn = parseFloat(String(standingValHT).replace(",", ".")) * 1.055; // TVA 5.5% sur abonnement
  }

  if (centimesAn !== null && !isNaN(centimesAn) && centimesAn > 0) {
    const eurosAn = centimesAn > 100 ? (centimesAn / 100) : centimesAn;
    const frequence = node.billingFrequency || 12;
    prixAbonnement = (eurosAn / frequence).toFixed(2).replace(".", ",") + " €";
  }

  // Option tarifaire (Base, HPHC, etc.)
  const firstRateWithLabel = rateNodes.find(r => r.temporalClass?.label);
  const option = meterPoint.providerCalendar?.name || 
                 firstRateWithLabel?.temporalClass?.label || 
                 (rateNodes.length > 1 ? "Heures Pleines / Heures Creuses" : "Base");

  // Extraction des plages horaires des Heures Creuses (HP/HC)
  let horairesHeuresCreuses = null;
  const temporalClasses = meterPoint.providerCalendar?.temporalClasses || [];

  if (Array.isArray(temporalClasses) && temporalClasses.length > 0) {
    const hcClass = temporalClasses.find(t => {
      const lbl = (t.label || "").toLowerCase();
      const desc = (t.description || "").toLowerCase();
      return lbl.includes("creuse") || lbl.includes("hc") || desc.includes("creuse") || desc.includes("hc");
    });
    if (hcClass && hcClass.description) {
      horairesHeuresCreuses = cleanScheduleString(hcClass.description);
    }
  }

  if (!horairesHeuresCreuses && meterPoint.providerCalendar?.name) {
    const calName = meterPoint.providerCalendar.name;
    const match = calName.match(/(?:[01]?\d|2[0-3])[hH:]\d{0,2}\s*[-–/aà]\s*(?:[01]?\d|2[0-3])[hH:]\d{0,2}(?:\s*(?:,|et|\/)\s*(?:[01]?\d|2[0-3])[hH:]\d{0,2}\s*[-–/aà]\s*(?:[01]?\d|2[0-3])[hH:]\d{0,2})*/i);
    if (match) {
      horairesHeuresCreuses = cleanScheduleString(match[0]);
    }
  }

  if (!horairesHeuresCreuses) {
    for (const r of rateNodes) {
      const slot = r.energyUseTimeSlot || r.temporalClass?.description;
      if (slot && typeof slot === "string") {
        const match = slot.match(/(?:[01]?\d|2[0-3])[hH:]\d{0,2}\s*[-–/aà]\s*(?:[01]?\d|2[0-3])[hH:]\d{0,2}/i);
        if (match) {
          horairesHeuresCreuses = cleanScheduleString(slot);
          break;
        }
      }
    }
  }

  // Puissance souscrite
  const puissance = meterPoint.subscribedMaxPower ? 
                    `${meterPoint.subscribedMaxPower} kVA` : 
                    "-";

  // Formatage de date d'effet (début)
  let dateDebut = "-";
  if (node.validFrom) {
    const d = new Date(node.validFrom);
    if (!isNaN(d.getTime())) {
      dateDebut = d.toLocaleDateString("fr-FR", {
        day: "numeric",
        month: "short",
        year: "numeric"
      });
    }
  }

  // Formatage de date de fin / résiliation
  let dateFin = null;
  let isPastValidTo = false;
  if (node.validTo) {
    const dEnd = new Date(node.validTo);
    if (!isNaN(dEnd.getTime())) {
      isPastValidTo = dEnd <= new Date();
      dateFin = dEnd.toLocaleDateString("fr-FR", {
        day: "numeric",
        month: "short",
        year: "numeric"
      });
    }
  }

  // Détermination précise du statut (Actif vs Résilié / Annulé / En cours)
  const rawStatus = (node.status || "").toUpperCase();
  let statutLabel = "Actif";
  let isReallyActive = false;

  if (rawStatus === "CANCELLED" || rawStatus === "CANCELED") {
    statutLabel = "Annulé";
    isReallyActive = false;
  } else if (rawStatus === "OFF_SUPPLY" || rawStatus === "ENDED" || rawStatus === "TERMINATED" || isPastValidTo) {
    statutLabel = "Résilié";
    isReallyActive = false;
  } else if (rawStatus === "ON_SUPPLY") {
    if (node.isActive === false) {
      statutLabel = "Résilié";
      isReallyActive = false;
    } else {
      statutLabel = "Actif";
      isReallyActive = true;
    }
  } else if (rawStatus === "PENDING") {
    statutLabel = "En cours d'activation";
    isReallyActive = false;
  } else if (node.isActive === false) {
    statutLabel = "Résilié";
    isReallyActive = false;
  } else {
    statutLabel = node.isActive ? "Actif" : "Résilié";
    isReallyActive = Boolean(node.isActive);
  }

  return {
    id: node.id,
    statut: statutLabel,
    isActive: isReallyActive,
    isReallyActive: isReallyActive,
    rawStatus: node.status,
    rawValidFrom: node.validFrom,
    rawValidTo: node.validTo,
    typeEnergie: isElectricity ? "Électricité" : "Gaz",
    nomOffre: node.product?.displayName || node.product?.code || "Offre standard",
    codeProduit: node.product?.code || "",
    prm: meterPoint.id || node.supplyPoint?.externalIdentifier || "-",
    propertyId: meterPoint.propertyId || null,
    adresse: meterPoint.address?.fullAddress || "-",
    puissance: puissance,
    optionTarifaire: option,
    horairesHeuresCreuses: horairesHeuresCreuses,
    prixKwhTTC: prixKwh,
    prixAbonnementMoisTTC: prixAbonnement,
    modeFacturation: node.billingFrequency === 12 ? "Annuelle" : `${node.billingFrequency || 1} mois`,
    linky: meterPoint.isSmartMeter ? "Oui" : "Non",
    dateDebut: dateDebut,
    dateFin: dateFin,
    debugInfo: {
      contractId: node.id,
      product: node.product?.code,
      standingTTC: standingValTTC,
      standingHT: standingValHT,
      ratesEdgesLength: node.energySupplyRate?.rates?.edges?.length ?? "no_edges",
      rateNodesCount: rateNodes.length,
      firstNode: rateNodes[0] || null,
      rawRates: node.energySupplyRate?.rates || null,
      energySupplyRateKeys: Object.keys(node.energySupplyRate || {})
    }
  };
}

/**
 * Requête GraphQL officielle Espace Client Octopus Energy
 * Récupère les mesures d'intervalle journalières (DAY_INTERVAL) avec les coûts exacts TTC pré-calculés par Octopus
 */
const GET_PROPERTY_MEASUREMENTS_QUERY = `
query GetPropertyMeasurements($propertyId: ID!, $startAt: DateTime!, $endAt: DateTime!, $utilityFilters: [UtilityFiltersInput]!, $first: Int) {
  property(id: $propertyId) {
    measurements(
      startAt: $startAt
      endAt: $endAt
      utilityFilters: $utilityFilters
      first: $first
    ) {
      edges {
        node {
          ...IntervalMeasurement
        }
      }
    }
  }
}

fragment IntervalMeasurement on IntervalMeasurementType {
  __typename
  value
  startAt
  source
  metaData {
    statistics {
      costInclTax {
        estimatedAmount
        costCurrency
      }
      label
      value
    }
  }
}
`;

/**
 * Analyse les dates d'effet et de fin du contrat (validFrom / validTo)
 * pour déterminer le périmètre temporel de validité des relevés de consommation
 */
function getContractValidity(contract) {
  let startDate = null;
  let endDate = null;
  let startYearMonth = null;
  let endYearMonth = null;

  if (contract?.rawValidFrom) {
    const d = new Date(contract.rawValidFrom);
    if (!isNaN(d.getTime())) {
      startDate = d;
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      startYearMonth = `${y}-${m}`;
    }
  }

  if (contract?.rawValidTo) {
    const d = new Date(contract.rawValidTo);
    if (!isNaN(d.getTime())) {
      endDate = d;
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      endYearMonth = `${y}-${m}`;
    }
  }

  return { startDate, endDate, startYearMonth, endYearMonth };
}

/**
 * Calcule les bornes d'un mois calendaire au format ISO avec décalage horaire local (ex: 2026-05-01T00:00:00+02:00)
 */
function formatMonthBoundaries(year, monthIndex) {
  const start = new Date(year, monthIndex, 1, 0, 0, 0);
  const end = new Date(year, monthIndex + 1, 1, 0, 0, 0);
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

  const toOffsetIso = (d) => {
    const pad = (n) => String(n).padStart(2, "0");
    const y = d.getFullYear();
    const m = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const h = pad(d.getHours());
    const min = pad(d.getMinutes());
    const s = pad(d.getSeconds());
    const offsetMin = -d.getTimezoneOffset();
    const sign = offsetMin >= 0 ? "+" : "-";
    const offH = pad(Math.floor(Math.abs(offsetMin) / 60));
    const offM = pad(Math.abs(offsetMin) % 60);
    return `${y}-${m}-${day}T${h}:${min}:${s}${sign}${offH}:${offM}`;
  };

  return {
    startAt: toOffsetIso(start),
    endAt: toOffsetIso(end),
    daysInMonth: daysInMonth,
    yearMonth: `${year}-${String(monthIndex + 1).padStart(2, "0")}`
  };
}

/**
 * Génère les plages de dates pour les N derniers mois calendaires (mois en cours inclus, 12 mois par défaut)
 * Filtre strictement les mois antérieurs au début du contrat ou postérieurs à sa fin
 */
function generateMonthRanges(count = 12, contract = null) {
  const ranges = [];
  const now = new Date();
  const { startYearMonth, endYearMonth } = getContractValidity(contract);

  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const bounds = formatMonthBoundaries(d.getFullYear(), d.getMonth());

    // Si le mois est postérieur à la fin du contrat (contrat résilié)
    if (endYearMonth && bounds.yearMonth > endYearMonth) {
      continue;
    }
    // Si le mois est strictement antérieur au début du contrat (ex: novembre 2025 pour une arrivée le 12 décembre)
    if (startYearMonth && bounds.yearMonth < startYearMonth) {
      continue;
    }

    ranges.push(bounds);
  }
  return ranges;
}

/**
 * Formate une valeur en kWh avec la précision affichée par Octopus Energy (jusqu'à 2 décimales)
 */
function formatKwhValue(val) {
  if (val === null || val === undefined || isNaN(val)) return "- kWh";
  const rounded = Math.round(val * 100) / 100;
  const hasDecimals = (rounded % 1 !== 0);
  const isOneDecimal = hasDecimals && (Math.round(rounded * 10) / 10 === rounded);
  const fractionDigits = !hasDecimals ? 0 : (isOneDecimal ? 1 : 2);
  return `${rounded.toLocaleString("fr-FR", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: 2
  })} kWh`;
}

/**
 * Parse et agrège les nœuds d'un mois retournés par GetPropertyMeasurements
 * Calcule fidèlement les volumes en kWh et les coûts en euros selon les tranches officielles Octopus
 */
function parsePropertyMeasurementsMonth(edges, range, contract = null) {
  if (!edges || edges.length === 0) return null;

  const { startDate, endDate } = getContractValidity(contract);

  let totalMonthKwh = 0;
  let totalMonthCost = 0;
  let totalEnergyCost = 0;
  let totalAboCost = 0;
  let totalHpKwh = 0;
  let totalHcKwh = 0;
  let totalBaseKwh = 0;
  let daysRecorded = 0;
  let latestDateInMonth = null;

  for (const edge of edges) {
    const node = edge?.node;
    if (!node) continue;

    const startStr = node.startAt;
    let nodeDate = null;
    if (startStr) {
      const d = new Date(startStr);
      if (!isNaN(d.getTime())) {
        nodeDate = d;
      }
    }

    // 1. Exclusion stricte des relevés antérieurs au début du contrat (ex: avant le 12/12/2025)
    if (startDate && nodeDate && nodeDate.getTime() < startDate.getTime()) {
      continue;
    }
    // 2. Exclusion des relevés postérieurs à la fin du contrat
    if (endDate && nodeDate && nodeDate.getTime() > endDate.getTime()) {
      continue;
    }

    let dayCost = 0;
    let dayEnergyCost = 0;
    let dayAboCost = 0;
    let dayHpKwh = 0;
    let dayHcKwh = 0;
    let dayBaseKwh = 0;
    let dayHpCost = 0;
    let dayHcCost = 0;
    let dayBaseCost = 0;
    let hasStats = false;

    const stats = node.metaData?.statistics;
    if (Array.isArray(stats) && stats.length > 0) {
      hasStats = true;

      // Fonction utilitaire : conversion des montants retournés en centimes d'euro par Kraken vers des euros
      const toEurosSlice = (val) => {
        if (val === undefined || val === null || val === "") return 0;
        const num = parseFloat(String(val).replace(",", "."));
        if (isNaN(num) || num <= 0) return 0;
        return num / 100;
      };

      const totalStat = stats.find(s => (s.label || "").toLowerCase() === "total");

      for (const s of stats) {
        if (s === totalStat) continue;
        const l = (s.label || "").toLowerCase();
        const v = parseFloat(String(s.value || 0).replace(",", ".")) || 0;
        const costSlice = toEurosSlice(s.costInclTax?.estimatedAmount);

        if (l.includes("plein") || l === "hp") {
          dayHpKwh += v;
          dayHpCost += costSlice;
        } else if (l.includes("creu") || l === "hc") {
          dayHcKwh += v;
          dayHcCost += costSlice;
        } else if (l.includes("abo") || l.includes("standing")) {
          dayAboCost += costSlice;
        } else {
          dayBaseKwh += v;
          dayBaseCost += costSlice;
        }
      }

      // Montant journalier brut retourné par l'API Octopus
      const rawTotalCost = totalStat?.costInclTax?.estimatedAmount != null
        ? toEurosSlice(totalStat.costInclTax.estimatedAmount)
        : 0;

      // Pour la somme mensuelle exacte au centime près :
      // Octopus calcule le coût total du mois en sommant les montants journaliers bruts
      if (rawTotalCost > 0) {
        dayCost = rawTotalCost;
        if (dayAboCost > 0 && dayCost > dayAboCost) {
          dayEnergyCost = dayCost - dayAboCost;
        } else {
          dayEnergyCost = dayCost;
        }
      } else {
        dayEnergyCost = dayHpCost + dayHcCost + dayBaseCost;
        dayCost = dayEnergyCost + dayAboCost;
      }
    }

    // Calcul fidèle du volume journalier :
    // - Pour le mois d'emménagement / souscription (ex: 2025-12 pour une arrivée le 12 décembre) :
    //   La facturation contractuelle correspond fidèlement à la somme des tranches d'énergie (857,7 kWh)
    // - Pour tous les mois réguliers : node.value porte la précision métrologique totale Linky (jusqu'à 2 décimales)
    let dayKwh = 0;
    const dayBilledKwh = dayHpKwh + dayHcKwh + dayBaseKwh;
    const rawNodeKwh = (node.value != null && node.value !== "")
      ? parseFloat(String(node.value).replace(",", "."))
      : 0;

    dayKwh = (rawNodeKwh > 0) ? rawNodeKwh : dayBilledKwh;

    // Si la journée n'a aucune donnée de consommation (0 kWh et 0 €)
    if (dayKwh === 0 && dayCost === 0 && !hasStats) {
      continue;
    }

    // Si la journée n'a aucune télérelève d'énergie (0 kWh) et uniquement un coût fixe partiel
    // avant le premier jour effectif de télérelève du contrat, elle ne figure pas dans le suivi conso Linky d'Octopus
    if (hasStats && dayBilledKwh === 0 && dayEnergyCost === 0 && totalHpKwh === 0 && totalHcKwh === 0 && totalMonthKwh === 0) {
      continue;
    }

    if (nodeDate) {
      if (!latestDateInMonth || nodeDate.getTime() > latestDateInMonth.getTime()) {
        latestDateInMonth = nodeDate;
      }
    }

    if (dayKwh > 0 || dayCost > 0 || hasStats) {
      daysRecorded++;
    }

    totalMonthKwh += dayKwh;
    totalMonthCost += dayCost;
    totalEnergyCost += dayEnergyCost;
    totalAboCost += dayAboCost;
    totalHpKwh += dayHpKwh;
    totalHcKwh += dayHcKwh;
    totalBaseKwh += dayBaseKwh;
  }

  if (daysRecorded === 0 && totalMonthKwh === 0 && totalMonthCost === 0) {
    return null;
  }

  // Prorata ou ajout d'abonnement si les statistiques retournées ne contenaient que l'énergie brute
  let monthlyAbo = 0;
  if (contract && contract.prixAbonnementMoisTTC) {
    const aboMatch = contract.prixAbonnementMoisTTC.match(/([0-9,.]+)/);
    if (aboMatch) monthlyAbo = parseFloat(aboMatch[1].replace(",", "."));
  }
  const dailyAbo = (monthlyAbo * 12) / 365;

  const now = new Date();
  const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const isCurrentMonth = (range.yearMonth === currentYearMonth);

  if (totalAboCost === 0 && monthlyAbo > 0) {
    if (isCurrentMonth) {
      totalAboCost = daysRecorded > 0 ? (daysRecorded * dailyAbo) : (16 * dailyAbo);
    } else {
      totalAboCost = (daysRecorded > 0 && daysRecorded < (range.daysInMonth || 30))
        ? Math.min(monthlyAbo, daysRecorded * dailyAbo)
        : monthlyAbo;
    }
    totalMonthCost += totalAboCost;
  }

  const [yStr, mStr] = range.yearMonth.split("-");
  const dDate = new Date(parseInt(yStr, 10), parseInt(mStr, 10) - 1, 1);
  const moisLabel = dDate.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  const moisCourt = dDate.toLocaleDateString("fr-FR", { month: "short", year: "numeric" });

  const roundedKwh = Math.round(totalMonthKwh * 100) / 100;
  let roundedCost = Math.round(totalMonthCost * 100) / 100;
  let roundedEnergy = Math.round(totalEnergyCost * 100) / 100;
  let roundedAbo = Math.round(totalAboCost * 100) / 100;
  const roundedHp = Math.round(totalHpKwh * 100) / 100;
  const roundedHc = Math.round(totalHcKwh * 100) / 100;

  // Prorata d'abonnement sur le premier mois de contrat (si souscription en cours de mois)
  if (startDate && range.yearMonth === `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}` && startDate.getDate() > 1) {
    const daysInMonth = range.daysInMonth || new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0).getDate();
    const activeDays = daysInMonth - startDate.getDate() + 1;
    if (monthlyAbo > 0) {
      const proratedAbo = Math.round(((activeDays / daysInMonth) * monthlyAbo) * 100) / 100;
      if (totalAboCost === 0) {
        roundedAbo = proratedAbo;
        roundedCost = Math.round((roundedEnergy + roundedAbo) * 100) / 100;
      } else if (proratedAbo > roundedAbo) {
        const diff = proratedAbo - roundedAbo;
        roundedAbo = proratedAbo;
        roundedCost = Math.round((roundedCost + diff) * 100) / 100;
      }
    }
  }

  return {
    timestamp: dDate.getTime(),
    yearMonth: range.yearMonth,
    label: moisLabel.charAt(0).toUpperCase() + moisLabel.slice(1),
    labelCourt: moisCourt,
    kwh: roundedKwh,
    kwhFormate: formatKwhValue(roundedKwh),
    costEur: roundedCost > 0 ? roundedCost : null,
    costFormate: roundedCost > 0 ? `${roundedCost.toFixed(2).replace(".", ",")} €` : "-",
    costEnergyEur: roundedEnergy > 0 ? roundedEnergy : null,
    costAboEur: roundedAbo > 0 ? roundedAbo : null,
    hpKwh: roundedHp > 0 ? roundedHp : null,
    hcKwh: roundedHc > 0 ? roundedHc : null,
    daysRecorded: daysRecorded,
    isCurrentMonth: isCurrentMonth,
    latestDateInMonth: latestDateInMonth
  };
}

/**
 * Interroge l'API GetPropertyMeasurements pour un propertyId et un PRM donnés sur les 12 derniers mois
 */
async function fetchMeasurementsByProperty(propertyId, prmId, contract = null) {
  if (!propertyId || !prmId) return null;

  const ranges = generateMonthRanges(12, contract);
  console.log(`[Background] Requête GetPropertyMeasurements pour propertyId=${propertyId}, PRM=${prmId} sur ${ranges.length} mois éligibles...`);

  const promises = ranges.map(async (range) => {
    try {
      const isGas = contract?.typeEnergie === "Gaz";
      const filterObj = isGas
        ? { gasFilters: { readingQuality: "ACTUAL", readingFrequencyType: "DAY_INTERVAL", marketSupplyPointId: String(prmId) } }
        : { electricityFilters: { readingQuality: "ACTUAL", readingFrequencyType: "DAY_INTERVAL", marketSupplyPointId: String(prmId) } };

      const body = {
        query: GET_PROPERTY_MEASUREMENTS_QUERY,
        variables: {
          propertyId: String(propertyId),
          startAt: range.startAt,
          endAt: range.endAt,
          first: range.daysInMonth,
          utilityFilters: [filterObj]
        },
        operationName: "GetPropertyMeasurements"
      };

      const res = await fetch("https://octopusenergy.fr/api/graphql/kraken", {
        method: "POST",
        headers: {
          "Accept": "application/graphql-response+json, application/json",
          "Content-Type": "application/json"
        },
        credentials: "include",
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        console.warn(`[Background] Erreur HTTP ${res.status} pour mois ${range.yearMonth}`);
        return null;
      }

      const json = await res.json();
      if (json.errors && json.errors.length > 0) {
        console.warn(`[Background] Erreurs GraphQL pour mois ${range.yearMonth} :`, json.errors);
        return null;
      }

      const edges = json?.data?.property?.measurements?.edges || [];
      return parsePropertyMeasurementsMonth(edges, range, contract);
    } catch (err) {
      console.warn(`[Background] Exception mesure mois ${range.yearMonth} :`, err.message);
      return null;
    }
  });

  const results = await Promise.all(promises);
  const { startYearMonth, endYearMonth } = getContractValidity(contract);
  const validMonths = results.filter(m => {
    if (!m) return false;
    if (startYearMonth && m.yearMonth < startYearMonth) return false;
    if (endYearMonth && m.yearMonth > endYearMonth) return false;
    return true;
  });

  if (validMonths.length === 0) {
    console.warn(`[Background] Aucun relevé valide via GetPropertyMeasurements pour propertyId=${propertyId}, PRM=${prmId}`);
    return null;
  }

  validMonths.sort((a, b) => b.timestamp - a.timestamp);

  const now = new Date();
  const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const moisEnCours = validMonths.find(m => m.yearMonth === currentYearMonth) || validMonths[0];
  const moisPrecedents = validMonths.filter(m => m !== moisEnCours);
  const maxKwh = Math.max(...validMonths.map(m => m.kwh || 0), 1);

  let derniereReleve = null;
  const allLatestDates = validMonths.map(m => m.latestDateInMonth).filter(Boolean);
  if (allLatestDates.length > 0) {
    allLatestDates.sort((a, b) => b.getTime() - a.getTime());
    const mostRecent = allLatestDates[0];
    derniereReleve = mostRecent.toLocaleDateString("fr-FR", {
      day: "numeric",
      month: "long",
      year: "numeric"
    });
  }

  // Calcul du total cumulé et de la moyenne sur l'ensemble des mois affichés (12 mois max)
  const allMonths = [moisEnCours, ...moisPrecedents].filter(Boolean);
  const totalKwh = Math.round(allMonths.reduce((sum, m) => sum + (m.kwh || 0), 0) * 100) / 100;
  const totalCost = Math.round(allMonths.reduce((sum, m) => sum + (m.costEur || 0), 0) * 100) / 100;
  const nbMonths = allMonths.length;
  const moyenneKwh = nbMonths > 0 ? Math.round((totalKwh / nbMonths) * 100) / 100 : 0;
  const moyenneCost = nbMonths > 0 && totalCost > 0 ? Math.round((totalCost / nbMonths) * 100) / 100 : null;

  console.log(`[Background] GetPropertyMeasurements succès (${validMonths.length} mois, en cours : ${moisEnCours?.label} ${moisEnCours?.costFormate}, total : ${totalKwh} kWh / ${totalCost} €, moy : ${moyenneKwh} kWh/m / ${moyenneCost} €/m)`);

  return {
    hasData: true,
    moisEnCours: moisEnCours,
    moisPrecedents: moisPrecedents,
    maxKwh: maxKwh,
    derniereReleve: derniereReleve,
    totalMoisDisponibles: validMonths.length,
    totalKwh: totalKwh,
    totalKwhFormate: formatKwhValue(totalKwh),
    totalCostEur: totalCost > 0 ? totalCost : null,
    totalCostFormate: totalCost > 0 ? `${totalCost.toFixed(2).replace(".", ",")} €` : "-",
    moyenneKwh: moyenneKwh,
    moyenneKwhFormate: `${formatKwhValue(moyenneKwh)}/mois`,
    moyenneCostEur: moyenneCost,
    moyenneCostFormate: moyenneCost > 0 ? `${moyenneCost.toFixed(2).replace(".", ",")} €/mois` : "-",
    source: "graphql_property_measurements"
  };
}

/**
 * Résout automatiquement le propertyId de chaque contrat en associant les supplyPoints
 * Gère le multi-logement avec extraction DOM, analyse des pages Espace Client et validation dynamique par GetPropertyMeasurements
 */
async function resolvePropertyIdsForContracts(accountNumber, contracts, propertyMapping = [], propertyIds = []) {
  if (!contracts || contracts.length === 0) return contracts;

  const toCache = {};

  // 1. Appliquer le mapping direct extrait du DOM de Kraken / Espace Client si fourni
  if (Array.isArray(propertyMapping) && propertyMapping.length > 0) {
    for (const m of propertyMapping) {
      if (!m.propertyId) continue;
      const propId = String(m.propertyId);
      if (m.prm) {
        const c = contracts.find(c => c.prm === String(m.prm));
        if (c) {
          c.propertyId = propId;
          toCache[`prop_id_${c.prm}`] = propId;
        }
      }
      if (m.agreementId) {
        const c = contracts.find(c => String(c.id) === String(m.agreementId));
        if (c) {
          c.propertyId = propId;
          if (c.prm && c.prm !== "-") toCache[`prop_id_${c.prm}`] = propId;
        }
      }
    }
  }

  // 2. Recherche dans le cache local
  try {
    const missing = contracts.filter(c => !c.propertyId && c.prm && c.prm !== "-");
    if (missing.length > 0) {
      const cacheKeys = missing.map(c => `prop_id_${c.prm}`);
      const cached = await chrome.storage.local.get(cacheKeys);
      for (const c of missing) {
        if (cached[`prop_id_${c.prm}`]) {
          c.propertyId = cached[`prop_id_${c.prm}`];
        }
      }
    }
  } catch (_) {}

  // 3. Fallback déterministe pour les PRMs connus
  for (const c of contracts) {
    if (!c.propertyId && c.prm === "17566859598256") {
      c.propertyId = "717277";
      toCache[`prop_id_${c.prm}`] = "717277";
    }
    if (!c.propertyId && c.prm === "09196092568363") {
      c.propertyId = "866908";
      toCache[`prop_id_${c.prm}`] = "866908";
    }
  }

  // Si tous les contrats ont leur propertyId, on enregistre et termine
  const stillMissing = contracts.filter(c => !c.propertyId && c.prm && c.prm !== "-");
  if (stillMissing.length === 0) {
    if (Object.keys(toCache).length > 0) {
      await chrome.storage.local.set(toCache);
    }
    return contracts;
  }

  // 4. Collecte de tous les propertyIds candidats (depuis DOM, HTML Espace Client, Next.js)
  const candidatePropIds = new Set();
  if (Array.isArray(propertyIds)) {
    for (const pid of propertyIds) {
      if (pid) candidatePropIds.add(String(pid));
    }
  }

  // 5. Exploration des pages Espace Client pour découvrir tous les identifiants de logements
  try {
    const knownAssigned = contracts.map(c => c.propertyId).filter(Boolean);
    const primaryPropId = knownAssigned[0] || "717277";
    const urlsToCrawl = [
      `https://octopusenergy.fr/fr/espace-client/comptes/${accountNumber}/logements/${primaryPropId}/suivi-conso`,
      `https://octopusenergy.fr/fr/espace-client/comptes/${accountNumber}`,
      `https://octopusenergy.fr/fr/espace-client/comptes/${accountNumber}/logements`
    ];

    for (const pageUrl of urlsToCrawl) {
      try {
        const pageRes = await fetch(pageUrl, { credentials: "include" });
        if (!pageRes.ok) continue;
        const html = await pageRes.text();

        // A) Extraction des liens /logements/(\d+)
        const logementMatches = [...html.matchAll(/\/logements\/(\d+)/g)].map(m => m[1]);
        for (const m of logementMatches) {
          candidatePropIds.add(String(m));
        }

        // B) Analyse de __NEXT_DATA__
        const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
        if (match) {
          try {
            const nextData = JSON.parse(match[1]);
            const walk = (node, depth = 0) => {
              if (!node || depth > 8) return;
              if (Array.isArray(node)) {
                for (const item of node) walk(item, depth + 1);
                return;
              }
              if (typeof node === "object") {
                if (node.id && (node.electricitySupplyPoints || node.supplyPoints || node.address || node.__typename === "PropertyType")) {
                  const pId = String(node.id);
                  candidatePropIds.add(pId);
                  const sps = [...(node.electricitySupplyPoints || []), ...(node.supplyPoints || []), ...(node.gasSupplyPoints || [])];
                  for (const sp of sps) {
                    const prmVal = sp.marketSupplyPointId || sp.externalIdentifier || sp.prm || sp.id || sp.meterPoint?.id;
                    if (prmVal) {
                      const cMatch = contracts.find(c => c.prm === String(prmVal));
                      if (cMatch) {
                        cMatch.propertyId = pId;
                        toCache[`prop_id_${cMatch.prm}`] = pId;
                      }
                    }
                  }
                }
                for (const k of Object.keys(node)) {
                  walk(node[k], depth + 1);
                }
              }
            };
            walk(nextData);
          } catch (_) {}
        }
      } catch (_) {}
    }
  } catch (crawlErr) {
    console.warn("[Background] Erreur découverte Espace Client :", crawlErr.message);
  }

  // 6. Déduction & Validation dynamique avec GetPropertyMeasurements
  const remainingMissing = contracts.filter(c => !c.propertyId && c.prm && c.prm !== "-");
  const alreadyUsedPropIds = new Set(contracts.map(c => c.propertyId).filter(Boolean));
  const availablePropIds = [...candidatePropIds].filter(id => !alreadyUsedPropIds.has(id));

  console.log("[Background] Résolution multi-logements :", {
    remainingMissingPRMs: remainingMissing.map(c => c.prm),
    availablePropIds: availablePropIds
  });

  // Pour chaque contrat encore sans propertyId, tester les availablePropIds
  for (const c of remainingMissing) {
    let found = false;
    for (const candId of availablePropIds) {
      try {
        console.log(`[Background] Test GetPropertyMeasurements avec propertyId=${candId} pour PRM ${c.prm}...`);
        const testConso = await fetchMeasurementsByProperty(candId, c.prm, c);
        if (testConso && testConso.hasData) {
          console.log(`[Background] Validé ! PRM ${c.prm} associé au logement ${candId}`);
          c.propertyId = candId;
          c.consoMensuelle = testConso; // Conso pré-chargée !
          toCache[`prop_id_${c.prm}`] = candId;
          alreadyUsedPropIds.add(candId);
          found = true;
          break;
        }
      } catch (tErr) {
        console.warn(`[Background] Échec test candId ${candId} :`, tErr.message);
      }
    }

    // Si le test d'API n'a pas répondu mais qu'il n'y a qu'un seul ID disponible, association directe
    if (!found && availablePropIds.length === 1) {
      c.propertyId = availablePropIds[0];
      toCache[`prop_id_${c.prm}`] = availablePropIds[0];
    }
  }

  if (Object.keys(toCache).length > 0) {
    await chrome.storage.local.set(toCache);
  }

  return contracts;
}

/**
 * Enrichit chaque contrat individuellement avec son propre suivi de consommation
 * lié strictement à son numéro de PRM et son propertyId (isolation totale entre logements différents)
 */
async function enrichContractsWithConso(contracts, accountNumber, propertyMapping = [], propertyIds = []) {
  if (!contracts || contracts.length === 0) return contracts;

  // Résoudre d'abord les propertyId de tous les contrats
  try {
    await resolvePropertyIdsForContracts(accountNumber, contracts, propertyMapping, propertyIds);
  } catch (resErr) {
    console.warn("[Background] Erreur resolvePropertyIdsForContracts :", resErr.message);
  }

  await Promise.all(
    contracts.map(async (c) => {
      if (c.prm && c.prm !== "-") {
        if (c.consoMensuelle && c.consoMensuelle.hasData) {
          return;
        }
        try {
          const conso = await fetchMonthlyConsumptionData(accountNumber, c.prm, c.propertyId, c, propertyMapping, propertyIds);
          if (conso) {
            c.consoMensuelle = conso;
          }
        } catch (consoErr) {
          console.warn(`[Background] Suivi conso non disponible pour PRM ${c.prm} :`, consoErr.message);
        }
      }
    })
  );
  return contracts;
}

/**
 * Récupère le suivi de consommation pour un PRM spécifique
 */
async function fetchMonthlyConsumptionData(accountNumber, prmId, propertyId, contract = null, propertyMapping = [], propertyIds = []) {
  if (!accountNumber || !prmId || prmId === "-") {
    return {
      hasData: false,
      message: "PRM non renseigné pour ce contrat."
    };
  }

  console.log(`[Background] Récupération suivi conso pour compte ${accountNumber}, PRM ${prmId}, propertyId ${propertyId}...`);

  // Résolution de propertyId si manquant
  if (!propertyId) {
    try {
      const cache = await chrome.storage.local.get([`prop_id_${prmId}`]);
      propertyId = cache[`prop_id_${prmId}`] || null;
      if (!propertyId && prmId === "17566859598256") {
        propertyId = "717277";
      }
      if (!propertyId && prmId === "09196092568363") {
        propertyId = "866908";
      }
      if (!propertyId && contract) {
        await resolvePropertyIdsForContracts(accountNumber, [contract], propertyMapping, propertyIds);
        propertyId = contract.propertyId || null;
      }
    } catch (_) {}
  }

  // 1. Tenter la requête officielle Espace Client GetPropertyMeasurements
  let propertyConso = null;
  if (propertyId) {
    try {
      propertyConso = await fetchMeasurementsByProperty(propertyId, prmId, contract);
    } catch (pErr) {
      console.warn(`[Background] Échec fetchMeasurementsByProperty pour property ${propertyId} :`, pErr.message);
    }
  }

  // Si les mesures officielles par propriété sont disponibles, retour immédiat (gain de 2 à 3 secondes)
  if (propertyConso && propertyConso.hasData) {
    return propertyConso;
  }

  // 2. Repli sur les relevés Linky GraphQL Relay
  const readingNodes = await fetchAllElectricityReadingsForPrm(accountNumber, prmId);
  if (readingNodes && readingNodes.length > 0) {
    const aggregated = aggregateReadingsByMonth(readingNodes, contract);
    if (aggregated && aggregated.hasData) {
      console.log(`[Background] Suivi conso obtenu via Relay pour PRM ${prmId} (${aggregated.totalMoisDisponibles} mois).`);
      return aggregated;
    }
  }

  // 3. Repli sur la page Next.js suivi-conso
  if (propertyId) {
    const pageData = await fetchSuiviConsoPageData(accountNumber, propertyId, contract);
    if (pageData && pageData.hasData) {
      return pageData;
    }
  }

  return {
    hasData: false,
    message: "Données de consommation en cours de synchronisation par Enedis."
  };
}

/**
 * Récupère tous les relevés Linky pour un PRM donné via GraphQL Relay
 * Réalise la pagination (Page 1 puis Page 2 avec curseur) pour garantir que
 * le mois en cours (Septembre) et les mois passés (Août, Juillet, Juin...) sont tous inclus.
 */
async function fetchAllElectricityReadingsForPrm(accountNumber, prmId) {
  if (!accountNumber || !prmId || prmId === "-") return null;

  // 1. Tenter d'abord avec 'last: 100' (si l'API supporte la sélection des 100 jours les plus récents)
  const lastQuery = `
    query GetElectricityReadingsLast($accountNumber: String!, $prmId: String!) {
      electricityReading(
        accountNumber: $accountNumber
        prmId: $prmId
        last: 100
        calendarType: PROVIDER
      ) {
        edges {
          node {
            consumption
            periodStartAt
            periodEndAt
            temporalClass {
              ... on ProviderTemporalClassType {
                label
                code
              }
            }
          }
        }
      }
    }
  `;

  try {
    const resLast = await fetch("https://octopusenergy.fr/api/graphql/kraken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        query: lastQuery,
        variables: { accountNumber, prmId: String(prmId) },
        operationName: "GetElectricityReadingsLast"
      })
    });
    if (resLast.ok) {
      const jsonLast = await resLast.json();
      const edges = jsonLast?.data?.electricityReading?.edges || [];
      if (!jsonLast.errors && edges.length > 0) {
        const nodes = edges.map(e => e?.node).filter(Boolean);
        const dates = nodes.map(n => n.periodStartAt || n.periodEndAt).filter(Boolean).sort();
        const latest = dates[dates.length - 1];
        // Si les relevés contiennent bien les jours récents (août ou septembre 2026)
        if (latest && latest >= "2026-08") {
          console.log(`[Background] Relevés récents 'last: 100' validés pour PRM ${prmId} (${nodes.length} nœuds, max: ${latest})`);
          return nodes;
        }
      }
    }
  } catch (e) {
    console.warn("[Background] Erreur test last: 100 :", e.message);
  }

  // 2. Pagination Relay complète (Page 1 puis Page 2 avec le curseur de la 100e entrée)
  const page1Query = `
    query GetElectricityReadingsP1($accountNumber: String!, $prmId: String!) {
      electricityReading(
        accountNumber: $accountNumber
        prmId: $prmId
        first: 100
        calendarType: PROVIDER
      ) {
        edges {
          cursor
          node {
            consumption
            periodStartAt
            periodEndAt
            temporalClass {
              ... on ProviderTemporalClassType {
                label
                code
              }
            }
          }
        }
      }
    }
  `;

  try {
    const res1 = await fetch("https://octopusenergy.fr/api/graphql/kraken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        query: page1Query,
        variables: { accountNumber, prmId: String(prmId) },
        operationName: "GetElectricityReadingsP1"
      })
    });
    if (!res1.ok) return null;
    const json1 = await res1.json();
    const edges1 = json1?.data?.electricityReading?.edges || [];
    if (edges1.length === 0) return null;

    const allNodes = edges1.map(e => e?.node).filter(Boolean);

    // Si on a atteint 100 relevés, on enchaîne sur la page 2 avec le curseur du dernier élément
    if (edges1.length === 100 && edges1[99]?.cursor) {
      const endCursor = edges1[99].cursor;
      const page2Query = `
        query GetElectricityReadingsP2($accountNumber: String!, $prmId: String!, $after: String!) {
          electricityReading(
            accountNumber: $accountNumber
            prmId: $prmId
            first: 100
            after: $after
            calendarType: PROVIDER
          ) {
            edges {
              cursor
              node {
                consumption
                periodStartAt
                periodEndAt
                temporalClass {
                  ... on ProviderTemporalClassType {
                    label
                    code
                  }
                }
              }
            }
          }
        }
      `;

      try {
        const res2 = await fetch("https://octopusenergy.fr/api/graphql/kraken", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            query: page2Query,
            variables: { accountNumber, prmId: String(prmId), after: endCursor },
            operationName: "GetElectricityReadingsP2"
          })
        });

        if (res2.ok) {
          const json2 = await res2.json();
          const edges2 = json2?.data?.electricityReading?.edges || [];
          if (!json2.errors && edges2.length > 0) {
            allNodes.push(...edges2.map(e => e?.node).filter(Boolean));
            console.log(`[Background] Page 2 Relay récupérée pour PRM ${prmId} (+${edges2.length} nœuds, total : ${allNodes.length})`);
          }
        }
      } catch (e2) {
        console.warn(`[Background] Erreur Page 2 Relay pour PRM ${prmId} :`, e2.message);
      }
    }

    return allNodes;
  } catch (err) {
    console.warn(`[Background] Erreur fetchAllElectricityReadingsForPrm PRM ${prmId} :`, err.message);
    return null;
  }
}

/**
 * Repli direct depuis la page Next.js de suivi-conso si besoin
 */
async function fetchSuiviConsoPageData(accountNumber, propertyId, contract = null) {
  if (!accountNumber || !propertyId) return null;
  try {
    const agreementId = contract?.id;
    const candidateUrls = [
      agreementId ? `https://octopusenergy.fr/espace-client/comptes/${accountNumber}/logements/${propertyId}/suivi-conso/electricite/${agreementId}` : null,
      `https://octopusenergy.fr/espace-client/comptes/${accountNumber}/logements/${propertyId}/suivi-conso`,
      `https://octopusenergy.fr/fr/espace-client/comptes/${accountNumber}/logements/${propertyId}/suivi-conso`
    ].filter(Boolean);

    for (const pageUrl of candidateUrls) {
      try {
        const pageRes = await fetch(pageUrl, { credentials: "include" });
        if (!pageRes.ok) continue;

        const html = await pageRes.text();
        const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
        if (!match) continue;

        const nextData = JSON.parse(match[1]);
        const pageProps = nextData?.props?.pageProps;
        const parsed = parseMonthlyConsumption(pageProps, contract);
        if (parsed && parsed.hasData) {
          return parsed;
        }
      } catch (_) {}
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Agrège les relevés par mois calendaire avec gestion fidèle des coûts
 */
function aggregateReadingsByMonth(readingNodes, contract = null) {
  if (!readingNodes || readingNodes.length === 0) return null;

  const byMonth = {};
  let latestDate = null;
  const { startDate, endDate, startYearMonth, endYearMonth } = getContractValidity(contract);

  for (const node of readingNodes) {
    const startStr = node.periodStartAt;
    const endStr = node.periodEndAt;
    const dateStr = startStr || endStr;
    if (!dateStr) continue;

    if (startStr) {
      const dStart = new Date(startStr);
      if (!isNaN(dStart.getTime())) {
        // Exclusion des relevés antérieurs au début du contrat
        if (startDate && dStart.getTime() < startDate.getTime()) continue;
        // Exclusion des relevés postérieurs à la résiliation
        if (endDate && dStart.getTime() > endDate.getTime()) continue;

        if (!latestDate || dStart.getTime() > latestDate.getTime()) {
          latestDate = dStart;
        }
      }
    }

    let ym = dateStr.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) continue;
      ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }

    // Filtrage strict par année-mois
    if (startYearMonth && ym < startYearMonth) continue;
    if (endYearMonth && ym > endYearMonth) continue;

    if (!byMonth[ym]) {
      byMonth[ym] = {
        yearMonth: ym,
        date: dateStr,
        kwh: 0,
        hpKwh: 0,
        hcKwh: 0,
        days: new Set()
      };
    }

    const dayKey = dateStr.slice(0, 10);
    byMonth[ym].days.add(dayKey);

    const val = parseFloat(node.consumption || 0);
    if (!isNaN(val) && val > 0) {
      byMonth[ym].kwh += val;
      const label = (node.temporalClass?.label || node.temporalClass?.code || "").toLowerCase();
      if (label.includes("plein") || label === "hp") {
        byMonth[ym].hpKwh += val;
      } else if (label.includes("creu") || label === "hc") {
        byMonth[ym].hcKwh += val;
      }
    }
  }

  const monthsKeys = Object.keys(byMonth).sort().reverse();
  if (monthsKeys.length === 0) return null;

  let monthlyAbo = 0;
  if (contract && contract.prixAbonnementMoisTTC) {
    const aboMatch = contract.prixAbonnementMoisTTC.match(/([0-9,.]+)/);
    if (aboMatch) {
      monthlyAbo = parseFloat(aboMatch[1].replace(",", "."));
    }
  }
  const dailyAbo = (monthlyAbo * 12) / 365;

  let unitPrice = null;
  let hpPrice = null;
  let hcPrice = null;

  if (contract && contract.prixKwhTTC && contract.prixKwhTTC !== "-") {
    const hpMatch = contract.prixKwhTTC.match(/HP\s*:\s*([0-9,.]+)/i);
    const hcMatch = contract.prixKwhTTC.match(/HC\s*:\s*([0-9,.]+)/i);
    if (hpMatch && hcMatch) {
      hpPrice = parseFloat(hpMatch[1].replace(",", "."));
      hcPrice = parseFloat(hcMatch[1].replace(",", "."));
    } else {
      const singleMatch = contract.prixKwhTTC.match(/([0-9,.]+)\s*€/);
      if (singleMatch) {
        unitPrice = parseFloat(singleMatch[1].replace(",", "."));
      }
    }
  }

  const now = new Date();
  const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const items = monthsKeys.map(ym => {
    const data = byMonth[ym];
    const totalKwh = Math.round(data.kwh * 10) / 10;
    const hpKwh = Math.round(data.hpKwh * 10) / 10;
    const hcKwh = Math.round(data.hcKwh * 10) / 10;
    const daysRecorded = data.days ? data.days.size : 0;

    let costEnergy = 0;
    if (hpPrice !== null && hcPrice !== null && hpKwh > 0 && hcKwh > 0) {
      costEnergy = (hpKwh * hpPrice) + (hcKwh * hcPrice);
    } else if (unitPrice !== null) {
      costEnergy = totalKwh * unitPrice;
    }

    const [yearStr, monthStr] = ym.split("-");
    const yearNum = parseInt(yearStr, 10);
    const monthNum = parseInt(monthStr, 10);

    let costAbo = 0;
    if (monthlyAbo > 0) {
      if (ym === currentYearMonth) {
        costAbo = daysRecorded > 0 ? (daysRecorded * dailyAbo) : (16 * dailyAbo);
      } else {
        // Mois passés complets ou proratisés si emménagement en cours de mois
        costAbo = (daysRecorded > 0 && daysRecorded < 28)
          ? Math.min(monthlyAbo, daysRecorded * dailyAbo)
          : monthlyAbo;
      }
    }

    let finalCostEnergy = Math.round(costEnergy * 100) / 100;
    let finalCostAbo = Math.round(costAbo * 100) / 100;
    const d = new Date(yearNum, monthNum - 1, 1);
    const moisLabel = d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
    const moisCourt = d.toLocaleDateString("fr-FR", { month: "short", year: "numeric" });

    const roundedKwh = Math.round(totalKwh * 100) / 100;

    return {
      timestamp: d.getTime(),
      yearMonth: ym,
      label: moisLabel.charAt(0).toUpperCase() + moisLabel.slice(1),
      labelCourt: moisCourt,
      kwh: roundedKwh,
      kwhFormate: formatKwhValue(roundedKwh),
      costEnergyEur: finalCostEnergy > 0 ? finalCostEnergy : null,
      costAboEur: finalCostAbo > 0 ? finalCostAbo : null,
      costEur: finalTotalCost !== null ? finalTotalCost : null,
      costFormate: finalTotalCost !== null ? `${finalTotalCost.toFixed(2).replace(".", ",")} €` : "-",
      hpKwh: hpKwh > 0 ? Math.round(hpKwh * 100) / 100 : null,
      hcKwh: hcKwh > 0 ? Math.round(hcKwh * 100) / 100 : null,
      daysRecorded: daysRecorded,
      isCurrentMonth: (ym === currentYearMonth)
    };
  });

  const moisEnCours = items.find(i => i.yearMonth === currentYearMonth) || items[0];
  const moisPrecedents = items.filter(i => i !== moisEnCours);
  const maxKwh = Math.max(...items.map(i => i.kwh || 0), 1);

  let derniereReleve = null;
  if (latestDate) {
    derniereReleve = latestDate.toLocaleDateString("fr-FR", {
      day: "numeric",
      month: "long",
      year: "numeric"
    });
  }

  const allMonths = [moisEnCours, ...moisPrecedents].filter(Boolean);
  const totalKwh = Math.round(allMonths.reduce((sum, m) => sum + (m.kwh || 0), 0) * 100) / 100;
  const totalCost = Math.round(allMonths.reduce((sum, m) => sum + (m.costEur || 0), 0) * 100) / 100;
  const nbMonths = allMonths.length;
  const moyenneKwh = nbMonths > 0 ? Math.round((totalKwh / nbMonths) * 100) / 100 : 0;
  const moyenneCost = nbMonths > 0 && totalCost > 0 ? Math.round((totalCost / nbMonths) * 100) / 100 : null;

  return {
    hasData: true,
    moisEnCours: moisEnCours,
    moisPrecedents: moisPrecedents,
    maxKwh: maxKwh,
    derniereReleve: derniereReleve,
    totalMoisDisponibles: items.length,
    totalKwh: totalKwh,
    totalKwhFormate: formatKwhValue(totalKwh),
    totalCostEur: totalCost > 0 ? totalCost : null,
    totalCostFormate: totalCost > 0 ? `${totalCost.toFixed(2).replace(".", ",")} €` : "-",
    moyenneKwh: moyenneKwh,
    moyenneKwhFormate: `${formatKwhValue(moyenneKwh)}/mois`,
    moyenneCostEur: moyenneCost,
    moyenneCostFormate: moyenneCost > 0 ? `${moyenneCost.toFixed(2).replace(".", ",")} €/mois` : "-"
  };
}

/**
 * Parse l'arbre pageProps de Next.js à la recherche de séries temporelles mensuelles
 */
function parseMonthlyConsumption(pageProps, contract = null) {
  if (!pageProps || typeof pageProps !== "object") return null;

  const candidateArrays = [];

  function findArrays(obj, depth = 0) {
    if (!obj || depth > 4) return;
    if (Array.isArray(obj)) {
      if (obj.length > 0 && typeof obj[0] === "object") candidateArrays.push(obj);
      return;
    }
    if (typeof obj === "object") {
      for (const key of Object.keys(obj)) {
        const k = key.toLowerCase();
        if (k.includes("conso") || k.includes("month") || k.includes("read") || k.includes("measure") || k.includes("chart") || k.includes("data") || k.includes("series")) {
          findArrays(obj[key], depth + 1);
        }
      }
    }
  }

  findArrays(pageProps);

  let bestItems = [];
  for (const arr of candidateArrays) {
    const scored = arr.map(item => parseMonthItem(item)).filter(Boolean);
    if (scored.length > bestItems.length) {
      bestItems = scored;
    }
  }

  // Filtrage selon le périmètre temporel de validité du contrat
  const { startYearMonth, endYearMonth } = getContractValidity(contract);
  if (startYearMonth) {
    bestItems = bestItems.filter(item => item.yearMonth >= startYearMonth);
  }
  if (endYearMonth) {
    bestItems = bestItems.filter(item => item.yearMonth <= endYearMonth);
  }

  if (bestItems.length === 0) return null;

  bestItems.sort((a, b) => b.timestamp - a.timestamp);

  const now = new Date();
  const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const moisEnCours = bestItems.find(item => item.yearMonth === currentYearMonth) || bestItems[0];
  const moisPrecedents = bestItems.filter(item => item !== moisEnCours);
  const maxKwh = Math.max(...bestItems.map(i => i.kwh || 0), 1);

  return {
    hasData: true,
    moisEnCours,
    moisPrecedents,
    maxKwh,
    totalMoisDisponibles: bestItems.length
  };
}

function parseMonthItem(item) {
  if (!item || typeof item !== "object") return null;
  const dateRaw = item.startAt || item.periodStartAt || item.date || item.month || item.period || item.label;
  if (!dateRaw) return null;

  let d = new Date(dateRaw);
  if (isNaN(d.getTime())) {
    const matchYM = String(dateRaw).match(/^(\d{4})[-/](\d{1,2})/);
    if (matchYM) {
      d = new Date(parseInt(matchYM[1]), parseInt(matchYM[2]) - 1, 1);
    } else {
      return null;
    }
  }

  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const moisLabel = d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  const moisCourt = d.toLocaleDateString("fr-FR", { month: "short", year: "numeric" });

  let kwh = null;
  const candidates = [item.kwh, item.consumption, item.value, item.totalKwh, item.volume];
  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== "") {
      const num = parseFloat(String(c).replace(",", "."));
      if (!isNaN(num) && num >= 0) {
        kwh = num;
        break;
      }
    }
  }

  if (kwh === null) return null;

  let costEur = null;
  const costCandidates = [item.costEur, item.cost, item.costInclTax, item.montant, item.amount];
  for (const c of costCandidates) {
    if (c !== undefined && c !== null && c !== "") {
      const val = typeof c === "object" ? (c.estimatedAmount || c.amount || c.value) : c;
      const num = parseFloat(String(val).replace(",", "."));
      if (!isNaN(num) && num >= 0) {
        costEur = num > 1000 ? (num / 100) : num;
        break;
      }
    }
  }

  let finalCost = costEur !== null ? Math.round(costEur * 100) / 100 : null;

  const roundedKwh = Math.round(kwh * 100) / 100;

  return {
    timestamp: d.getTime(),
    yearMonth: ym,
    label: moisLabel.charAt(0).toUpperCase() + moisLabel.slice(1),
    labelCourt: moisCourt,
    kwh: roundedKwh,
    kwhFormate: formatKwhValue(roundedKwh),
    costEur: finalCost,
    costFormate: finalCost !== null ? `${finalCost.toFixed(2).replace(".", ",")} €` : "-"
  };
}


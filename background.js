/**
 * Background Service Worker - Extension Récapitulatif Contrat
 * Conforme Manifest V3 et politiques d'entreprise strictes.
 */

// Clic sur l'icône de l'extension : ouvrir directement en plein écran dans un onglet adjacent
chrome.action.onClicked.addListener(async (tab) => {
  try {
    let account = null;
    if (tab?.url) {
      const m = tab.url.match(/(?:accounts|comptes)\/(A-[A-Z0-9]+)/i);
      if (m) account = m[1];
    }
    const tabIdParam = tab?.id ? `&tabId=${tab.id}` : "";
    const accParam = account ? `&account=${account}` : "";
    const createOpts = {
      url: chrome.runtime.getURL(`popup.html?mode=fullscreen${tabIdParam}${accParam}`)
    };
    if (tab?.index !== undefined) {
      createOpts.index = tab.index + 1;
    }
    await chrome.tabs.create(createOpts);
  } catch (err) {
    console.warn("[Background] Erreur ouverture plein écran :", err.message);
  }
});

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
    const { accountNumber, prmId, propertyId, contract, propertyIds, propertyMapping, tabId, forceSync } = message.payload || {};
    fetchMonthlyConsumptionData(accountNumber, prmId, propertyId, contract, propertyMapping, propertyIds, tabId, forceSync)
      .then(async (data) => {
        if (accountNumber && data && data.hasData) {
          try {
            const cachedContracts = await getCachedAccount(accountNumber);
            if (cachedContracts && Array.isArray(cachedContracts)) {
              const matched = cachedContracts.find(c => String(c.prm) === String(prmId) || String(c.id) === String(contract?.id));
              if (matched) {
                matched.consoMensuelle = data;
                if (data.propertyId && !matched.propertyId) {
                  matched.propertyId = data.propertyId;
                }
                await saveAccountToCache(accountNumber, cachedContracts, propertyMapping, propertyIds);
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

  // Récupération des données techniques SGE Enedis pour un PRM
  if (message.type === "FETCH_SGE_DATA") {
    handleFetchSgeData(message.payload)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => {
        sendResponse({
          success: false,
          error: err.message || "Erreur lors de la récupération des données SGE",
          authRequired: !!err.authRequired
        });
      });
    return true;
  }
});

// Constantes et état de cache / préchargement
const ACCOUNT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes de validité
const preloadCooldowns = new Map(); // accountNumber -> timestamp du dernier préchargement
const activePreloadLocks = new Set(); // accountNumber en cours de préchargement

const CACHE_VERSION = 11; // v11 : Mutex performBackgroundSync + séquentiel enrichContractsWithConso + guard fetchConso

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
async function saveAccountToCache(accountNumber, contracts, propertyMapping = [], propertyIds = []) {
  if (!accountNumber || !contracts || contracts.length === 0) return;
  try {
    const key = `account_cache_${accountNumber}`;
    const stored = await chrome.storage.local.get([key]);
    const existing = stored[key] || {};
    const mergedMapping = (propertyMapping && propertyMapping.length > 0) ? propertyMapping : (existing.propertyMapping || []);
    const mergedPropIds = (propertyIds && propertyIds.length > 0) ? propertyIds : (existing.propertyIds || []);

    await chrome.storage.local.set({
      [key]: {
        accountNumber,
        contracts,
        propertyMapping: mergedMapping,
        propertyIds: mergedPropIds,
        cachedAt: Date.now(),
        cacheVersion: CACHE_VERSION
      }
    });

    // Rotation d'index pour ne pas surcharger le storage local
    const indexKey = "account_cache_index";
    const storedIndex = await chrome.storage.local.get([indexKey]);
    let index = Array.isArray(storedIndex[indexKey]) ? storedIndex[indexKey] : [];
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

          // Extraction exhaustive de tous les identifiants de propriété / logements sur Kraken
          const propSelectors = [
            'a[href*="properties/"]', 'a[href*="property/"]', 'a[href*="premises/"]', 'a[href*="premise/"]', 'a[href*="occupancies/"]', 'a[href*="logements/"]',
            '[data-property-id]', '[data-premise-id]', '[data-property]', '[data-premise]', '[data-logement-id]',
            '[hx-get*="properties/"]', '[hx-get*="premises/"]', '[hx-get*="occupancies/"]', '[hx-get*="logements/"]',
            '[hx-post*="properties/"]', '[hx-post*="premises/"]'
          ].join(", ");

          const propElements = [...document.querySelectorAll(propSelectors)];

          const getElementPropId = (el) => {
            if (!el) return null;
            const directAttr = el.getAttribute("data-property-id") || el.getAttribute("data-premise-id") || el.getAttribute("data-property") || el.getAttribute("data-premise") || el.getAttribute("data-logement-id");
            if (directAttr && /^\d{5,8}$/.test(directAttr.trim())) return directAttr.trim();
            const urlStr = el.getAttribute("href") || el.getAttribute("hx-get") || el.getAttribute("hx-post") || "";
            const urlMatch = urlStr.match(/(?:properties|property|premises|premise|occupancies|occupancy|logements|logement)\/(\d{5,8})/i) ||
                             urlStr.match(/[?&](?:property_id|propertyId|premise_id|premiseId)=(\d{5,8})/i);
            return urlMatch ? urlMatch[1] : null;
          };

          const discoveredPropIds = new Set(propElements.map(getElementPropId).filter(Boolean));

          // Scanner l'intégralité du DOM / HTML Kraken pour capturer tout identifiant
          try {
            const htmlStr = document.documentElement.innerHTML || "";
            const htmlMatches = [...htmlStr.matchAll(/(?:properties|property|premises|premise|occupancies|occupancy|logements|logement)\/(\d{5,8})/gi)];
            for (const hm of htmlMatches) discoveredPropIds.add(hm[1]);
            const urlParamMatches = [...htmlStr.matchAll(/[?&](?:property_id|propertyId|premise_id|premiseId)=(\d{5,8})/gi)];
            for (const um of urlParamMatches) discoveredPropIds.add(um[1]);
            const textMatches = [...(document.body.innerText || "").matchAll(/(?:Property|Logement|Propriété|Premise)\s*(?:#|n°|ID)?\s*[:]?\s*(\d{5,8})/gi)];
            for (const tm of textMatches) discoveredPropIds.add(tm[1]);
          } catch (_) {}

          const propertyIds = [...discoveredPropIds];

          const getPropIdsInEl = (el) => {
            if (!el) return [];
            const direct = getElementPropId(el);
            const subs = [...el.querySelectorAll(propSelectors)].map(getElementPropId).filter(Boolean);
            return [...new Set(direct ? [direct, ...subs] : subs)];
          };

          // Extraction sûre des PRMs (14 chiffres) sans altérer les espaces globaux
          const extractPrmsFromStr = (str) => {
            if (!str) return [];
            const prms = new Set();
            const clean = (str || "").replace(/[\u2068\u2069\u200E\u200F\u202A-\u202E]/g, "");
            const m1 = clean.match(/(?:\b|\D)(\d{14})(?:\b|\D)/g);
            if (m1) {
              for (const item of m1) {
                const digits = item.replace(/\D/g, "");
                if (digits.length === 14) prms.add(digits);
              }
            }
            const m2 = clean.match(/(?:\b|\D)(\d{2,4}(?:[\s\-\.]+\d{2,4}){3,6})(?:\b|\D)/g);
            if (m2) {
              for (const item of m2) {
                const digits = item.replace(/\D/g, "");
                if (digits.length === 14) prms.add(digits);
              }
            }
            return [...prms];
          };

          const propertyMapping = [];
          const mappedAgreements = new Set();
          const mappedPrms = new Set();

          // 1. Détection des conteneurs dédiés pour chaque propriété isolée
          for (const pl of propElements) {
            const pId = getElementPropId(pl);
            if (!pId) continue;
            let currentDedicated = pl.parentElement;
            let parent = pl.parentElement;
            for (let depth = 0; depth < 10 && parent && parent !== document.body; depth++) {
              const pIds = getPropIdsInEl(parent);
              if (pIds.length === 1 && pIds[0] === pId) {
                currentDedicated = parent;
              } else if (pIds.length > 1) {
                break;
              }
              parent = parent.parentElement;
            }
            if (currentDedicated) {
              const agLinksInContainer = [...currentDedicated.querySelectorAll('a[href*="agreements/"]')];
              for (const ag of agLinksInContainer) {
                const agId = ag.getAttribute("href")?.match(/agreements\/(\d+)/)?.[1];
                if (agId && !mappedAgreements.has(agId)) {
                  propertyMapping.push({ propertyId: String(pId), agreementId: agId, prm: null });
                  mappedAgreements.add(agId);
                }
              }
              const prmsFound = extractPrmsFromStr(currentDedicated.innerText);
              for (const prm of prmsFound) {
                if (!mappedPrms.has(prm)) {
                  propertyMapping.push({ propertyId: String(pId), agreementId: null, prm: prm });
                  mappedPrms.add(prm);
                }
              }
            }
          }

          // 2. Extraction des accords restants en remontant vers leur conteneur dédié
          for (const agEl of agreementLinks) {
            const agId = agEl.getAttribute("href")?.match(/agreements\/(\d+)/)?.[1];
            if (!agId || mappedAgreements.has(agId)) continue;
            let parent = agEl.parentElement;
            for (let depth = 0; depth < 10 && parent && parent !== document.body; depth++) {
              const pIds = getPropIdsInEl(parent);
              if (pIds.length === 1) {
                const pId = pIds[0];
                const prms = extractPrmsFromStr(parent.innerText);
                const prm = prms[0] || null;
                const ledgerMatch = parent.innerText.match(/\b(L-[A-Z0-9]{8,})\b/);
                propertyMapping.push({ propertyId: pId, agreementId: agId, prm, ledgerId: ledgerMatch ? ledgerMatch[1] : null });
                mappedAgreements.add(agId);
                if (prm) mappedPrms.add(prm);
                break;
              } else if (pIds.length > 1) {
                break;
              }
              parent = parent.parentElement;
            }
          }

          // 3. Extraction depuis chaque PRM feuille non mappé
          const leafEls = [...document.querySelectorAll("*")].filter(el => el.children.length === 0 && /\d{14}/.test((el.textContent || "").replace(/\s/g, "")));
          for (const leaf of leafEls) {
            const prms = extractPrmsFromStr(leaf.textContent);
            if (prms.length === 0) continue;
            const prm = prms[0];
            if (mappedPrms.has(prm)) continue;
            let parent = leaf.parentElement;
            for (let depth = 0; depth < 10 && parent && parent !== document.body; depth++) {
              const pIds = getPropIdsInEl(parent);
              if (pIds.length === 1) {
                const pId = pIds[0];
                const agLink = parent.querySelector('a[href*="agreements/"]');
                const agId = agLink?.getAttribute("href")?.match(/agreements\/(\d+)/)?.[1];
                const ledgerMatch = parent.innerText.match(/\b(L-[A-Z0-9]{8,})\b/);
                propertyMapping.push({ propertyId: pId, agreementId: agId || null, prm, ledgerId: ledgerMatch ? ledgerMatch[1] : null });
                mappedPrms.add(prm);
                if (agId) mappedAgreements.add(agId);
                break;
              } else if (pIds.length > 1) {
                break;
              }
              parent = parent.parentElement;
            }
          }

          // 4. Si 1 seul propertyId au total ET 1 seul accord/PRM (mono-logement strict)
          const distinctPrmsFound = [...new Set(propertyMapping.map(m => m.prm).filter(Boolean))];
          if (propertyIds.length === 1 && agreementIds.length <= 1 && distinctPrmsFound.length <= 1) {
            for (const m of propertyMapping) {
              if (!m.propertyId) m.propertyId = propertyIds[0];
            }
          }

          // 5. Règle bijective pour 2 contrats / 2 logements
          if (agreementIds.length === 2 && propertyIds.length === 2) {
            const mapped0 = propertyMapping.find(m => m.agreementId === agreementIds[0] || (m.prm && m.propertyId));
            const mapped1 = propertyMapping.find(m => m.agreementId === agreementIds[1]);
            if (mapped0?.propertyId && (!mapped1 || !mapped1.propertyId)) {
              const remainingPid = propertyIds.find(pid => pid !== mapped0.propertyId);
              if (remainingPid) {
                propertyMapping.push({ propertyId: remainingPid, agreementId: agreementIds[1], prm: null });
              }
            } else if (mapped1?.propertyId && (!mapped0 || !mapped0.propertyId)) {
              const remainingPid = propertyIds.find(pid => pid !== mapped1.propertyId);
              if (remainingPid) {
                propertyMapping.push({ propertyId: remainingPid, agreementId: agreementIds[0], prm: null });
              }
            }
          }

          return { agreementIds, agreementId: agreementIds[0] || null, propertyIds, propertyMapping };
        } else {
          // Onglet Espace Client octopusenergy.fr
          const contractLinks = [...document.querySelectorAll('a[href*="contrats/"]')];
          const agreementIds = [...new Set(contractLinks.map(a => a.getAttribute("href")?.match(/contrats\/(\d+)/)?.[1]).filter(Boolean))];
          const logementLinks = [...document.querySelectorAll('a[href*="logements/"]')];
          const propertyIds = [...new Set(logementLinks.map(a => a.getAttribute("href")?.match(/logements\/(\d+)/)?.[1]).filter(Boolean))];
          const urlPropMatch = window.location.pathname.match(/logements\/(\d+)/);
          if (urlPropMatch && !propertyIds.includes(urlPropMatch[1])) propertyIds.push(urlPropMatch[1]);

          // Scanner tous les liens /logements/ dans le HTML complet
          try {
            const htmlStr = document.documentElement.innerHTML || "";
            const htmlLogements = [...htmlStr.matchAll(/\/logements\/(\d+)/g)].map(m => m[1]);
            for (const hl of htmlLogements) {
              if (!propertyIds.includes(hl)) propertyIds.push(hl);
            }
          } catch (_) {}

          const propertyMapping = [];

          // Scanner les scripts Next.js App Router (self.__next_f)
          try {
            const scriptTags = [...document.querySelectorAll("script")];
            for (const sc of scriptTags) {
              const text = sc.textContent || "";
              if (text.includes("self.__next_f") || text.includes("__NEXT_DATA__") || text.includes("PropertyType") || text.includes("logements/")) {
                const pMatches = [...text.matchAll(/\/logements\/(\d+)/g)].map(m => m[1]);
                for (const pm of pMatches) {
                  if (!propertyIds.includes(pm)) propertyIds.push(pm);
                }
                const propIdMatches = [...text.matchAll(/"propertyId"\s*:\s*"?(\d{5,8})"?/g)].map(m => m[1]);
                for (const pim of propIdMatches) {
                  if (!propertyIds.includes(pim)) propertyIds.push(pim);
                }
              }
            }
          } catch (_) {}

          const nextDataEl = document.getElementById("__NEXT_DATA__");
          if (nextDataEl && nextDataEl.textContent) {
            try {
              const nextData = JSON.parse(nextDataEl.textContent);
              const walk = (node, depth = 0) => {
                if (!node || depth > 8) return;
                if (Array.isArray(node)) {
                  for (const it of node) walk(it, depth + 1);
                  return;
                }
                if (typeof node === "object") {
                  if (node.id && (node.electricitySupplyPoints || node.supplyPoints || node.gasSupplyPoints || node.address || node.__typename === "PropertyType")) {
                    const pId = String(node.id);
                    if (!propertyIds.includes(pId)) propertyIds.push(pId);
                    const sps = [...(node.electricitySupplyPoints || []), ...(node.supplyPoints || []), ...(node.gasSupplyPoints || [])];
                    for (const sp of sps) {
                      const prmVal = sp.marketSupplyPointId || sp.externalIdentifier || sp.prm || sp.id || sp.meterPoint?.id;
                      const ags = sp.agreements || [];
                      for (const ag of ags) {
                        const agId = ag.id ? String(ag.id) : null;
                        if (agId && !agreementIds.includes(agId)) agreementIds.push(agId);
                        propertyMapping.push({ propertyId: pId, agreementId: agId, prm: prmVal ? String(prmVal) : null });
                      }
                      if (prmVal) {
                        propertyMapping.push({ propertyId: pId, agreementId: null, prm: String(prmVal) });
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

          return { agreementIds, agreementId: agreementIds[0] || null, propertyIds, propertyMapping };
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
    await saveAccountToCache(accountNumber, result.contracts, propertyMapping, propertyIds);

    // Lancement de l'enrichissement conso en tâche de fond (sans bloquer l'affichage de l'interface)
    enrichContractsWithConso(result.contracts, accountNumber, propertyMapping, propertyIds)
      .then(async (enriched) => {
        await saveAccountToCache(accountNumber, enriched, propertyMapping, propertyIds);
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
        await saveAccountToCache(accountNumber, syncedContracts, propertyMapping, propertyIds);

        enrichContractsWithConso(syncedContracts, accountNumber, propertyMapping, propertyIds)
          .then(async (enriched) => {
            await saveAccountToCache(accountNumber, enriched, propertyMapping, propertyIds);
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

// Mutex pour empêcher plusieurs performBackgroundSync simultanés (prévention des onglets multiples)
const _bgSyncLocks = new Map();

/**
 * Effectue la synchronisation masquerade en tâche de fond dans le service worker,
 * en créant un onglet inactif (active: false) pour ne PAS voler le focus ni fermer le popup,
 * et en garantissant la fermeture de cet onglet quoi qu'il arrive (dans le bloc finally).
 *
 * Protégée par un mutex par compte : si un sync est déjà en cours pour le même compte,
 * les appels concurrents attendent la fin du premier au lieu de créer de nouveaux onglets.
 */
async function performBackgroundSync(tabId, accountNumber, idsToQuery, propertyMapping = [], propertyIds = []) {
  // Vérifier si un sync est déjà en cours pour ce compte
  const lockKey = accountNumber || "__default__";
  if (_bgSyncLocks.has(lockKey)) {
    console.log(`[Background] ⏳ Sync déjà en cours pour ${lockKey}, attente de la fin...`);
    try {
      await _bgSyncLocks.get(lockKey);
    } catch (_) {}
    // Après l'attente, retourner true (la session a été synchronisée par l'appel précédent)
    return true;
  }

  // Créer le verrou
  let releaseLock;
  const lockPromise = new Promise((resolve) => { releaseLock = resolve; });
  _bgSyncLocks.set(lockKey, lockPromise);

  let createdTabId = null;
  try {
    // 0. S'assurer que la commande masquerade s'exécute bien sur un onglet Kraken support
    let krakenTabId = tabId;
    try {
      const currentTab = krakenTabId ? await chrome.tabs.get(krakenTabId).catch(() => null) : null;
      if (!currentTab || !currentTab.url || !currentTab.url.includes("support.oefr-kraken.energy")) {
        const allKraken = await chrome.tabs.query({ url: "https://support.oefr-kraken.energy/*" });
        const matching = allKraken.find(t => t.url && t.url.includes(accountNumber)) || allKraken[0];
        if (matching) krakenTabId = matching.id;
      }
    } catch (_) {}

    if (!krakenTabId) {
      throw new Error("Onglet Kraken support introuvable pour synchroniser la session");
    }

    // 1. Récupérer l'action masquerade et le token CSRF depuis l'onglet Kraken actuel sans ouvrir d'onglet
    const [execRes] = await chrome.scripting.executeScript({
      target: { tabId: krakenTabId },
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
        func: async () => {
          const foundIds = new Set();
          const mapping = [];

          // 1. Scanner tous les liens /logements/ dans le HTML complet
          try {
            const htmlStr = document.documentElement.innerHTML || "";
            const links = [...htmlStr.matchAll(/\/logements\/(\d+)/g)].map(m => m[1]);
            for (const l of links) foundIds.add(String(l));
          } catch (_) {}

          // 2. Scanner les scripts Next.js App Router (self.__next_f)
          try {
            const scriptTags = [...document.querySelectorAll("script")];
            for (const sc of scriptTags) {
              const text = sc.textContent || "";
              if (text.includes("self.__next_f") || text.includes("__NEXT_DATA__") || text.includes("PropertyType") || text.includes("logements/")) {
                const lms = [...text.matchAll(/\/logements\/(\d+)/g)].map(m => m[1]);
                for (const m of lms) foundIds.add(String(m));
                const pids = [...text.matchAll(/"propertyId"\s*:\s*"?(\d{5,8})"?/g)].map(m => m[1]);
                for (const m of pids) foundIds.add(String(m));
              }
            }
          } catch (_) {}

          // 3. Exécuter une requête GraphQL first-party directement dans l'onglet authentifié
          try {
            const gqlRes = await fetch("/api/graphql/kraken", {
              method: "POST",
              headers: {
                "Accept": "application/graphql-response+json, application/json",
                "Content-Type": "application/json"
              },
              credentials: "include",
              body: JSON.stringify({
                query: `
                  query GetAccountPropsDirect {
                    viewer {
                      accounts {
                        number
                        properties {
                          id
                          electricitySupplyPoints {
                            id
                            marketSupplyPointId
                            agreements { id }
                          }
                          gasSupplyPoints {
                            id
                            marketSupplyPointId
                            agreements { id }
                          }
                        }
                      }
                    }
                  }
                `,
                operationName: "GetAccountPropsDirect"
              })
            });
            if (gqlRes.ok) {
              const gqlJson = await gqlRes.json();
              const accs = gqlJson?.data?.viewer?.accounts || [];
              for (const acc of accs) {
                for (const prop of (acc.properties || [])) {
                  if (prop.id) {
                    const pid = String(prop.id);
                    foundIds.add(pid);
                    const sps = [...(prop.electricitySupplyPoints || []), ...(prop.gasSupplyPoints || [])];
                    for (const sp of sps) {
                      const prm = sp.marketSupplyPointId || sp.externalIdentifier;
                      for (const ag of (sp.agreements || [])) {
                        mapping.push({ propertyId: pid, agreementId: ag.id ? String(ag.id) : null, prm: prm ? String(prm) : null });
                      }
                      if (prm) mapping.push({ propertyId: pid, agreementId: null, prm: String(prm) });
                    }
                  }
                }
              }
            }
          } catch (_) {}

          // 4. Fallback __NEXT_DATA__
          const nextDataEl = document.getElementById("__NEXT_DATA__");
          if (nextDataEl && nextDataEl.textContent) {
            try {
              const data = JSON.parse(nextDataEl.textContent);
              const walk = (node, depth = 0) => {
                if (!node || depth > 8) return;
                if (Array.isArray(node)) {
                  for (const it of node) walk(it, depth + 1);
                  return;
                }
                if (typeof node === "object") {
                  if (node.id && (node.electricitySupplyPoints || node.supplyPoints || node.gasSupplyPoints || node.address || node.__typename === "PropertyType")) {
                    const pId = String(node.id);
                    foundIds.add(pId);
                    const sps = [...(node.electricitySupplyPoints || []), ...(node.supplyPoints || []), ...(node.gasSupplyPoints || [])];
                    for (const sp of sps) {
                      const prmVal = sp.marketSupplyPointId || sp.externalIdentifier || sp.prm || sp.id || sp.meterPoint?.id;
                      const ags = sp.agreements || [];
                      for (const ag of ags) {
                        mapping.push({ propertyId: pId, agreementId: ag.id ? String(ag.id) : null, prm: prmVal ? String(prmVal) : null });
                      }
                      if (prmVal) {
                        mapping.push({ propertyId: pId, agreementId: null, prm: String(prmVal) });
                      }
                    }
                  }
                  for (const k of Object.keys(node)) {
                    walk(node[k], depth + 1);
                  }
                }
              };
              walk(data);
            } catch (_) {}
          }
          return { propertyIds: [...foundIds], mapping };
        }
      });
      if (domRes?.result) {
        if (Array.isArray(domRes.result.propertyIds)) {
          for (const p of domRes.result.propertyIds) {
            if (!propertyIds.includes(p)) propertyIds.push(p);
          }
        }
        if (Array.isArray(domRes.result.mapping)) {
          for (const m of domRes.result.mapping) {
            propertyMapping.push(m);
          }
        }
      }
    } catch (_) {}

    // 7. Requête GraphQL avec les cookies maintenant actifs (si des contrats étaient demandés)
    if (idsToQuery && idsToQuery.length > 0 && idsToQuery[0] !== null) {
      const result = await executeAgreementsQuery(accountNumber, idsToQuery);
      if (result.contracts && result.contracts.length > 0) {
        return result.contracts;
      }
      throw new Error("Aucun contrat trouvé après synchronisation");
    }

    return true;
  } finally {
    // FERMETURE GARANTIE DE L'ONGLET EN ARRIÈRE-PLAN
    if (createdTabId) {
      try {
        await chrome.tabs.remove(createdTabId);
        console.log("[Background] Onglet masquerade fermé automatiquement :", createdTabId);
      } catch (_) {}
    }
    // Libérer le verrou pour permettre de futurs syncs
    const lockKey = accountNumber || "__default__";
    _bgSyncLocks.delete(lockKey);
    if (releaseLock) releaseLock();
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

  // Sécurité : si aucun mois ne correspond aux filtres de dates (ex: contrat venant de démarrer), inclure le mois courant
  if (ranges.length === 0) {
    ranges.push(formatMonthBoundaries(now.getFullYear(), now.getMonth()));
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
        if (res.status === 401 || res.status === 403) {
          throw new Error(`AUTH_${res.status}`);
        }
        return null;
      }

      const json = await res.json();
      if (json.errors && json.errors.length > 0) {
        const isAuth = json.errors.some(e => {
          const msg = (e.message || "").toLowerCase();
          const code = (e.extensions?.code || "").toLowerCase();
          return msg.includes("auth") || msg.includes("login") || msg.includes("logged in") || msg.includes("forbidden") || msg.includes("permission") || code.includes("unauth") || code.includes("forbidden");
        });
        if (isAuth) {
          throw new Error("AUTH_GRAPHQL");
        }
        console.warn(`[Background] Erreurs GraphQL pour mois ${range.yearMonth} :`, json.errors);
        return null;
      }

      const edges = json?.data?.property?.measurements?.edges || [];
      return parsePropertyMeasurementsMonth(edges, range, contract);
    } catch (err) {
      if (err.message && err.message.startsWith("AUTH_")) {
        throw err;
      }
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
  const totalHp = Math.round(allMonths.reduce((sum, m) => sum + (m.hpKwh || 0), 0) * 100) / 100;
  const totalHc = Math.round(allMonths.reduce((sum, m) => sum + (m.hcKwh || 0), 0) * 100) / 100;
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
    totalHp: totalHp,
    totalHc: totalHc,
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
 * Interroge l'API GraphQL d'Octopus Energy pour récupérer directement tous les logements
 * (properties) rattachés à un compte client et leurs PRMs associés
 */
async function fetchAccountPropertiesFromGraphQL(accountNumber) {
  if (!accountNumber) return { propertyIds: [], propertyMapping: [] };

  const queries = [
    {
      name: "GetAccountProperties",
      query: `
        query GetAccountProperties($accountNumber: String!) {
          account(accountNumber: $accountNumber) {
            id
            number
            properties {
              id
              address { fullAddress }
              electricitySupplyPoints {
                id
                marketSupplyPointId
                agreements { id }
              }
              gasSupplyPoints {
                id
                marketSupplyPointId
                agreements { id }
              }
            }
          }
        }
      `,
      variables: { accountNumber }
    },
    {
      name: "GetViewerProperties",
      query: `
        query GetViewerProperties {
          viewer {
            accounts {
              number
              properties {
                id
                address { fullAddress }
                electricitySupplyPoints {
                  id
                  marketSupplyPointId
                  agreements { id }
                }
                gasSupplyPoints {
                  id
                  marketSupplyPointId
                  agreements { id }
                }
              }
            }
          }
        }
      `,
      variables: {}
    }
  ];

  const foundIds = new Set();
  const mapping = [];

  for (const q of queries) {
    try {
      const res = await fetch("https://octopusenergy.fr/api/graphql/kraken", {
        method: "POST",
        headers: {
          "Accept": "application/graphql-response+json, application/json",
          "Content-Type": "application/json"
        },
        credentials: "include",
        body: JSON.stringify({
          query: q.query,
          variables: q.variables,
          operationName: q.name
        })
      });

      if (!res.ok) continue;
      const json = await res.json();
      if (json.errors && json.errors.length > 0) {
        continue;
      }

      let props = [];
      if (json?.data?.account?.properties) {
        props = json.data.account.properties;
      } else if (json?.data?.viewer?.accounts) {
        const acc = json.data.viewer.accounts.find(a => a.number === accountNumber) || json.data.viewer.accounts[0];
        if (acc?.properties) props = acc.properties;
      }

      if (Array.isArray(props) && props.length > 0) {
        for (const p of props) {
          if (!p?.id) continue;
          const pid = String(p.id);
          foundIds.add(pid);
          const sps = [...(p.electricitySupplyPoints || []), ...(p.gasSupplyPoints || [])];
          for (const sp of sps) {
            const prm = sp.marketSupplyPointId || sp.externalIdentifier;
            const ags = sp.agreements || [];
            for (const ag of ags) {
              mapping.push({
                propertyId: pid,
                agreementId: ag.id ? String(ag.id) : null,
                prm: prm ? String(prm) : null
              });
            }
            if (prm) {
              mapping.push({ propertyId: pid, agreementId: null, prm: String(prm) });
            }
          }
        }
        if (foundIds.size > 0) {
          console.log(`[Background] 🎯 Logements découverts via ${q.name} :`, [...foundIds], mapping);
          return { propertyIds: [...foundIds], propertyMapping: mapping };
        }
      }
    } catch (e) {
      console.warn(`[Background] Échec ${q.name} :`, e.message);
    }
  }

  return { propertyIds: [...foundIds], propertyMapping: mapping };
}

/**
 * Résout automatiquement le propertyId de chaque contrat en associant les supplyPoints
 * Gère le multi-logement avec extraction DOM, analyse des pages Espace Client et validation dynamique par GetPropertyMeasurements
 */
async function resolvePropertyIdsForContracts(accountNumber, contracts, propertyMapping = [], propertyIds = []) {
  if (!contracts || contracts.length === 0) return contracts;

  const toCache = {};

  // 1. Récupérer l'ensemble des contrats du compte depuis le cache si disponible
  // pour avoir une vue multi-logements globale même si un sous-ensemble a été passé
  let allContracts = contracts;
  try {
    const cached = await getCachedAccount(accountNumber);
    if (cached && Array.isArray(cached) && cached.length > 0) {
      const mapById = new Map();
      for (const c of cached) if (c && c.id) mapById.set(String(c.id), c);
      for (const c of contracts) if (c && c.id) mapById.set(String(c.id), c);
      allContracts = [...mapById.values()];
    }
  } catch (_) {}

  // 2. Appliquer le mapping direct extrait du DOM de Kraken / Espace Client si fourni
  if (Array.isArray(propertyMapping) && propertyMapping.length > 0) {
    for (const m of propertyMapping) {
      if (!m.propertyId) continue;
      const propId = String(m.propertyId);
      if (m.prm) {
        const c = allContracts.find(c => c.prm === String(m.prm));
        if (c) {
          c.propertyId = propId;
          toCache[`prop_id_${c.prm}`] = propId;
        }
      }
      if (m.agreementId) {
        const c = allContracts.find(c => String(c.id) === String(m.agreementId));
        if (c) {
          c.propertyId = propId;
          if (c.prm && c.prm !== "-") toCache[`prop_id_${c.prm}`] = propId;
        }
      }
    }
  }

  // 3. Recherche dans le cache local (prop_id_${prm})
  try {
    const missing = allContracts.filter(c => !c.propertyId && c.prm && c.prm !== "-");
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

  // 4. Nettoyage proactif de tout cache local stale 717277 ET des collisions multi-logements
  try {
    const seenPids = new Map();
    for (const c of allContracts) {
      if (c.propertyId === "717277" && c.prm) {
        c.propertyId = null;
        await chrome.storage.local.remove([`prop_id_${c.prm}`]);
      } else if (c.propertyId && c.prm) {
        if (seenPids.has(c.propertyId)) {
          // Deux PRMs distincts ne peuvent pas partager le même propertyId élec
          const otherPrm = seenPids.get(c.propertyId);
          console.warn(`[Background] ⚠️ Collision propertyId ${c.propertyId} entre PRM ${c.prm} et ${otherPrm}, réinitialisation`);
          c.propertyId = null;
          await chrome.storage.local.remove([`prop_id_${c.prm}`]);
        } else {
          seenPids.set(c.propertyId, c.prm);
        }
      }
    }
  } catch (_) {}

  // 5. Collecte de tous les propertyIds candidats (depuis DOM, HTML Espace Client, Next.js)
  const candidatePropIds = new Set();
  if (Array.isArray(propertyIds)) {
    for (const pid of propertyIds) {
      if (pid) candidatePropIds.add(String(pid));
    }
  }
  for (const m of propertyMapping) {
    if (m?.propertyId) candidatePropIds.add(String(m.propertyId));
  }
  for (const c of allContracts) {
    if (c.propertyId) candidatePropIds.add(String(c.propertyId));
  }

  // 6. Interrogation directe GraphQL pour récupérer la cartographie officielle des logements si des contrats sont manquants
  const distinctPrms = [...new Set(allContracts.map(c => c.prm).filter(p => p && p !== "-"))];
  if (allContracts.some(c => !c.propertyId && c.prm && c.prm !== "-")) {
    try {
      const gqlProps = await fetchAccountPropertiesFromGraphQL(accountNumber);
      if (gqlProps?.propertyIds?.length > 0) {
        for (const pid of gqlProps.propertyIds) candidatePropIds.add(String(pid));
        if (Array.isArray(gqlProps.propertyMapping)) {
          for (const m of gqlProps.propertyMapping) {
            if (m.propertyId) candidatePropIds.add(String(m.propertyId));
            if (m.prm) {
              const cMatch = allContracts.find(c => c.prm === String(m.prm));
              if (cMatch && !cMatch.propertyId) {
                cMatch.propertyId = String(m.propertyId);
                toCache[`prop_id_${cMatch.prm}`] = String(m.propertyId);
              }
            }
          }
        }
      }
    } catch (_) {}
  }

  // Règle mono-logement stricte : uniquement si 1 seul PRM élec sur le compte
  if (candidatePropIds.size === 1 && distinctPrms.length <= 1) {
    const singlePid = [...candidatePropIds][0];
    for (const c of allContracts) {
      if (!c.propertyId) {
        c.propertyId = singlePid;
        if (c.prm && c.prm !== "-") toCache[`prop_id_${c.prm}`] = singlePid;
      }
    }
  }

  // Si tous les contrats passés ont déjà leur propertyId résolu, enregistrer et terminer
  const stillMissingPassed = contracts.filter(c => !c.propertyId && c.prm && c.prm !== "-");
  if (stillMissingPassed.length === 0) {
    for (const c of contracts) {
      if (!c.propertyId) {
        const found = allContracts.find(a => String(a.id) === String(c.id) || a.prm === c.prm);
        if (found?.propertyId) c.propertyId = found.propertyId;
      }
    }
    if (Object.keys(toCache).length > 0) {
      await chrome.storage.local.set(toCache);
    }
    return contracts;
  }

  // 7. Exploration des pages Espace Client pour découvrir tous les identifiants de logements
  try {
    const knownAssigned = allContracts.map(c => c.propertyId).filter(Boolean);
    const crawlIds = [...new Set([...knownAssigned, ...candidatePropIds])];
    const urlsToCrawl = [
      `https://octopusenergy.fr/espace-client/comptes/${accountNumber}`,
      `https://octopusenergy.fr/espace-client/comptes/${accountNumber}/logements`,
      `https://octopusenergy.fr/fr/espace-client/comptes/${accountNumber}`,
      `https://octopusenergy.fr/fr/espace-client/comptes/${accountNumber}/logements`
    ];
    for (const cid of crawlIds) {
      urlsToCrawl.push(`https://octopusenergy.fr/espace-client/comptes/${accountNumber}/logements/${cid}/suivi-conso`);
      urlsToCrawl.push(`https://octopusenergy.fr/fr/espace-client/comptes/${accountNumber}/logements/${cid}/suivi-conso`);
    }

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

        // B) Analyse des scripts Next.js App Router (self.__next_f)
        const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
        for (const sm of scriptMatches) {
          const text = sm[1] || "";
          if (text.includes("self.__next_f") || text.includes("logements/") || text.includes("PropertyType")) {
            const lms = [...text.matchAll(/\/logements\/(\d+)/g)].map(m => m[1]);
            for (const lm of lms) candidatePropIds.add(String(lm));
            const pids = [...text.matchAll(/"propertyId"\s*:\s*"?(\d{5,8})"?/g)].map(m => m[1]);
            for (const pid of pids) candidatePropIds.add(String(pid));
          }
        }

        // C) Analyse de __NEXT_DATA__
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
                      const cMatch = allContracts.find(c => c.prm === String(prmVal));
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

  // 8. Règle bijective déterministe pour compte à 2 logements
  if (allContracts.length === 2 && candidatePropIds.size >= 2) {
    const c0 = allContracts[0];
    const c1 = allContracts[1];
    if (c0.propertyId && !c1.propertyId) {
      const remaining = [...candidatePropIds].filter(id => id !== c0.propertyId);
      if (remaining.length > 0) {
        c1.propertyId = remaining[0];
        toCache[`prop_id_${c1.prm}`] = remaining[0];
        console.log(`[Background] 🎯 Résolution bijective : PRM ${c1.prm} -> logement ${remaining[0]}`);
      }
    } else if (c1.propertyId && !c0.propertyId) {
      const remaining = [...candidatePropIds].filter(id => id !== c1.propertyId);
      if (remaining.length > 0) {
        c0.propertyId = remaining[0];
        toCache[`prop_id_${c0.prm}`] = remaining[0];
        console.log(`[Background] 🎯 Résolution bijective : PRM ${c0.prm} -> logement ${remaining[0]}`);
      }
    }
  }

  // 9. Déduction & Validation dynamique avec GetPropertyMeasurements
  const missingContracts = allContracts.filter(c => !c.propertyId && c.prm && c.prm !== "-");
  const usedPropIds = new Set(allContracts.map(c => c.propertyId).filter(Boolean));

  console.log("[Background] Résolution multi-logements :", {
    missingPRMs: missingContracts.map(c => c.prm),
    candidatePropIds: [...candidatePropIds],
    usedPropIds: [...usedPropIds]
  });

  for (const c of missingContracts) {
    // Calculer les identifiants encore disponibles
    const available = [...candidatePropIds].filter(id => !usedPropIds.has(id));

    // Si un seul ID candidat restant pour ce contrat manquant -> affectation immédiate par élimination
    if (available.length === 1) {
      const assigned = available[0];
      console.log(`[Background] 🎯 Affectation par élimination : PRM ${c.prm} -> logement ${assigned}`);
      c.propertyId = assigned;
      toCache[`prop_id_${c.prm}`] = assigned;
      usedPropIds.add(assigned);
      try {
        const testConso = await fetchMeasurementsByProperty(assigned, c.prm, c);
        if (testConso && testConso.hasData) {
          c.consoMensuelle = testConso;
        }
      } catch (_) {}
      continue;
    }

    // Tester dynamiquement chaque candidat avec GetPropertyMeasurements
    let found = false;
    for (const candId of available) {
      try {
        console.log(`[Background] Test GetPropertyMeasurements avec propertyId=${candId} pour PRM ${c.prm}...`);
        const testConso = await fetchMeasurementsByProperty(candId, c.prm, c);
        if (testConso && testConso.hasData) {
          console.log(`[Background] Validé ! PRM ${c.prm} associé au logement ${candId}`);
          c.propertyId = candId;
          c.consoMensuelle = testConso;
          toCache[`prop_id_${c.prm}`] = candId;
          usedPropIds.add(candId);
          found = true;
          break;
        }
      } catch (tErr) {
        console.warn(`[Background] Échec test candId ${candId} :`, tErr.message);
      }
    }

    // Si le test n'a pas répondu mais qu'il ne reste qu'un candidat disponible après les tests
    if (!found) {
      const remainingAvail = [...candidatePropIds].filter(id => !usedPropIds.has(id));
      if (remainingAvail.length === 1) {
        c.propertyId = remainingAvail[0];
        toCache[`prop_id_${c.prm}`] = remainingAvail[0];
        usedPropIds.add(remainingAvail[0]);
      }
    }
  }

  // Reporter sur la liste contracts d'origine
  for (const c of contracts) {
    if (!c.propertyId) {
      const matched = allContracts.find(a => String(a.id) === String(c.id) || a.prm === c.prm);
      if (matched?.propertyId) c.propertyId = matched.propertyId;
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

  // SÉQUENTIEL au lieu de Promise.all pour éviter que chaque contrat
  // déclenche simultanément un performBackgroundSync et ouvre N onglets
  for (const c of contracts) {
    if (c.prm && c.prm !== "-") {
      if (c.consoMensuelle && c.consoMensuelle.hasData) {
        continue;
      }
      try {
        const conso = await fetchMonthlyConsumptionData(accountNumber, c.prm, c.propertyId, c, propertyMapping, propertyIds);
        if (conso) {
          c.consoMensuelle = conso;
          if (conso.propertyId && !c.propertyId) {
            c.propertyId = conso.propertyId;
          }
        }
      } catch (consoErr) {
        console.warn(`[Background] Suivi conso non disponible pour PRM ${c.prm} :`, consoErr.message);
      }
    }
  }
  return contracts;
}

/**
 * Récupère le suivi de consommation pour un PRM spécifique
 */
async function fetchMonthlyConsumptionData(accountNumber, prmId, propertyId, contract = null, propertyMapping = [], propertyIds = [], tabId = null, forceSync = false) {
  if (!accountNumber || !prmId || prmId === "-") {
    return {
      hasData: false,
      message: "PRM non renseigné pour ce contrat."
    };
  }

  console.log(`[Background] Récupération suivi conso pour compte ${accountNumber}, PRM ${prmId}, propertyId initial ${propertyId}...`);

  // 1. Déterminer un onglet Kraken support valide pour masquerade
  let krakenTabId = null;
  try {
    const krakenTabs = await chrome.tabs.query({ url: "https://support.oefr-kraken.energy/*" });
    const matching = krakenTabs.find(t => t.url && t.url.includes(accountNumber)) || krakenTabs[0];
    if (matching) krakenTabId = matching.id;
  } catch (_) {}
  if (!krakenTabId && tabId) {
    try {
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (t && t.url && t.url.includes("support.oefr-kraken.energy")) {
        krakenTabId = t.id;
      }
    } catch (_) {}
  }

  let currentPropIds = Array.isArray(propertyIds) ? [...propertyIds] : [];
  let currentMapping = Array.isArray(propertyMapping) ? [...propertyMapping] : [];

  // Si propertyId est manquant et propertyIds/propertyMapping sont vides, tenter l'extraction directe sur l'onglet Kraken
  if ((!propertyId || currentPropIds.length === 0) && krakenTabId) {
    try {
      const domContext = await extractTabContextForPreload(krakenTabId, true);
      if (domContext) {
        if (currentPropIds.length === 0 && domContext.propertyIds?.length > 0) currentPropIds = domContext.propertyIds;
        if (currentMapping.length === 0 && domContext.propertyMapping?.length > 0) currentMapping = domContext.propertyMapping;
      }
    } catch (_) {}
  }

  // 2. Résolution intelligente et mise en cache du propertyId
  if (!propertyId) {
    try {
      // A) Recherche dans le mapping DOM direct
      if (Array.isArray(currentMapping) && currentMapping.length > 0) {
        const m = currentMapping.find(item => item.prm === String(prmId) || (contract && String(item.agreementId) === String(contract.id)));
        if (m && m.propertyId) {
          propertyId = String(m.propertyId);
        }
      }

      // B) Recherche dans le cache local (uniquement si non obsolète et sans collision)
      if (!propertyId) {
        const cache = await chrome.storage.local.get([`prop_id_${prmId}`]);
        const cachedPid = cache[`prop_id_${prmId}`] || null;
        if (cachedPid && cachedPid !== "717277") {
          let hasCollision = false;
          const cachedAcc = await getCachedAccount(accountNumber);
          if (cachedAcc && Array.isArray(cachedAcc)) {
            const other = cachedAcc.find(c => c.prm && c.prm !== prmId && String(c.propertyId) === String(cachedPid));
            if (other) hasCollision = true;
          }
          if (!hasCollision) {
            propertyId = cachedPid;
          } else {
            await chrome.storage.local.remove([`prop_id_${prmId}`]);
          }
        } else if (cachedPid === "717277") {
          await chrome.storage.local.remove([`prop_id_${prmId}`]);
        }
      }

      // C) Si un seul ID de propriété existe sur la page Kraken ET qu'il n'y a qu'un seul contrat élec sur le compte
      if (!propertyId && currentPropIds.length === 1) {
        const cachedAcc = await getCachedAccount(accountNumber);
        const distinctPrms = (cachedAcc && Array.isArray(cachedAcc))
          ? [...new Set(cachedAcc.map(c => c.prm).filter(p => p && p !== "-"))]
          : [];
        if (distinctPrms.length <= 1) {
          propertyId = String(currentPropIds[0]);
        }
      }

      // D) Résolution contextuelle avec l'ensemble des contrats
      if (!propertyId && contract) {
        let contractsToResolve = [contract];
        const cached = await getCachedAccount(accountNumber);
        if (cached && Array.isArray(cached) && cached.length > 0) {
          contractsToResolve = cached.map(c => String(c.id) === String(contract.id) || c.prm === contract.prm ? contract : c);
        }
        await resolvePropertyIdsForContracts(accountNumber, contractsToResolve, currentMapping, currentPropIds);
        const found = contractsToResolve.find(c => c.prm === prmId || String(c.id) === String(contract.id));
        if (found?.propertyId) {
          propertyId = found.propertyId;
          contract.propertyId = found.propertyId;
        }
      }
    } catch (_) {}
  }

  // 3. Tenter la requête officielle Espace Client GetPropertyMeasurements
  let propertyConso = null;
  let authErrorOccurred = false;

  const tryGetPropertyMeasurements = async (pid) => {
    if (!pid) return null;
    try {
      return await fetchMeasurementsByProperty(pid, prmId, contract);
    } catch (pErr) {
      if (pErr.message && (pErr.message.includes("AUTH") || pErr.message.includes("401") || pErr.message.includes("403"))) {
        authErrorOccurred = true;
      }
      console.warn(`[Background] Échec fetchMeasurementsByProperty pour property ${pid} :`, pErr.message);
      return null;
    }
  };

  if (propertyId) {
    propertyConso = await tryGetPropertyMeasurements(propertyId);
  }

  // Si le propertyId testé n'a rien renvoyé (mauvais logement ou cache périmé), tester les autres candidats disponibles
  if ((!propertyConso || !propertyConso.hasData) && !authErrorOccurred && currentPropIds.length > 0) {
    for (const altPid of currentPropIds) {
      if (String(altPid) === String(propertyId)) continue;
      console.log(`[Background] 🔄 Test alternatif propertyId=${altPid} pour PRM ${prmId}...`);
      const altConso = await tryGetPropertyMeasurements(altPid);
      if (altConso && altConso.hasData) {
        console.log(`[Background] 🎯 Succès avec propertyId alternatif ${altPid} pour PRM ${prmId} !`);
        propertyId = String(altPid);
        propertyConso = altConso;
        await chrome.storage.local.set({ [`prop_id_${prmId}`]: propertyId });
        break;
      }
    }
  }

  // 4. Synchronisation de session UNIQUEMENT sur erreur d'authentification avérée ou forceSync explicite
  // Ne PAS déclencher de sync masquerade simplement parce que les données sont absentes
  // (elles pourraient ne pas encore exister côté Enedis)
  const needsSync = (authErrorOccurred || forceSync) && krakenTabId;
  if (needsSync) {
    console.log(`[Background] 🔄 Session requise (auth=${authErrorOccurred}, force=${forceSync}), exécution de performBackgroundSync...`);
    try {
      await performBackgroundSync(krakenTabId, accountNumber, contract?.id ? [contract.id] : null, currentMapping, currentPropIds);
      authErrorOccurred = false;

      // Re-résolution avec la session fraîche
      let contractsToResolve = contract ? [contract] : [];
      const cached = await getCachedAccount(accountNumber);
      if (cached && Array.isArray(cached) && cached.length > 0) {
        contractsToResolve = cached.map(c => String(c.id) === String(contract?.id) || c.prm === contract?.prm ? contract : c);
      }
      await resolvePropertyIdsForContracts(accountNumber, contractsToResolve, currentMapping, currentPropIds);
      const foundAfterSync = contractsToResolve.find(c => c.prm === prmId || String(c.id) === String(contract?.id));
      if (foundAfterSync?.propertyId) {
        propertyId = foundAfterSync.propertyId;
        if (contract) contract.propertyId = foundAfterSync.propertyId;
      }

      // Retenter GetPropertyMeasurements avec les nouveaux cookies de session
      if (propertyId) {
        propertyConso = await tryGetPropertyMeasurements(propertyId);
      }

      // Si toujours pas de données, tester tous les propertyIds découverts
      if ((!propertyConso || !propertyConso.hasData) && currentPropIds.length > 0) {
        for (const altPid of currentPropIds) {
          if (String(altPid) === String(propertyId)) continue;
          const altConso = await tryGetPropertyMeasurements(altPid);
          if (altConso && altConso.hasData) {
            propertyId = String(altPid);
            propertyConso = altConso;
            await chrome.storage.local.set({ [`prop_id_${prmId}`]: propertyId });
            break;
          }
        }
      }
    } catch (syncErr) {
      console.warn("[Background] Échec performBackgroundSync pour suivi conso :", syncErr.message);
    }
  }

  // Si les mesures officielles par propriété sont disponibles, mise en cache et retour immédiat
  if (propertyConso && propertyConso.hasData) {
    propertyConso.propertyId = propertyId;
    if (propertyId) {
      await chrome.storage.local.set({ [`prop_id_${prmId}`]: propertyId });
    }
    return propertyConso;
  }

  // 5. Repli sur les relevés Linky GraphQL Relay
  const readingNodes = await fetchAllElectricityReadingsForPrm(accountNumber, prmId);
  if (readingNodes && readingNodes.length > 0) {
    const aggregated = aggregateReadingsByMonth(readingNodes, contract);
    if (aggregated && aggregated.hasData) {
      if (propertyId) aggregated.propertyId = propertyId;
      console.log(`[Background] Suivi conso obtenu via Relay pour PRM ${prmId} (${aggregated.totalMoisDisponibles} mois).`);
      return aggregated;
    }
  }

  // 6. Repli sur la page Next.js suivi-conso
  if (propertyId) {
    const pageData = await fetchSuiviConsoPageData(accountNumber, propertyId, contract);
    if (pageData && pageData.hasData) {
      pageData.propertyId = propertyId;
      return pageData;
    }
  }

  return {
    hasData: false,
    propertyId: propertyId || null,
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
        if (nodes.length > 0) {
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
  const totalHp = Math.round(allMonths.reduce((sum, m) => sum + (m.hpKwh || 0), 0) * 100) / 100;
  const totalHc = Math.round(allMonths.reduce((sum, m) => sum + (m.hcKwh || 0), 0) * 100) / 100;
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
    totalHp: totalHp,
    totalHc: totalHc,
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

// ═══════════════════════════════════════════════════════════════════════════
// Données SGE Enedis — Récupération des données techniques du compteur
// ═══════════════════════════════════════════════════════════════════════════

const SGE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes de validité pour les données SGE (stables)
const SGE_API_BASE = "https://mfa.microapps.enedis.fr/prm/api/v1";

/**
 * Récupère les données techniques SGE (alimentation + comptage) pour un PRM donné.
 * Stratégie SAFE : détecte un onglet sge.enedis.fr DÉJÀ OUVERT par l'utilisatrice
 * et y injecte les appels fetch first-party (cookies SameSite envoyés naturellement).
 * N'ouvre JAMAIS de nouvel onglet SGE — zéro risque de corruption de session TrustBuilder.
 * @param {Object} payload - { prm: string, bypassCache?: boolean }
 * @returns {Promise<Object>} Données SGE formatées
 */
async function handleFetchSgeData(payload) {
  const { prm, bypassCache } = payload || {};

  if (!prm || String(prm).length !== 14) {
    throw new Error("Numéro PRM invalide (14 chiffres attendus)");
  }

  const prmStr = String(prm);

  // 1. Vérifier le cache local SGE (30 min de validité)
  if (!bypassCache) {
    try {
      const cacheKey = `sge_cache_v2_${prmStr}`;
      const stored = await chrome.storage.local.get([cacheKey]);
      const item = stored[cacheKey];
      if (item && item.data && item.data.affaires !== undefined && (Date.now() - (item.cachedAt || 0)) < SGE_CACHE_TTL_MS) {
        console.log(`[Background] ⚡ SGE depuis cache pour PRM ${prmStr}`);
        return item.data;
      }
    } catch (_) {}
  }

  // 2. Chercher un onglet SGE déjà ouvert par l'utilisatrice (dans toutes les fenêtres)
  let sgeTab = null;
  try {
    const allTabs = await chrome.tabs.query({});
    // Privilégier l'onglet SGE qui consulte déjà ce PRM, sinon n'importe quel onglet SGE actif/ouvert
    sgeTab = allTabs.find(t => t.url && t.url.includes("sge.enedis.fr") && t.url.includes(prmStr))
          || allTabs.find(t => t.url && t.url.includes("sge.enedis.fr"));
  } catch (err) {
    console.warn("[Background] Erreur recherche onglet SGE :", err.message);
  }

  if (!sgeTab) {
    const err = new Error(
      `Aucun onglet SGE Enedis ouvert. Ouvrez d'abord la fiche SGE du PRM ${prmStr} depuis Kraken (bouton 🔗), puis relancez la récupération.`
    );
    err.noSgeTab = true;
    throw err;
  }

  console.log(`[Background] 📡 Utilisation de l'onglet SGE existant (id=${sgeTab.id}, url=${sgeTab.url}) pour PRM ${prmStr}`);

  // Si l'onglet est encore en train de charger, attendre qu'il soit prêt
  if (sgeTab.status !== "complete") {
    await waitForTabComplete(sgeTab.id, 6000);
  }

  // 3. Injecter un script dans le contexte first-party SGE (world: "MAIN")
  const RESULT_ELEMENT_ID = `__ext_sge_result_${Date.now()}__`;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: sgeTab.id },
      world: "MAIN",
      func: (prmId, apiBase, resultId) => {
        const fetchUrl = async (url) => {
          const res = await fetch(url, {
            method: "GET",
            credentials: "include",
            headers: { "Accept": "application/json" }
          });
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          return res.json();
        };

        const fetchPost = async (url, body) => {
          const res = await fetch(url, {
            method: "POST",
            credentials: "include",
            headers: { 
              // Même version d'API que le portail SGE (la v1 renvoie un périmètre différent)
              "Accept": "application/vnd.enedis.r2da.api.v2+json",
              "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
          });
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          return res.json();
        };

        const fetchPrm = (endpoint) => fetchUrl(`${apiBase}/${endpoint}/${prmId}`);

        Promise.all([
          fetchPrm("situation-alimentation").catch(e => ({ error: e.message })),
          fetchPrm("situation-comptage").catch(e => ({ error: e.message })),
          fetchPrm("situations-contractuelles").catch(e => ({ error: e.message })),
          (async () => {
            const PAGE_SIZE = 20;
            const MAX_PAGES = 5;
            const all = [];
            let totalAnnonce = 0;
            let pageFailed = false;
            const diagPages = [];
            const seen = new Set();
            for (let page = 0; page < MAX_PAGES; page++) {
              let data = null;
              let lastErr = "";
              // Jusqu'à 3 tentatives par page (erreurs Enedis intermittentes)
              for (let attempt = 0; attempt < 3 && !data; attempt++) {
                try {
                  data = await fetchPost(`https://mfa.microapps.enedis.fr/r2da/api/dossiers/_recherche?page=${page}&sort=desc&limit=${PAGE_SIZE}`, { idPrm: [prmId], text: prmId });
                } catch (e) {
                  lastErr = e && e.message ? e.message : String(e);
                  await new Promise(r => setTimeout(r, 300));
                }
              }
              if (!data) pageFailed = true;
              diagPages.push({ page, count: data && Array.isArray(data.dossierDTO) ? data.dossierDTO.length : 0, total: data ? data.nombreResultatTotal : null, error: data ? "" : lastErr });
              const list = data && Array.isArray(data.dossierDTO) ? data.dossierDTO : [];
              if (data && Number.isFinite(data.nombreResultatTotal)) totalAnnonce = data.nombreResultatTotal;
              for (const d of list) {
                const key = String(d.idAffaire) + "|" + String(d.applicationSource || "");
                if (!seen.has(key)) { seen.add(key); all.push(d); }
              }
              if (list.length < PAGE_SIZE) break;
            }
            return { all, incomplete: pageFailed || (totalAnnonce > 0 ? all.length < totalAnnonce : false), total: totalAnnonce, pages: diagPages };
          })().catch(() => ({ all: [], incomplete: true }))
        ]).then(async ([alimentation, comptage, contractuel, searchRes]) => {
          let affairesList = [];
          
          let dossiers = searchRes.all;

          if (dossiers.length > 0) {
            const affairesWithDetails = await Promise.all(
              dossiers.map(async (dossier) => {
                const statutStr = String(typeof dossier.statut === "string" ? dossier.statut : (dossier.statut?.code || "")).toUpperCase();
                const isEnCours = statutStr === "COURS";
                let detail = null;
                // Récupérer le détail pour les affaires en cours, et jusqu'à 20 affaires closes
                if (isEnCours || dossiers.indexOf(dossier) < 20) {
                  try {
                    const app = (dossier.applicationSource ? String(dossier.applicationSource).toLowerCase() : "adc5");
                    detail = await fetchUrl(`https://mfa.microapps.enedis.fr/${app}/api/affaires/${dossier.idAffaire}`);
                  } catch (err) {
                    console.warn(`[SGE Script] Erreur détail affaire ${dossier.idAffaire}:`, err);
                  }
                }
                return {
                  ...dossier,
                  detail
                };
              })
            );
            affairesList = affairesWithDetails;
          }

          const result = {
            alimentation,
            comptage,
            contractuel,
            affaires: affairesList,
            affairesIncomplete: !!searchRes.incomplete,
            affairesDiag: { total: searchRes.total || 0, received: searchRes.all.length, pages: searchRes.pages || [] },
            done: true
          };

          let el = document.getElementById(resultId);
          if (!el) {
            el = document.createElement("div");
            el.id = resultId;
            el.style.display = "none";
            document.documentElement.appendChild(el);
          }
          el.textContent = JSON.stringify(result);
        }).catch(err => {
          let el = document.getElementById(resultId);
          if (!el) {
            el = document.createElement("div");
            el.id = resultId;
            el.style.display = "none";
            document.documentElement.appendChild(el);
          }
          el.textContent = JSON.stringify({ error: err.message || String(err), done: true });
        });
      },
      args: [prmStr, SGE_API_BASE, RESULT_ELEMENT_ID]
    });
  } catch (scriptErr) {
    throw new Error(`Injection dans l'onglet SGE échouée : ${scriptErr.message}`);
  }

  // 4. Attendre le résultat dans le DOM de l'onglet SGE (polling max 10s)
  let rawResult = null;
  const maxWaitMs = 20000;
  const pollIntervalMs = 250;
  const startPoll = Date.now();

  while (Date.now() - startPoll < maxWaitMs) {
    try {
      const [readRes] = await chrome.scripting.executeScript({
        target: { tabId: sgeTab.id },
        func: (resultId) => {
          const el = document.getElementById(resultId);
          if (!el || !el.textContent) return null;
          try { return JSON.parse(el.textContent); } catch (_) { return null; }
        },
        args: [RESULT_ELEMENT_ID]
      });
      if (readRes?.result?.done) {
        rawResult = readRes.result;
        break;
      }
    } catch (_) {
      break;
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  // Nettoyage de l'élément temporaire dans le DOM (best effort)
  try {
    await chrome.scripting.executeScript({
      target: { tabId: sgeTab.id },
      func: (resultId) => { const el = document.getElementById(resultId); if (el) el.remove(); },
      args: [RESULT_ELEMENT_ID]
    });
  } catch (_) {}

  if (!rawResult) {
    throw new Error("Délai dépassé : l'onglet SGE n'a pas répondu. Vérifiez que vous êtes bien connecté à SGE.");
  }

  if (rawResult.error) {
    throw new Error(`Erreur SGE : ${rawResult.error}`);
  }

  // Si les 3 endpoints ont échoué avec une erreur HTTP (ex: 401, 403)
  const errors = [];
  if (rawResult.alimentation?.error) errors.push(`Alimentation: ${rawResult.alimentation.error}`);
  if (rawResult.comptage?.error) errors.push(`Comptage: ${rawResult.comptage.error}`);
  if (rawResult.contractuel?.error) errors.push(`Contractuel: ${rawResult.contractuel.error}`);

  const hasAffaires = Array.isArray(rawResult.affaires) && rawResult.affaires.length > 0;
  if (errors.length === 3 && !hasAffaires) {
    throw new Error(`Accès aux données SGE refusé (${errors[0]}). Vérifiez votre session SGE sur l'onglet.`);
  }

  // 5. Formater et mettre en cache
  const formatted = formatSgeData(
    rawResult.alimentation,
    rawResult.comptage,
    rawResult.contractuel,
    prmStr,
    rawResult.affaires
  );

  formatted.affairesDiag = rawResult.affairesDiag || null;

  if (formatted.hasData && !rawResult.affairesIncomplete) {
    try {
      const cacheKey = `sge_cache_v2_${prmStr}`;
      await chrome.storage.local.set({
        [cacheKey]: {
          prm: prmStr,
          data: formatted,
          cachedAt: Date.now()
        }
      });
      console.log(`[Background] ✅ Données SGE mises en cache pour PRM ${prmStr}`);
    } catch (_) {}
  }

  return formatted;
}

/**
 * Attend qu'un onglet soit complètement chargé (status="complete")
 * @param {number} tabId
 * @param {number} timeoutMs
 */
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };

    const onUpdated = (tId, changeInfo) => {
      if (tId === tabId && changeInfo.status === "complete") {
        done();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);

    // Vérifier si déjà complete
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === "complete") done();
    }).catch(() => done());

    // Timeout de sécurité
    setTimeout(done, timeoutMs);
  });
}

/**
 * Formate une date ISO ou standard en date française JJ/MM/AAAA
 */
function formatSgeFrenchDate(dateStr) {
  if (!dateStr) return "-";
  try {
    const cleaned = String(dateStr).replace(" ", "T");
    const d = new Date(cleaned);
    if (isNaN(d.getTime())) return String(dateStr);
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
  } catch (_) {
    return String(dateStr);
  }
}

/**
 * Formate une plage horaire pour un rendez-vous SGE
 */
function formatSgeTimeRange(startStr, endStr, slotLabel) {
  let timeStr = "";
  if (startStr && endStr) {
    const sMatch = String(startStr).match(/(\d{2}:\d{2})/);
    const eMatch = String(endStr).match(/(\d{2}:\d{2})/);
    if (sMatch && eMatch) {
      timeStr = `${sMatch[1]} – ${eMatch[1]}`;
    }
  }
  if (slotLabel && timeStr) {
    return `${slotLabel} (${timeStr})`;
  }
  return slotLabel || timeStr || "-";
}

/**
 * Formate les données brutes des APIs SGE en un objet structuré pour le popup
 */
function formatSgeData(alimentation, comptage, contractuel, prm, affairesRawList) {
  const result = {
    prm: prm,
    hasData: false,
    // Alimentation
    etatAlimentation: null,
    etatAlimentationCode: null,
    domaineTension: null,
    tensionLivraison: null,
    puissanceRaccordement: null,
    puissanceRaccordementUnite: null,
    puissanceRaccordementFormate: null,
    // Comptage
    typeCompteur: null,
    teleoperable: null,
    eligiblePeriodeMobile: null,
    periodiciteReleve: null,
    // Compteur
    numeroSerie: null,
    nbFils: null,
    nbFilsLabel: null,
    tensionCompteur: null,
    intensiteNominale: null,
    // Disjoncteur
    calibreDisjoncteur: null,
    intensiteReglage: null,
    intensiteReglageFormate: null,
    disjAccessible: null,
    // Heures Creuses
    plagesHc: null,
    plagesHcFormatees: null,
    // Situations contractuelles
    puissanceSouscrite: null,
    puissanceSouscriteFormate: null,
    puissanceCoupure: null,
    puissanceCoupureFormate: null,
    calendrierFournisseur: null,
    calendrierFournisseurCode: null,
    formuleTarifaire: null,
    formuleTarifaireCode: null,
    // Affaires SGE Enedis
    affaires: [],
    nbAffairesEnCours: 0,
    hasAffairesEnCours: false
  };

  // Traitement de la situation d'alimentation
  if (alimentation && !alimentation.error) {
    result.hasData = true;

    if (alimentation.etatAlimentation) {
      result.etatAlimentation = alimentation.etatAlimentation.libelle || alimentation.etatAlimentation.code || "-";
      result.etatAlimentationCode = alimentation.etatAlimentation.code || null;
    }

    if (alimentation.alimentationPrincipale) {
      const ap = alimentation.alimentationPrincipale;

      if (ap.domaineTension) {
        result.domaineTension = ap.domaineTension.libelle || ap.domaineTension.code || "-";
      }

      result.tensionLivraison = ap.tensionLivraison || "-";

      if (ap.puissanceRaccordementSoutirage) {
        const p = ap.puissanceRaccordementSoutirage;
        result.puissanceRaccordement = p.valeur;
        result.puissanceRaccordementUnite = p.unite || "kVA";
        result.puissanceRaccordementFormate = `${p.valeur} ${p.unite || "kVA"}`;
      }
    }
  }

  // Traitement de la situation de comptage
  if (comptage && !comptage.error) {
    result.hasData = true;

    if (comptage.dispositifComptage) {
      const dc = comptage.dispositifComptage;
      if (dc.typeComptage) {
        result.typeCompteur = dc.typeComptage.libelle || dc.typeComptage.code || "-";
      }
      result.teleoperable = dc.teleoperable;
      result.eligiblePeriodeMobile = dc.eligiblePeriodeMobile;
    }

    if (comptage.caracteristiquesReleve && comptage.caracteristiquesReleve.periodicite) {
      result.periodiciteReleve = comptage.caracteristiquesReleve.periodicite.libelle ||
                                  comptage.caracteristiquesReleve.periodicite.code || "-";
    }

    // Premier compteur (principal)
    if (comptage.compteurs && comptage.compteurs.length > 0) {
      const compteur = comptage.compteurs[0];
      result.numeroSerie = compteur.numeroSerie || "-";
      result.nbFils = compteur.nbFils;
      // 2 fils = monophasé, 4 fils = triphasé
      result.nbFilsLabel = compteur.nbFils === 2 ? "Monophasé (2 fils)"
                         : compteur.nbFils === 4 ? "Triphasé (4 fils)"
                         : compteur.nbFils ? `${compteur.nbFils} fils` : "-";

      if (compteur.tension) {
        result.tensionCompteur = compteur.tension.libelle || compteur.tension.code || "-";
      }

      if (compteur.intensiteNominale) {
        result.intensiteNominale = compteur.intensiteNominale.libelle || compteur.intensiteNominale.code || "-";
      }
    }

    // Extraction TIC
    // Les données TIC sont souvent retournées directement à la racine du compteur sous forme de booléens (API prm/situation-comptage)
    if (comptage.compteurs && comptage.compteurs.length > 0) {
      const compteur = comptage.compteurs[0];
      if (compteur.ticActivee !== undefined) {
        result.ticActivee = compteur.ticActivee ? "Oui" : "Non";
      }
      if (compteur.ticStandard !== undefined) {
        result.ticStandard = compteur.ticStandard ? "Oui" : "Non (Historique)";
      }
      if (compteur.ticActivable !== undefined) {
        result.ticActivable = compteur.ticActivable ? "Oui" : "Non";
      }
    }

    // Recherche récursive robuste pour la TIC (Fallback si jamais c'est un objet imbriqué sur d'autres requêtes)
    if (!result.ticActivee && !result.ticStandard) {
      let ticInfo = null;
      function findTic(obj) {
        if (!obj || typeof obj !== 'object') return null;
        if (obj.teleinformationClient) return obj.teleinformationClient;
        if (obj.teleinformation) return obj.teleinformation;
        if (obj.tic && typeof obj.tic === 'object') return obj.tic;
        for (const key of Object.keys(obj)) {
          const found = findTic(obj[key]);
          if (found) return found;
        }
        return null;
      }
      
      ticInfo = findTic(comptage);

      if (ticInfo) {
        const isActive = ticInfo.active === true || String(ticInfo.active?.code).toUpperCase() === "OUI" || String(ticInfo.active).toUpperCase() === "OUI" || ticInfo.etat?.code === "ACTIF";
        const isActivable = ticInfo.activable === true || String(ticInfo.activable?.code).toUpperCase() === "OUI" || String(ticInfo.activable).toUpperCase() === "OUI";
        const mode = (ticInfo.mode?.code || ticInfo.mode || "").toUpperCase();

        result.ticActivee = isActive ? "Oui" : "Non";
        result.ticStandard = mode.includes("STANDARD") ? "Oui" : (mode.includes("HISTO") ? "Non (Historique)" : "Non");
        result.ticActivable = isActivable ? "Oui" : "Non";
      }
    }

    // Disjoncteur
    if (comptage.disjoncteur) {
      const disj = comptage.disjoncteur;
      result.disjAccessible = disj.accessibilite;

      if (disj.calibre) {
        result.calibreDisjoncteur = disj.calibre.libelle || disj.calibre.code || "-";
      }

      if (disj.intensiteReglage) {
        result.intensiteReglage = disj.intensiteReglage.valeur;
        result.intensiteReglageFormate = `${disj.intensiteReglage.valeur} ${disj.intensiteReglage.unite || "A"}`;
      }
    }

    // Heures Creuses (relais)
    if (comptage.relais && comptage.relais.plageHeuresCreuses) {
      result.plagesHc = comptage.relais.plageHeuresCreuses;
      // Nettoyage du format "HC (1H32-7H02;14H32-17H02)" → "1h32 – 7h02 · 14h32 – 17h02"
      let raw = comptage.relais.plageHeuresCreuses;
      // Retirer le préfixe "HC (" et le ")" final
      raw = raw.replace(/^HC\s*\(\s*/i, "").replace(/\s*\)\s*$/, "");
      // Séparer les plages et formater
      const plages = raw.split(";").map(p => {
        return p.trim()
          .replace(/(\d{1,2})[hH](\d{2})/g, "$1h$2")
          .replace(/\s*-\s*/g, " – ");
      });
      result.plagesHcFormatees = plages.join(" · ");
    }
  }

  // Traitement des situations contractuelles
  if (contractuel && !contractuel.error) {
    // L'API retourne un tableau : prendre la première entrée (contrat actif le plus récent)
    const entries = Array.isArray(contractuel) ? contractuel : [contractuel];
    const entry = entries[0];

    if (entry && entry.structureTarifaire) {
      result.hasData = true;
      const st = entry.structureTarifaire;

      if (st.puissanceSouscrite) {
        result.puissanceSouscrite = st.puissanceSouscrite.valeur;
        result.puissanceSouscriteFormate = `${st.puissanceSouscrite.valeur} ${st.puissanceSouscrite.unite || "kVA"}`;
      }

      if (st.puissanceCoupure) {
        result.puissanceCoupure = st.puissanceCoupure.valeur;
        result.puissanceCoupureFormate = `${st.puissanceCoupure.valeur} ${st.puissanceCoupure.unite || "kVA"}`;
      }

      if (st.grilleFournisseur && st.grilleFournisseur.calendrier) {
        result.calendrierFournisseur = st.grilleFournisseur.calendrier.libelle || st.grilleFournisseur.calendrier.code || "-";
        result.calendrierFournisseurCode = st.grilleFournisseur.calendrier.code || null;
      }

      if (st.formuleTarifaireAcheminement) {
        result.formuleTarifaire = st.formuleTarifaireAcheminement.libelle || st.formuleTarifaireAcheminement.code || "-";
        result.formuleTarifaireCode = st.formuleTarifaireAcheminement.code || null;
      }
    }
  }

  // Traitement des affaires SGE (rechercheAffaire & détail affaire)
  if (Array.isArray(affairesRawList)) {
    result.affaires = affairesRawList.map(aff => {
      const d = aff.detail || {};
      const appSource = (aff.applicationSource ? String(aff.applicationSource).toLowerCase() : "adc5");
      const idAffaire = aff.idAffaire || d.affaireId || "-";
      const urlSge = `https://sge.enedis.fr/${appSource}/?wc=consultation&id=${idAffaire}`;

      // Statut
      const rawStatut = (typeof aff.statut === "string" ? aff.statut : aff.statut?.code) || d.statut?.code || "";
      const isEnCours = String(rawStatut).toUpperCase() === "COURS" || String(d.statut?.code || "").toUpperCase() === "COURS";
      const statutLibelle = d.statut?.libelle || (isEnCours ? "En cours" : rawStatut || "-");

      // Type de demande & sous-type
      const sousTypeDemande = aff.demande?.sousTypeDemande ||
        aff.demande?.prestation?.libelle ||
        aff.typeDemande?.libelle || aff.typeDemande ||
        aff.libelle ||
        d.demande?.demandeTechnique?.type?.libelle ||
        d.demande?.prestations?.[0]?.fiche?.libelle ||
        d.prestations?.[0]?.fiche?.libelle ||
        d.typeDemandeDiverse?.sousTypeDemande?.libelle ||
        d.demande?.demandeDiverse?.typeDemandeDiverse?.sousTypeDemande?.libelle ||
        "Demande";
      const sousTypeDemandeCode = aff.demande?.sousTypeDemandeCode ||
        aff.demande?.prestation?.code ||
        aff.typeDemande?.code ||
        d.demande?.demandeTechnique?.type?.code ||
        d.demande?.prestations?.[0]?.fiche?.code ||
        d.prestations?.[0]?.fiche?.code ||
        d.typeDemandeDiverse?.sousTypeDemande?.code ||
        d.demande?.demandeDiverse?.typeDemandeDiverse?.sousTypeDemande?.code ||
        "";

      // Prestation principale et Option
      let prestationLibelle = null;
      const prestationsArray = Array.isArray(d.demande?.prestations) ? d.demande.prestations : (Array.isArray(d.prestations) ? d.prestations : []);
      if (prestationsArray.length > 0) {
        const p0 = prestationsArray[0];
        prestationLibelle = p0.fiche?.libelle ? `${p0.fiche.libelle}${p0.fiche.code ? ` (${p0.fiche.code})` : ""}` : null;
        if (prestationLibelle && p0.option?.libelle) {
          prestationLibelle += ` — ${p0.option.libelle}`;
        }
      } else if (d.demande?.prestation?.ficheCode) {
        prestationLibelle = d.demande.prestation.ficheCode;
      } else if (aff.demande?.prestation?.libelle) {
        prestationLibelle = `${aff.demande.prestation.libelle}${aff.demande.prestation.code ? ` (${aff.demande.prestation.code})` : ""}`;
      } else if (aff.prestation?.libelle || aff.prestation) {
        prestationLibelle = aff.prestation.libelle || aff.prestation;
      }

      // Dates
      const dateDemande = d.demande?.dateHeure || d.demande?.dateCreationDemande || d.demande?.dateTechCreation || aff.demande?.dateCreation || aff.dateCreation || aff.dateHeure || aff.date || null;
      const dateDemandeFormatee = formatSgeFrenchDate(dateDemande);
      const dateEffetSouhaitee = d.demande?.dateEffetSouhaitee || aff.dateEffetSouhaitee || null;
      const dateEffetSouhaiteeFormatee = formatSgeFrenchDate(dateEffetSouhaitee);

      // Référence demandeur & Initiateur
      const refDemandeur = d.demande?.referenceDemandeur || null;
      let initiateurNom = null;
      const init = d.demande?.initiateur || d.initiateur || aff.demande?.initiateur;
      if (init) {
        const civilite = init.identite?.civilite || init.personne?.personnePhysique?.civilite || "";
        const prenom = init.identite?.prenom || init.personne?.personnePhysique?.prenom || "";
        const nom = init.identite?.nom || init.personne?.personnePhysique?.nom || "";
        const acteur = init.acteurAppartenance?.libelle || init.codeACM?.libelle || "";
        const nomComplet = [civilite, prenom, nom].filter(Boolean).join(" ").trim();
        initiateurNom = acteur ? `${acteur}${nomComplet ? ` (${nomComplet})` : ""}` : nomComplet;
      }

      // Dernier jalon
      let dernierJalon = null;
      if (Array.isArray(d.jalons) && d.jalons.length > 0) {
        const sortedJalons = [...d.jalons].sort((a, b) => {
          const ta = new Date(a.dateHeure || a.affaireDateEffet || 0).getTime();
          const tb = new Date(b.dateHeure || b.affaireDateEffet || 0).getTime();
          return ta - tb;
        });
        const lastJalon = sortedJalons[sortedJalons.length - 1];
        if (lastJalon) {
          const libelleJalon = lastJalon.affaireEtat?.libelle || lastJalon.affaireEtat?.code || lastJalon.affaireEtatExterne || lastJalon.affaireEtatInterne || "-";
          const codeJalon = lastJalon.affaireEtat?.code || lastJalon.affaireEtatExterne || null;
          dernierJalon = {
            libelle: libelleJalon,
            code: codeJalon,
            date: formatSgeFrenchDate(lastJalon.dateHeure || lastJalon.affaireDateEffet)
          };
        }
      }

      // Commentaire intervention ou demande (chercher dans interventions ou demande)
      let commentaire = d.demande?.commentaireIntervention || 
                        d.demande?.commentaire || 
                        d.demande?.commentaireClient ||
                        d.demande?.observations ||
                        d.demande?.demandeDiverse?.commentaire ||
                        d.demande?.demandeTechnique?.commentaire ||
                        d.demande?.demandeTechnique?.observations ||
                        (Array.isArray(d.demande?.prestations) && d.demande.prestations.length > 0 ? d.demande.prestations[0].commentaire : null) ||
                        null;
                        
      // Relances
      let relancesStr = "";
      if (Array.isArray(d.relances) && d.relances.length > 0) {
        const sortedRelances = [...d.relances].sort((a, b) => new Date(b.dateHeure || 0).getTime() - new Date(a.dateHeure || 0).getTime());
        const formattedRelances = sortedRelances.map(r => {
          const dateR = formatSgeFrenchDate(r.dateHeure);
          const nom = r.initiateur?.prenom ? `${r.initiateur.prenom} ${r.initiateur.nom || ""}`.trim() : (r.initiateur?.nom || "");
          return `[Relance ${dateR}${nom ? ` par ${nom}` : ""}] ${r.commentaire || ""}`;
        });
        relancesStr = formattedRelances.join("\n\n");
      }

      if (!commentaire && Array.isArray(d.interventions)) {
        for (const it of d.interventions) {
          if (Array.isArray(it.demandesInterventions)) {
            for (const di of it.demandesInterventions) {
              if (di.commentaireIntervention && di.commentaireIntervention.trim()) {
                commentaire = di.commentaireIntervention.trim();
                break;
              }
              if (di.commentaire && di.commentaire.trim()) {
                commentaire = di.commentaire.trim();
                break;
              }
            }
          }
          if (commentaire) break;
        }
      }

      if (relancesStr) {
        commentaire = commentaire ? `${commentaire}\n\n---\n\n${relancesStr}` : relancesStr;
      }

      // Opérations prévues
      const operations = [];
      if (Array.isArray(d.interventions)) {
        for (const it of d.interventions) {
          if (Array.isArray(it.operations)) {
            for (const op of it.operations) {
              if (op.libelle && !operations.includes(op.libelle)) {
                operations.push(op.libelle);
              }
            }
          }
        }
      }
      if (operations.length === 0 && Array.isArray(d.recevabilite?.operations)) {
        for (const op of d.recevabilite.operations) {
          if (op.libelle && !operations.includes(op.libelle)) {
            operations.push(op.libelle);
          } else if (op.code && !operations.includes(op.code)) {
            operations.push(op.code);
          }
        }
      }

      // Planification / RDV d'intervention
      let rdvInfo = null;
      if (Array.isArray(d.interventions)) {
        for (let i = d.interventions.length - 1; i >= 0; i--) {
          const it = d.interventions[i];
          if (Array.isArray(it.planifications) && it.planifications.length > 0) {
            const sortedPlanifs = [...it.planifications].sort((a, b) => {
              const ta = new Date(a.dateCreation || a.datePrevue || 0).getTime();
              const tb = new Date(b.dateCreation || b.datePrevue || 0).getTime();
              return ta - tb;
            });
            const lastPlanif = sortedPlanifs[sortedPlanifs.length - 1];
            if (lastPlanif) {
              const creneau = lastPlanif.surSite?.creneauHorairePrevu?.libelle ||
                              lastPlanif.creneauHorairePrevu || null;
              const debut = lastPlanif.heureDebutPrevue || lastPlanif.surSite?.heureDebutPrevue || null;
              const fin = lastPlanif.heureFinPrevue || lastPlanif.surSite?.heureFinPrevue || null;
              const dateP = lastPlanif.heureDebutPrevue || lastPlanif.datePrevue || null;

              rdvInfo = {
                datePrevue: formatSgeFrenchDate(dateP),
                creneauHoraire: formatSgeTimeRange(debut, fin, creneau),
                modeRealisation: lastPlanif.modeRealisation?.libelle || lastPlanif.modeRealisation?.code || "Sur site",
                standardRealisation: lastPlanif.standardRealisation?.libelle || null
              };
              break;
            }
          }
        }
      }

      // Présence client obligatoire
      let presenceClient = null;
      if (d.recevabilite?.presenceClientObligatoire !== undefined && d.recevabilite.presenceClientObligatoire !== null) {
        presenceClient = d.recevabilite.presenceClientObligatoire ? "Oui (Obligatoire)" : "Non (Pas nécessaire)";
      }

      // Bilan / Etat de réalisation
      let etatRealisation = null;
      if (prestationsArray.length > 0 && prestationsArray[0].bilan?.etatRealisation?.libelle) {
        etatRealisation = prestationsArray[0].bilan.etatRealisation.libelle;
      } else if (prestationsArray.length > 0 && prestationsArray[0].etat?.libelle) {
        etatRealisation = prestationsArray[0].etat.libelle;
      } else if (d.demande?.bilan?.etatRealisation?.libelle) {
        etatRealisation = d.demande.bilan.etatRealisation.libelle;
      } else if (d.demande?.demandeDiverse?.bilan?.etatRealisation?.libelle) {
        etatRealisation = d.demande.demandeDiverse.bilan.etatRealisation.libelle;
      } else if (d.demande?.demandeDiverse?.etat?.libelle) {
        etatRealisation = d.demande.demandeDiverse.etat.libelle;
      } else if (d.demande?.etat?.libelle) {
        etatRealisation = d.demande.etat.libelle;
      }
      
      if (!etatRealisation && Array.isArray(d.interventions)) {
        for (let i = d.interventions.length - 1; i >= 0; i--) {
          const it = d.interventions[i];
          if (it.bilan?.etatRealisation?.libelle) {
            etatRealisation = it.bilan.etatRealisation.libelle;
            break;
          } else if (it.etatIntervention?.libelle) {
            etatRealisation = it.etatIntervention.libelle;
            break;
          } else if (it.etat?.libelle) {
            etatRealisation = it.etat.libelle;
            break;
          }
        }
      }

      // Analyse des requêtes critiques (F200 / Résiliation à l'initiative du fournisseur)
      const typeDesc = [sousTypeDemande, sousTypeDemandeCode, prestationLibelle].join(" ").toUpperCase();
      const isF200 = typeDesc.includes("F200");
      const isResiliation = typeDesc.includes("RÉSILIATION") || typeDesc.includes("RESILIATION");
      let isFournisseurInitiated = false;
      if (init) {
        const acteurStr = (init.acteurAppartenance?.libelle || init.acteurAppartenance?.code || init.codeACM?.libelle || init.codeACM?.code || "").toUpperCase();
        const roleStr = (init.typeActeur?.libelle || init.typeActeur?.code || init.role?.libelle || init.role?.code || "").toUpperCase();
        if (acteurStr.includes("FOURNISSEUR") || roleStr.includes("FOURNISSEUR") || acteurStr === "F" || roleStr === "F") {
          isFournisseurInitiated = true;
        } else if (initiateurNom && initiateurNom.toUpperCase().includes("FOURNISSEUR")) {
          isFournisseurInitiated = true;
        } else if (!acteurStr && !roleStr && initiateurNom && ["OCTOPUS", "PLUM", "PLÜM", "EDF", "ENGIE", "TOTAL", "ENI", "EKWATEUR"].some(f => initiateurNom.toUpperCase().includes(f))) {
          // Fallback on common supplier names if role isn't explicitly 'Fournisseur'
          isFournisseurInitiated = true;
        }
      }

      return {
        idAffaire,
        urlSge,
        isEnCours,
        statutCode: rawStatut,
        statutLibelle,
        etatRealisation,
        sousTypeDemande,
        sousTypeDemandeCode,
        prestationLibelle,
        isF200,
        isResiliation,
        isFournisseurInitiated,
        dateDemande: dateDemandeFormatee,
        dateEffetSouhaitee: dateEffetSouhaiteeFormatee,
        refDemandeur,
        initiateur: initiateurNom,
        dernierJalon,
        commentaire,
        operations: operations.join(", "),
        rdvInfo,
        presenceClient,
        segment: aff.segment || d.donneesPoint?.segmentClientele || null,
        applicationSource: aff.applicationSource || "ADC5"
      };
    });

    result.nbAffairesEnCours = result.affaires.filter(a => a.isEnCours).length;
    result.hasAffairesEnCours = result.nbAffairesEnCours > 0;
    if (result.affaires.length > 0) {
      result.hasData = true;
    }
  }

  return result;
}

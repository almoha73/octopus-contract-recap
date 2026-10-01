/**
 * Logique du Popup - Extension Récapitulatif Contrat
 * Conforme Manifest V3 et politique de sécurité d'entreprise (zéro innerHTML non sanitisé).
 */

// Requête GraphQL - définie au niveau module pour être transmissible via executeScript args
const GRAPHQL_AGREEMENTS_QUERY = `
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
          product { code displayName }
          supplyPoint {
            marketName
            id
            externalIdentifier
            meterPoint {
              id
              isSmartMeter
              ... on ElectricityMeterPoint {
                subscribedMaxPower
                providerCalendar { name temporalClasses { label description } }
              }
              address { fullAddress }
            }
          }
          energySupplyRate {
            standingRate { pricePerUnit pricePerUnitWithTaxes }
            rates(first: 10) {
              edges {
                node {
                  __typename
                  pricePerUnit
                  pricePerUnitWithTaxes
                  ... on ElectricitySupplyConsumptionRateType { temporalClass { label } }
                  ... on ElectricityConsumptionRateType { temporalClass { label } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const CACHE_VERSION = 8; // Synchronisé avec background.js pour l'invalidation automatique du cache local

document.addEventListener("DOMContentLoaded", () => {
  // Éléments du DOM
  const accountBadge = document.getElementById("accountBadge");
  const refreshBtn = document.getElementById("refreshBtn");
  const detachBtn = document.getElementById("detachBtn");
  const fullscreenBtn = document.getElementById("fullscreenBtn");
  const contractSelectorContainer = document.getElementById("contractSelectorContainer");
  const contractSelect = document.getElementById("contractSelect");

  const loadingState = document.getElementById("loadingState");
  const errorState = document.getElementById("errorState");
  const errorMessage = document.getElementById("errorMessage");
  const contentState = document.getElementById("contentState");

  const badgeStatut = document.getElementById("badgeStatut");
  const labelEnergie = document.getElementById("labelEnergie");
  const nomOffre = document.getElementById("nomOffre");
  const codeOffre = document.getElementById("codeOffre");
  const prixKwh = document.getElementById("prixKwh");
  const prixAbonnement = document.getElementById("prixAbonnement");

  const valeurPrm = document.getElementById("valeurPrm");
  const copyPrmBtn = document.getElementById("copyPrmBtn");
  const valeurPuissance = document.getElementById("valeurPuissance");
  const valeurOption = document.getElementById("valeurOption");
  const rowHorairesHc = document.getElementById("rowHorairesHc");
  const valeurHorairesHc = document.getElementById("valeurHorairesHc");
  const copyHorairesHcBtn = document.getElementById("copyHorairesHcBtn");
  const valeurLinky = document.getElementById("valeurLinky");
  const valeurFacturation = document.getElementById("valeurFacturation");
  const valeurDebut = document.getElementById("valeurDebut");
  const rowFinContrat = document.getElementById("rowFinContrat");
  const valeurFin = document.getElementById("valeurFin");
  const valeurAdresse = document.getElementById("valeurAdresse");

  // Éléments du Suivi Conso Mensuel
  const consoCard = document.getElementById("consoCard");
  const consoMoisEnCoursBox = document.getElementById("consoMoisEnCoursBox");
  const consoMoisEnCoursLabel = document.getElementById("consoMoisEnCoursLabel");
  const consoMoisEnCoursKwh = document.getElementById("consoMoisEnCoursKwh");
  const consoMoisEnCoursCost = document.getElementById("consoMoisEnCoursCost");
  const consoMoisEnCoursBreakdown = document.getElementById("consoMoisEnCoursBreakdown");
  const consoDerniereReleve = document.getElementById("consoDerniereReleve");
  const consoMoisPrecedentsSection = document.getElementById("consoMoisPrecedentsSection");
  const consoMonthsList = document.getElementById("consoMonthsList");
  const consoTotalBox = document.getElementById("consoTotalBox");
  const consoTotalTitle = document.getElementById("consoTotalTitle");
  const consoTotalBadge = document.getElementById("consoTotalBadge");
  const consoTotalKwh = document.getElementById("consoTotalKwh");
  const consoTotalCost = document.getElementById("consoTotalCost");
  const consoAvgKwh = document.getElementById("consoAvgKwh");
  const consoAvgCost = document.getElementById("consoAvgCost");
  const consoEmptyMessage = document.getElementById("consoEmptyMessage");
  const badgeConsoStatus = document.getElementById("badgeConsoStatus");

  // Éléments du bloc Échéancier de paiement
  const echeancierCard = document.getElementById("echeancierCard");
  const badgeEcheancierStatus = document.getElementById("badgeEcheancierStatus");
  const echeancierMontant = document.getElementById("echeancierMontant");
  const echeancierQuand = document.getElementById("echeancierQuand");
  const echeancierDepuis = document.getElementById("echeancierDepuis");
  const echeancierHistoriqueBox = document.getElementById("echeancierHistoriqueBox");
  const echeancierHistoriqueToggle = document.getElementById("echeancierHistoriqueToggle");
  const echeancierHistoriqueContent = document.getElementById("echeancierHistoriqueContent");
  const echeancierHistoriqueBody = document.getElementById("echeancierHistoriqueBody");

  // Éléments du calculateur de mensualités
  const echeancierCalcBox = document.getElementById("echeancierCalcBox");
  const echeancierCalcToggle = document.getElementById("echeancierCalcToggle");
  const echeancierCalcContent = document.getElementById("echeancierCalcContent");
  const calcDateDebut = document.getElementById("calcDateDebut");
  const calcDateFin = document.getElementById("calcDateFin");
  const calcPresetAll = document.getElementById("calcPresetAll");
  const calcPreset1Year = document.getElementById("calcPreset1Year");
  const calcPresetYtd = document.getElementById("calcPresetYtd");
  const calcTotalAmount = document.getElementById("calcTotalAmount");
  const calcTotalCount = document.getElementById("calcTotalCount");
  const calcBreakdownList = document.getElementById("calcBreakdownList");
  const copyCalcResultBtn = document.getElementById("copyCalcResultBtn");

  let currentActiveSchedules = [];
  let lastCalcResult = null;

  // Éléments du bloc SGE Enedis
  const sgeCard = document.getElementById("sgeCard");
  const badgeSgeStatus = document.getElementById("badgeSgeStatus");
  const sgeAlimBox = document.getElementById("sgeAlimBox");
  const sgeEtatAlim = document.getElementById("sgeEtatAlim");
  const sgePuissanceRaccordement = document.getElementById("sgePuissanceRaccordement");
  const sgeTensionLivraison = document.getElementById("sgeTensionLivraison");
  const sgeDomaineTension = document.getElementById("sgeDomaineTension");
  const sgeComptageBox = document.getElementById("sgeComptageBox");
  const sgeCalibre = document.getElementById("sgeCalibre");
  const sgeIntensiteReglage = document.getElementById("sgeIntensiteReglage");
  const sgeDisjAccessible = document.getElementById("sgeDisjAccessible");
  const sgeTypeCompteur = document.getElementById("sgeTypeCompteur");
  const sgeTeleoperable = document.getElementById("sgeTeleoperable");
  const sgeNumeroSerie = document.getElementById("sgeNumeroSerie");
  const sgeNbFils = document.getElementById("sgeNbFils");
  const sgeTensionCompteur = document.getElementById("sgeTensionCompteur");
  const sgeIntensiteNominale = document.getElementById("sgeIntensiteNominale");
  const sgePeriodicite = document.getElementById("sgePeriodicite");
  const sgeHcRow = document.getElementById("sgeHcRow");
  const sgePlagesHc = document.getElementById("sgePlagesHc");
  const sgeContractuelBox = document.getElementById("sgeContractuelBox");
  const sgePuissanceSouscrite = document.getElementById("sgePuissanceSouscrite");
  const sgePuissanceCoupure = document.getElementById("sgePuissanceCoupure");
  const sgeCalendrier = document.getElementById("sgeCalendrier");
  const sgeFormuleTarifaire = document.getElementById("sgeFormuleTarifaire");
  const sgeEmptyMessage = document.getElementById("sgeEmptyMessage");
  const syncSgeBtn = document.getElementById("syncSgeBtn");

  // État SGE courant pour le récapitulatif
  let currentSgeData = null;

  const copySummaryBtn = document.getElementById("copySummaryBtn");
  const copyFeedback = document.getElementById("copyFeedback");
  const syncSessionBtn = document.getElementById("syncSessionBtn");

  // Rend le prix du kWh de façon lisible : une ligne propre par tarif (HC / HP / autres)
  function renderPrixKwh(container, valeur) {
    if (!container) return;
    container.textContent = "";
    container.classList.remove("price-value-multi");

    const tarifs = String(valeur || "-")
      .split("|")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (tarifs.length <= 1) {
      container.textContent = valeur || "-";
      return;
    }

    container.classList.add("price-value-multi");
    for (const tarif of tarifs) {
      const line = document.createElement("span");
      line.className = "price-line";

      const separatorIndex = tarif.indexOf(":");
      if (separatorIndex > -1) {
        const label = document.createElement("span");
        label.className = "price-line-label";
        label.textContent = tarif.slice(0, separatorIndex).trim();

        const value = document.createElement("span");
        value.className = "price-line-value";
        value.textContent = tarif.slice(separatorIndex + 1).trim();

        line.append(label, value);
      } else {
        line.classList.add("price-line-value");
        line.textContent = tarif;
      }

      container.appendChild(line);
    }
  }

  // Normalise les plages Heures Creuses brutes en une liste de plages homogènes ("0h58 – 5h58")
  function parseHcSchedule(valeur) {
    const raw = String(valeur || "").trim();
    if (!raw) return [];
    return raw
      .replace(/(\d{1,2})\s*[hH]\s*(\d{2})/g, "$1h$2")
      .split(/\s*[;,/]\s*/)
      .map((part) => part.replace(/\s*[-–]\s*/g, " – ").trim())
      .filter((part) => part.length > 0);
  }

  // Rend les plages Heures Creuses de façon lisible : tout sur une seule ligne
  function renderHcSchedule(container, valeur) {
    if (!container) return;
    container.textContent = "";
    container.classList.remove("hc-value-inline");

    const plages = parseHcSchedule(valeur);
    if (plages.length === 0) {
      container.textContent = "-";
      return;
    }

    container.classList.add("hc-value-inline");
    plages.forEach((plage, index) => {
      if (index > 0) {
        const separator = document.createElement("span");
        separator.className = "hc-separator";
        separator.textContent = " · ";
        container.appendChild(separator);
      }
      const line = document.createElement("span");
      line.className = "hc-line";
      line.textContent = plage;
      container.appendChild(line);
    });
  }

  // Détection du mode d'affichage (fenêtre autonome flottante ou plein écran)
  const urlParams = new URLSearchParams(window.location.search);
  const currentMode = urlParams.get("mode"); // "window" | "fullscreen" | null
  const initialAccount = urlParams.get("account");
  const initialTabId = urlParams.get("tabId") ? parseInt(urlParams.get("tabId"), 10) : null;

  if (currentMode === "window") {
    document.body.classList.add("mode-window");
    document.title = "🐙 Octopus Contract Recap - Fenêtre Compagnon";
  } else if (currentMode === "fullscreen") {
    document.body.classList.add("mode-fullscreen");
    document.title = "🐙 Octopus & Kraken - Dashboard Contrat";
  }

  let currentAccountNumber = null;
  let contractsList = [];
  let currentContract = null;
  let activeTabContext = { agreementIds: [], agreementId: null };
  let cachedPaymentData = null;

  // Initialisation au chargement du popup (restitution instantanée depuis le cache si disponible)
  loadData(false);

  // Événement d'actualisation (force la synchronisation en direct en contournant le cache)
  refreshBtn.addEventListener("click", () => {
    loadData(true);
  });

  // Événement d'ouverture en Fenêtre Compagnon Autonome (Option 1)
  if (detachBtn) {
    detachBtn.addEventListener("click", async () => {
      try {
        let activeTab = null;
        try {
          const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
          activeTab = t;
        } catch (_) {}

        if (!activeTab || !activeTab.id) {
          try {
            const tabs = await chrome.tabs.query({ active: true });
            activeTab = tabs.find(t => t.url && (t.url.includes("support.oefr-kraken.energy") || t.url.includes("octopusenergy.fr"))) || tabs[0];
          } catch (_) {}
        }

        const badgeMatch = accountBadge?.textContent?.match(/A-[A-Z0-9]+/i);
        const resolvedAcc = currentAccountNumber || (badgeMatch ? badgeMatch[0] : null) || initialAccount || "";

        const tabIdParam = activeTab?.id ? `&tabId=${activeTab.id}` : "";
        const accParam = resolvedAcc ? `&account=${resolvedAcc}` : "";
        const targetUrl = chrome.runtime.getURL(`popup.html?mode=window${tabIdParam}${accParam}`);

        const winWidth = 520;
        const winHeight = 850;
        const availW = (window.screen && window.screen.availWidth) ? Math.floor(window.screen.availWidth) : 1440;
        const leftPos = Math.max(0, Math.floor(availW - winWidth - 30));
        const topPos = 50;

        let opened = false;

        // 1. Tentative via le Service Worker d'arrière-plan (indépendant du cycle de vie du popup)
        try {
          const bgResp = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
              {
                type: "OPEN_COMPANION_WINDOW",
                payload: {
                  url: targetUrl,
                  width: winWidth,
                  height: winHeight,
                  left: leftPos,
                  top: topPos
                }
              },
              (res) => {
                if (chrome.runtime.lastError) {
                  resolve({ success: false, error: chrome.runtime.lastError.message });
                } else {
                  resolve(res || { success: false });
                }
              }
            );
          });
          if (bgResp?.success) {
            opened = true;
          }
        } catch (bgErr) {
          console.warn("[Popup] Erreur lors de la demande d'ouverture au service worker :", bgErr);
        }

        // 2. Tentative directe avec chrome.windows.create si le service worker n'a pas répondu
        if (!opened && chrome?.windows?.create) {
          try {
            await chrome.windows.create({
              url: targetUrl,
              type: "popup",
              width: winWidth,
              height: winHeight,
              left: leftPos,
              top: topPos,
              focused: true
            });
            opened = true;
          } catch (winErr) {
            console.warn("[Popup] chrome.windows.create type:popup échoué, essai type:normal :", winErr.message);
            try {
              await chrome.windows.create({
                url: targetUrl,
                type: "normal",
                width: winWidth,
                height: winHeight,
                left: leftPos,
                top: topPos,
                focused: true
              });
              opened = true;
            } catch (_) {}
          }
        }

        // 3. Repli universel standard navigateur (window.open)
        if (!opened) {
          try {
            const winFeatures = `width=${winWidth},height=${winHeight},left=${leftPos},top=${topPos},resizable=yes,scrollbars=yes`;
            const popupWin = window.open(targetUrl, "OctopusCompanionWindow", winFeatures);
            if (popupWin) {
              opened = true;
            }
          } catch (_) {}
        }

        if (opened && currentMode !== "window") {
          window.close();
        }
      } catch (err) {
        console.error("[Popup] Erreur lors du détachement en fenêtre autonome :", err);
      }
    });
  }

  // Événement d'ouverture en Plein Écran / Dashboard (Option 4)
  if (fullscreenBtn) {
    fullscreenBtn.addEventListener("click", async () => {
      try {
        let activeTab = null;
        try {
          const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
          activeTab = t;
        } catch (_) {}

        if (!activeTab || !activeTab.id || !activeTab.url?.includes("support.oefr-kraken.energy")) {
          try {
            const tabs = await chrome.tabs.query({ active: true });
            activeTab = tabs.find(t => t.url && (t.url.includes("support.oefr-kraken.energy") || t.url.includes("octopusenergy.fr"))) || activeTab;
          } catch (_) {}
        }

        let resolvedAcc = currentAccountNumber;
        if (!resolvedAcc && activeTab?.url) {
          const m = activeTab.url.match(/(?:accounts|comptes)\/(A-[A-Z0-9]+)/i);
          if (m) resolvedAcc = m[1];
        }
        if (!resolvedAcc) {
          const badgeMatch = accountBadge?.textContent?.match(/A-[A-Z0-9]+/i);
          if (badgeMatch) resolvedAcc = badgeMatch[0];
        }
        if (!resolvedAcc && initialAccount) {
          resolvedAcc = initialAccount;
        }

        const tabIdParam = activeTab?.id ? `&tabId=${activeTab.id}` : "";
        const accParam = resolvedAcc ? `&account=${resolvedAcc}` : "";
        const createOpts = {
          url: chrome.runtime.getURL(`popup.html?mode=fullscreen${tabIdParam}${accParam}`)
        };
        if (activeTab?.index !== undefined) {
          createOpts.index = activeTab.index + 1;
        }
        await chrome.tabs.create(createOpts);
        if (currentMode !== "window") {
          window.close();
        }
      } catch (err) {
        console.warn("[Popup] Erreur ouverture plein écran :", err.message);
      }
    });
  }

  // Événement de synchronisation manuelle
  if (syncSessionBtn) {
    syncSessionBtn.addEventListener("click", () => {
      loadData(true);
    });
  }

  // Changement de contrat dans le sélecteur
  contractSelect.addEventListener("change", (e) => {
    const selectedId = e.target.value;
    const contract = contractsList.find((c) => String(c.id) === selectedId);
    if (contract) {
      currentContract = contract;
      renderContractDetails(contract);

      // Si le suivi conso n'a pas encore été récupéré pour ce contrat spécifique
      if (!contract.consoMensuelle && contract.prm && contract.prm !== "-") {
        if (badgeConsoStatus) {
          badgeConsoStatus.textContent = "Chargement...";
          badgeConsoStatus.className = "badge badge-info";
        }
        chrome.runtime.sendMessage({
          type: "FETCH_CONSO_DATA",
          payload: {
            accountNumber: currentAccountNumber,
            prmId: contract.prm,
            propertyId: contract.propertyId,
            contract: contract,
            propertyIds: activeTabContext.propertyIds || [],
            propertyMapping: activeTabContext.propertyMapping || []
          }
        }, (response) => {
          if (response?.success && response.data) {
            contract.consoMensuelle = response.data;
            if (currentContract && String(currentContract.id) === String(contract.id)) {
              renderConsoDetails(contract.consoMensuelle);
            }
            if (currentAccountNumber && contractsList && contractsList.length > 0) {
              chrome.storage.local.set({
                [`account_cache_${currentAccountNumber}`]: {
                  accountNumber: currentAccountNumber,
                  contracts: contractsList,
                  cachedAt: Date.now(),
                  cacheVersion: CACHE_VERSION
                }
              }).catch(() => {});
            }
          }
        });
      }
    }
  });

  // Copie du PRM
  copyPrmBtn.addEventListener("click", () => {
    if (!currentContract || !currentContract.prm || currentContract.prm === "-") return;
    navigator.clipboard.writeText(currentContract.prm).then(() => {
      showCopyFeedback("N° PRM copié !");
    });
  });

  // Copie des plages Heures Creuses
  copyHorairesHcBtn.addEventListener("click", () => {
    const hcHoraires = currentContract?.horairesHeuresCreuses || activeTabContext?.domHorairesHc;
    if (!hcHoraires) return;
    const plages = parseHcSchedule(hcHoraires);
    const texte = plages.length > 0 ? plages.join(" · ") : hcHoraires;
    navigator.clipboard.writeText(texte).then(() => {
      showCopyFeedback("Plages Heures Creuses copiées !");
    });
  });

  // Bouton de synchronisation SGE Enedis
  if (syncSgeBtn) {
    syncSgeBtn.addEventListener("click", () => {
      if (!currentContract || !currentContract.prm || currentContract.prm === "-") {
        if (badgeSgeStatus) {
          badgeSgeStatus.textContent = "PRM manquant";
          badgeSgeStatus.className = "badge badge-warning";
        }
        return;
      }
      fetchSgeForCurrentContract(currentContract.prm, true);
    });
  }

  /**
   * Toggle de l'historique des échéanciers
   */
  if (echeancierHistoriqueToggle) {
    echeancierHistoriqueToggle.addEventListener("click", () => {
      const content = echeancierHistoriqueContent;
      const chevron = echeancierHistoriqueToggle.querySelector(".echeancier-historique-chevron");
      if (content.style.display === "none") {
        content.style.display = "";
        if (chevron) chevron.classList.add("open");
      } else {
        content.style.display = "none";
        if (chevron) chevron.classList.remove("open");
      }
    });
  }

  /**
   * Toggle du calculateur d'échéances
   */
  if (echeancierCalcToggle) {
    echeancierCalcToggle.addEventListener("click", () => {
      const content = echeancierCalcContent;
      const chevron = echeancierCalcToggle.querySelector(".echeancier-calc-chevron");
      if (content.style.display === "none") {
        content.style.display = "";
        if (chevron) chevron.classList.remove("closed");
      } else {
        content.style.display = "none";
        if (chevron) chevron.classList.add("closed");
      }
    });
  }

  // Écouteurs de changement de dates pour le calculateur
  function onCalcDateInput() {
    clearActivePreset();
    updateEcheancierCalculation();
  }

  if (calcDateDebut) {
    calcDateDebut.addEventListener("change", onCalcDateInput);
    calcDateDebut.addEventListener("input", onCalcDateInput);
  }
  if (calcDateFin) {
    calcDateFin.addEventListener("change", onCalcDateInput);
    calcDateFin.addEventListener("input", onCalcDateInput);
  }

  function clearActivePreset() {
    [calcPresetAll, calcPreset1Year, calcPresetYtd].forEach(btn => {
      if (btn) btn.classList.remove("active");
    });
  }

  function setActivePreset(activeBtn) {
    clearActivePreset();
    if (activeBtn) activeBtn.classList.add("active");
  }

  if (calcPresetAll) {
    calcPresetAll.addEventListener("click", () => {
      setActivePreset(calcPresetAll);
      if (!currentActiveSchedules || currentActiveSchedules.length === 0) return;
      const validDates = currentActiveSchedules
        .map(s => parseKrakenDate(s.du))
        .filter(Boolean)
        .sort((a, b) => a.getTime() - b.getTime());
      const earliestDate = validDates[0] || (currentContract?.rawValidFrom ? new Date(currentContract.rawValidFrom) : new Date());
      if (calcDateDebut) calcDateDebut.value = formatDateToISO(earliestDate);
      if (calcDateFin) calcDateFin.value = formatDateToISO(new Date());
      updateEcheancierCalculation();
    });
  }

  if (calcPreset1Year) {
    calcPreset1Year.addEventListener("click", () => {
      setActivePreset(calcPreset1Year);
      const d = new Date();
      d.setFullYear(d.getFullYear() - 1);
      if (calcDateDebut) calcDateDebut.value = formatDateToISO(d);
      if (calcDateFin) calcDateFin.value = formatDateToISO(new Date());
      updateEcheancierCalculation();
    });
  }

  if (calcPresetYtd) {
    calcPresetYtd.addEventListener("click", () => {
      setActivePreset(calcPresetYtd);
      const d = new Date(new Date().getFullYear(), 0, 1);
      if (calcDateDebut) calcDateDebut.value = formatDateToISO(d);
      if (calcDateFin) calcDateFin.value = formatDateToISO(new Date());
      updateEcheancierCalculation();
    });
  }

  if (copyCalcResultBtn) {
    copyCalcResultBtn.addEventListener("click", () => {
      if (!lastCalcResult || !lastCalcResult.res) return;
      const { res, fromDate, toDate } = lastCalcResult;
      const lines = [
        `Simulation mensualités du ${formatDateFR(fromDate)} au ${formatDateFR(toDate)} (${res.count} mensualité${res.count > 1 ? "s" : ""}) :`
      ];
      for (const p of res.periodsBreakdown) {
        lines.push(`• Du ${p.du} au ${p.au} : ${p.count} × ${p.montantUnit} = ${p.subtotal.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`);
      }
      lines.push(`👉 TOTAL THÉORIQUE DÛ : ${res.totalDue.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`);

      navigator.clipboard.writeText(lines.join("\n")).then(() => {
        const prevText = copyCalcResultBtn.textContent;
        copyCalcResultBtn.textContent = "✓ Copié !";
        setTimeout(() => {
          copyCalcResultBtn.textContent = prevText;
        }, 1500);
      });
    });
  }

  /**
   * Récupère l'échéancier de paiement depuis Kraken via le partial endpoint
   * @param {string} account - Le numéro de compte (ex: A-C887F289)
   * @param {number} tabId - L'ID de l'onglet Kraken
   */
  async function fetchPaymentSchedule(account, tabId) {
    if (!account || !tabId) return;
    try {
      if (badgeEcheancierStatus) {
        badgeEcheancierStatus.textContent = "Chargement...";
        badgeEcheancierStatus.className = "badge badge-info";
      }

      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: async (acct) => {
          try {
            // 1. Récupérer les échéanciers groupés par ledger
            const res = await fetch("/accounts/" + acct + "/partial/payment-details/");
            if (!res.ok) return null;
            const html = await res.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, "text/html");

            const allSections = doc.querySelectorAll('div[id^="schedules-L-"]');
            if (allSections.length === 0) return null;

            const ledgersData = [];
            for (const section of allSections) {
              const ledId = section.id.replace("schedules-", "");
              // Extraire l'agreementId s'il figure dans les boutons d'action (ex: /payments/A-XXXX/161916/...)
              const agMatch = section.innerHTML.match(/\/payments\/(?:scheduling\/)?[A-Z0-9-]+\/(\d+)\//);
              const agreementId = agMatch ? agMatch[1] : null;

              const rows = section.querySelectorAll("table tbody tr");
              const schedules = [];
              for (const row of rows) {
                const cells = row.querySelectorAll("td");
                if (cells.length < 4) continue;
                const du = cells[0].textContent.trim();
                const au = cells[1].textContent.trim();
                const quand = cells[2].textContent.trim();
                const montantText = cells[3].textContent.trim();
                const isActive = row.classList.contains("tako-table--success");
                schedules.push({ du: du, au: au, quand: quand, montant: montantText, isActive: isActive });
              }
              ledgersData.push({ ledgerId: ledId, agreementId: agreementId, schedules: schedules });
            }

            return { ledgersData: ledgersData };
          } catch (e) {
            return null;
          }
        },
        args: [account]
      });

      const payload = result?.result;
      if (!payload || !payload.ledgersData || payload.ledgersData.length === 0) {
        if (badgeEcheancierStatus) {
          badgeEcheancierStatus.textContent = "Non disponible";
          badgeEcheancierStatus.className = "badge badge-warning";
        }
        return;
      }

      // 2e injection : lire le DOM actuel pour trouver le mapping ledger → PRM
      // On passe les PRMs connus pour ne chercher que ceux-là (pas d'IDs parasites)
      let ledgerPrmMap = {};
      const knownPrms = (contractsList || [])
        .map(c => c.prm)
        .filter(p => p && p !== "-" && /^\d{14}$/.test(p));

      if (knownPrms.length > 0) {
        try {
          const mappingResults = await chrome.scripting.executeScript({
            target: { tabId: tabId, allFrames: true },
            func: (targetPrms) => {
              var rawText = (document.body && document.body.textContent) ? document.body.textContent : "";
              if (rawText.length < 20) return null;
              // Nettoyage des isolats Unicode directionnels Kraken autour des nombres
              var bodyText = rawText.replace(/[\u2068\u2069\u200E\u200F\u202A-\u202E]/g, "");

              // Trouver les positions de tous les ledger IDs
              var ledgerRe = /L-[A-Z0-9]{8,}/g;
              var foundLedgers = [];
              var m;
              while ((m = ledgerRe.exec(bodyText)) !== null) {
                foundLedgers.push({ id: m[0], pos: m.index });
              }
              if (foundLedgers.length === 0) return null;

              // Trouver toutes les positions des PRMs connus dans le texte
              var map = {};
              for (var pi = 0; pi < targetPrms.length; pi++) {
                var prm = targetPrms[pi];
                var prmIdx = -1;
                while ((prmIdx = bodyText.indexOf(prm, prmIdx + 1)) !== -1) {
                  // Trouver le ledger le plus proche de cette occurrence du PRM
                  var nearest = null;
                  var minD = 2000;
                  for (var li = 0; li < foundLedgers.length; li++) {
                    var d = Math.abs(prmIdx - foundLedgers[li].pos);
                    if (d < minD) {
                      minD = d;
                      nearest = foundLedgers[li].id;
                    }
                  }
                  if (nearest) {
                    map[nearest] = prm;
                  }
                }
              }
              return map;
            },
            args: [knownPrms]
          });
          // Fusionner les résultats de tous les frames
          if (mappingResults) {
            for (const r of mappingResults) {
              if (r.result) {
                for (const key of Object.keys(r.result)) {
                  ledgerPrmMap[key] = r.result[key];
                }
              }
            }
          }
        } catch (_) {}
      }

      // Stocker les données brutes pour le switch de contrat
      cachedPaymentData = { ledgersData: payload.ledgersData, ledgerPrmMap: ledgerPrmMap };
      console.log("[Popup] === PAIEMENTS DÉTECTÉS ===");
      console.log("[Popup] Mapping ledger->PRM :", JSON.stringify(ledgerPrmMap));
      for (const l of payload.ledgersData) {
        console.log(`[Popup] Ledger ${l.ledgerId} (${l.schedules.length} échéances) : active=${l.schedules.find(s => s.isActive)?.montant || "aucune"} | 1ère=${l.schedules[0]?.montant || "vide"}`);
      }

      // Trouver la bonne section pour le contrat courant
      renderEcheancierForContract(currentContract?.prm);

    } catch (err) {
      console.warn("[Popup] Erreur récupération échéancier :", err.message);
      if (badgeEcheancierStatus) {
        badgeEcheancierStatus.textContent = "Erreur";
        badgeEcheancierStatus.className = "badge badge-danger";
      }
    }
  }

  /**
   * Parse un montant d'échéance (ex: '65,47 €' -> 65.47)
   */
  function parseScheduleMontant(str) {
    if (!str) return 0;
    const cleaned = String(str).replace(/[^\d,.-]/g, "").replace(",", ".");
    const val = parseFloat(cleaned);
    return isNaN(val) ? 0 : val;
  }

  /**
   * Parse une date Kraken (ex: '6th Feb 2026', '24th Oct 2023', '24/10/2023', '2023-10-24')
   */
  function parseKrakenDate(dateStr) {
    if (!dateStr || dateStr === "---" || dateStr === "-") return null;
    const str = String(dateStr).trim();

    // Format ISO YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      const parts = str.split("-").map(Number);
      return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
    }

    // Format DD/MM/YYYY
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(str)) {
      const parts = str.split("/").map(Number);
      return new Date(parts[2], parts[1] - 1, parts[0], 12, 0, 0);
    }

    // Format ordinal anglais (6th, 1st, 2nd, 3rd) ou français
    const cleanStr = str.replace(/(\d+)(?:st|nd|rd|th|er|e)\b/i, "$1");
    const monthMap = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
      janv: 0, févr: 1, fevr: 1, mars: 2, avr: 3, mai: 4, juin: 5, juil: 6, août: 7, aout: 7, sept: 8, octo: 9, nov: 10, déc: 11,
      january: 0, february: 1, march: 2, april: 3, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
      janvier: 0, février: 1, fevrier: 1, avril: 3, juillet: 6, septembre: 8, octobre: 9, novembre: 10, décembre: 11
    };

    const match = cleanStr.match(/(\d{1,2})\s+([a-zA-Zàéûôöïîç]+)\.?\s+(\d{4})/i);
    if (match) {
      const day = parseInt(match[1], 10);
      const mStr = match[2].toLowerCase();
      const year = parseInt(match[3], 10);
      let month = null;
      for (const k of Object.keys(monthMap)) {
        if (mStr.startsWith(k) || k.startsWith(mStr)) {
          month = monthMap[k];
          break;
        }
      }
      if (month !== null && !isNaN(day) && !isNaN(year)) {
        return new Date(year, month, day, 12, 0, 0);
      }
    }

    const d = new Date(str);
    return isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0);
  }

  function formatDateToISO(d) {
    if (!d || isNaN(d.getTime())) return "";
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function formatDateFR(d) {
    if (!d || isNaN(d.getTime())) return "-";
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  /**
   * Calcule le total théorique des mensualités dues entre deux dates
   */
  function calculateDuePayments(schedulesList, fromDate, toDate) {
    let totalDue = 0;
    const installments = [];
    const periodsBreakdown = [];

    if (!Array.isArray(schedulesList) || schedulesList.length === 0 || !fromDate || !toDate || fromDate > toDate) {
      return { totalDue: 0, count: 0, installments: [], periodsBreakdown: [] };
    }

    const fDate = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate(), 0, 0, 0);
    const tDate = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate(), 23, 59, 59);

    for (const s of schedulesList) {
      const montant = parseScheduleMontant(s.montant);
      if (montant <= 0) continue;
      const dStart = parseKrakenDate(s.du);
      const dEnd = parseKrakenDate(s.au); // null si en cours
      if (!dStart) continue;

      const dayMatch = (s.quand || "").match(/(\d{1,2})/);
      const debitDay = dayMatch ? parseInt(dayMatch[1], 10) : dStart.getDate();

      let cursorYear = dStart.getFullYear();
      let cursorMonth = dStart.getMonth();
      const maxDate = dEnd || tDate;

      let periodCount = 0;

      while (true) {
        const daysInMonth = new Date(cursorYear, cursorMonth + 1, 0).getDate();
        const actualDay = Math.min(debitDay, daysInMonth);
        const installmentDate = new Date(cursorYear, cursorMonth, actualDay, 12, 0, 0);

        if (installmentDate >= dStart && (!dEnd || installmentDate <= dEnd)) {
          if (installmentDate >= fDate && installmentDate <= tDate) {
            totalDue += montant;
            periodCount++;
            installments.push({
              date: installmentDate,
              montant: montant,
              label: s.montant,
              du: s.du,
              au: s.au || "en cours"
            });
          }
        }

        if (installmentDate > maxDate) break;

        cursorMonth++;
        if (cursorMonth > 11) {
          cursorMonth = 0;
          cursorYear++;
        }
        if (cursorYear > maxDate.getFullYear() + 1) break;
      }

      if (periodCount > 0) {
        periodsBreakdown.push({
          du: s.du,
          au: s.au && s.au !== "---" ? s.au : "En cours",
          montantUnit: s.montant,
          montantNum: montant,
          count: periodCount,
          subtotal: periodCount * montant
        });
      }
    }

    return { totalDue, count: installments.length, installments, periodsBreakdown };
  }

  /**
   * Met à jour l'affichage du calculateur de mensualités
   */
  function updateEcheancierCalculation() {
    if (!calcDateDebut || !calcDateFin) return;

    const fromDate = calcDateDebut.value ? new Date(calcDateDebut.value + "T12:00:00") : null;
    const toDate = calcDateFin.value ? new Date(calcDateFin.value + "T12:00:00") : null;

    if (!fromDate || !toDate) {
      if (calcTotalAmount) calcTotalAmount.textContent = "0,00 €";
      if (calcTotalCount) calcTotalCount.textContent = "0 mensualité";
      if (calcBreakdownList) calcBreakdownList.textContent = "";
      lastCalcResult = null;
      return;
    }

    const res = calculateDuePayments(currentActiveSchedules, fromDate, toDate);
    lastCalcResult = { res, fromDate, toDate };

    if (calcTotalAmount) {
      calcTotalAmount.textContent = res.totalDue.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
    }
    if (calcTotalCount) {
      calcTotalCount.textContent = `${res.count} mensualité${res.count > 1 ? "s" : ""}`;
    }

    if (calcBreakdownList) {
      calcBreakdownList.textContent = "";
      if (res.periodsBreakdown.length === 0) {
        const emptyDiv = document.createElement("div");
        emptyDiv.className = "calc-breakdown-row";
        emptyDiv.style.fontStyle = "italic";
        emptyDiv.style.color = "var(--text-muted)";
        emptyDiv.textContent = "Aucune mensualité tombant sur cette période.";
        calcBreakdownList.appendChild(emptyDiv);
      } else {
        for (const p of res.periodsBreakdown) {
          const row = document.createElement("div");
          row.className = "calc-breakdown-row";

          const periodCol = document.createElement("div");
          periodCol.className = "calc-breakdown-period";

          const formulaSpan = document.createElement("span");
          formulaSpan.className = "calc-breakdown-formula";
          formulaSpan.textContent = `${p.count} × ${p.montantUnit}`;

          const datesSpan = document.createElement("span");
          datesSpan.className = "calc-breakdown-dates";
          datesSpan.textContent = `Période : ${p.du} ➔ ${p.au}`;

          periodCol.appendChild(formulaSpan);
          periodCol.appendChild(datesSpan);

          const subtotalSpan = document.createElement("span");
          subtotalSpan.className = "calc-breakdown-subtotal";
          subtotalSpan.textContent = p.subtotal.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";

          row.appendChild(periodCol);
          row.appendChild(subtotalSpan);
          calcBreakdownList.appendChild(row);
        }
      }
    }
  }

  /**
   * Initialise et calcule automatiquement pour un jeu d'échéances donné
   */
  function initAndRunCalculator(schedules) {
    if (!calcDateDebut || !calcDateFin) return;

    currentActiveSchedules = schedules || [];

    const validDates = currentActiveSchedules
      .map(s => parseKrakenDate(s.du))
      .filter(Boolean)
      .sort((a, b) => a.getTime() - b.getTime());

    const earliestDate = validDates[0] || (currentContract?.rawValidFrom ? new Date(currentContract.rawValidFrom) : new Date());
    const today = new Date();

    calcDateDebut.value = formatDateToISO(earliestDate);
    calcDateFin.value = formatDateToISO(today);

    setActivePreset(calcPresetAll);
    updateEcheancierCalculation();
  }

  /**
   * Affiche l'échéancier correspondant au PRM donné
   */
  function renderEcheancierForContract(prm) {
    if (!cachedPaymentData || !cachedPaymentData.ledgersData) return;

    const { ledgersData, ledgerPrmMap } = cachedPaymentData;
    let targetSection = null;

    // Stratégie 1 : matcher par PRM via le mapping ledger→PRM
    if (prm && ledgerPrmMap) {
      const matchingSections = ledgersData.filter(s => ledgerPrmMap[s.ledgerId] === prm);
      if (matchingSections.length === 1) {
        targetSection = matchingSections[0];
      } else if (matchingSections.length > 1) {
        // En cas de plusieurs ledgers pour un même logement (ex: ancien ledger à 0,00 € et nouveau ledger actif) :
        // 1. Privilégier un ledger ayant une mensualité active strictement supérieure à 0 €
        // 2. Sinon privilégier un ledger ayant n'importe quelle échéance > 0 €
        // 3. Sinon le plus grand nombre d'échéances
        targetSection = matchingSections.find(s => s.schedules && s.schedules.some(r => r.isActive && parseScheduleMontant(r.montant) > 0))
                     || matchingSections.find(s => s.schedules && s.schedules.some(r => parseScheduleMontant(r.montant) > 0))
                     || matchingSections.find(s => s.schedules && s.schedules.some(r => r.isActive))
                     || matchingSections.slice().sort((a, b) => (b.schedules?.length || 0) - (a.schedules?.length || 0))[0];
      }
    }

    // Stratégie 2 : matcher par ledgerId du propertyMapping
    if (!targetSection && currentContract && activeTabContext?.propertyMapping) {
      const mapping = activeTabContext.propertyMapping.find(m =>
        (m.agreementId && String(m.agreementId) === String(currentContract.agreementId || currentContract.id)) ||
        (m.prm && m.prm === prm)
      );
      if (mapping?.ledgerId) {
        targetSection = ledgersData.find(s => s.ledgerId === mapping.ledgerId);
      }
    }

    // Stratégie 3 : si un seul ledger, prendre celui-là
    if (!targetSection && ledgersData.length === 1) {
      targetSection = ledgersData[0];
    }

    // Stratégie 4 : matcher par index avec les contrats
    if (!targetSection && contractsList && contractsList.length > 0 && currentContract) {
      const idx = contractsList.indexOf(currentContract);
      if (idx >= 0 && idx < ledgersData.length) {
        targetSection = ledgersData[idx];
      }
    }

    // Fallback : premier ledger ayant un échéancier actif > 0 € ou premier ledger
    if (!targetSection) {
      targetSection = ledgersData.find(s => s.schedules && s.schedules.some(r => r.isActive && parseScheduleMontant(r.montant) > 0))
                   || ledgersData.find(s => s.schedules && s.schedules.some(r => r.isActive))
                   || ledgersData[0];
    }

    console.log(`[Popup] Affichage contrat PRM ${prm} -> Ledger retenu: ${targetSection?.ledgerId} (${targetSection?.schedules?.length || 0} lignes)`);

    const schedules = targetSection?.schedules;
    if (!schedules || schedules.length === 0) {
      if (badgeEcheancierStatus) {
        badgeEcheancierStatus.textContent = "Aucun";
        badgeEcheancierStatus.className = "badge badge-warning";
      }
      if (echeancierCard) echeancierCard.style.display = "none";
      return;
    }

    // Afficher la carte
    if (echeancierCard) echeancierCard.style.display = "";

    // Mensualité actuelle : privilégier la ligne active > 0 €, sinon la première ligne > 0 €
    const current = schedules.find(s => s.isActive && parseScheduleMontant(s.montant) > 0)
                 || schedules.find(s => parseScheduleMontant(s.montant) > 0)
                 || schedules.find(s => s.isActive)
                 || schedules[0];
    if (echeancierMontant) echeancierMontant.textContent = current.montant;
    if (echeancierQuand) echeancierQuand.textContent = current.quand;
    if (echeancierDepuis) echeancierDepuis.textContent = "depuis le " + current.du;
    if (badgeEcheancierStatus) {
      badgeEcheancierStatus.textContent = current.montant;
      badgeEcheancierStatus.className = "badge badge-success";
    }

    // Historique
    const historique = schedules.filter(s => s !== current);
    if (echeancierHistoriqueBox) {
      if (historique.length > 0) {
        echeancierHistoriqueBox.style.display = "";
        if (echeancierHistoriqueBody) {
          echeancierHistoriqueBody.textContent = "";
          for (const h of historique) {
            const tr = document.createElement("tr");
            const tdDu = document.createElement("td");
            tdDu.textContent = h.du;
            const tdAu = document.createElement("td");
            tdAu.textContent = h.au;
            const tdMontant = document.createElement("td");
            tdMontant.textContent = h.montant;
            const tdQuand = document.createElement("td");
            tdQuand.textContent = h.quand;
            tr.appendChild(tdDu);
            tr.appendChild(tdAu);
            tr.appendChild(tdMontant);
            tr.appendChild(tdQuand);
            echeancierHistoriqueBody.appendChild(tr);
          }
        }
      } else {
        echeancierHistoriqueBox.style.display = "none";
      }
    }

    // Initialiser et exécuter le calculateur de mensualités théoriques
    initAndRunCalculator(schedules);
  }

  /**
   * Récupère les données SGE pour le PRM donné et met à jour l'interface
   * @param {string} prm - Le numéro PRM (14 chiffres)
   * @param {boolean} bypassCache - Si true, ignore le cache
   */
  function fetchSgeForCurrentContract(prm, bypassCache = false) {
    if (!prm || prm === "-") return;

    // État de chargement
    if (badgeSgeStatus) {
      badgeSgeStatus.textContent = "Chargement...";
      badgeSgeStatus.className = "badge badge-info";
    }
    if (syncSgeBtn) {
      syncSgeBtn.disabled = true;
      syncSgeBtn.classList.add("loading");
      const btnSpan = syncSgeBtn.querySelector("span");
      if (btnSpan) btnSpan.textContent = "Récupération en cours...";
    }
    if (sgeEmptyMessage) sgeEmptyMessage.classList.add("hidden");

    chrome.runtime.sendMessage({
      type: "FETCH_SGE_DATA",
      payload: { prm: String(prm), bypassCache: bypassCache }
    }, (response) => {
      // Restaurer le bouton
      if (syncSgeBtn) {
        syncSgeBtn.disabled = false;
        syncSgeBtn.classList.remove("loading");
        const btnSpan = syncSgeBtn.querySelector("span");
        if (btnSpan) btnSpan.textContent = "⚡ Récupérer les données SGE";
      }

      if (chrome.runtime.lastError) {
        if (badgeSgeStatus) {
          badgeSgeStatus.textContent = "Erreur";
          badgeSgeStatus.className = "badge badge-danger";
        }
        if (sgeEmptyMessage) {
          sgeEmptyMessage.classList.remove("hidden");
          const msgSpan = sgeEmptyMessage.querySelector("span");
          if (msgSpan) msgSpan.textContent = "⚠️ " + chrome.runtime.lastError.message;
        }
        return;
      }

      if (!response || !response.success) {
        const isNoTab = response?.error && response.error.includes("Aucun onglet SGE");
        if (badgeSgeStatus) {
          badgeSgeStatus.textContent = isNoTab ? "Onglet SGE requis" : (response?.authRequired ? "Session expirée" : "Erreur");
          badgeSgeStatus.className = isNoTab ? "badge badge-warning" : "badge badge-danger";
        }
        if (sgeEmptyMessage) {
          sgeEmptyMessage.classList.remove("hidden");
          const msgSpan = sgeEmptyMessage.querySelector("span");
          if (msgSpan) {
            if (isNoTab) {
              msgSpan.textContent = "📋 Ouvrez d'abord la fiche SGE du client depuis Kraken (bouton 🔗), puis cliquez à nouveau sur ⚡ Récupérer.";
            } else {
              msgSpan.textContent = "⚠️ " + (response?.error || "Erreur SGE inconnue");
            }
          }
        }
        return;
      }

      // Succès : afficher les données
      currentSgeData = response.data;
      renderSgeDetails(response.data);
    });
  }

  /**
   * Met à jour la section SGE Enedis avec les données récupérées
   */
  function renderSgeDetails(sge) {
    if (!sgeCard) return;

    if (!sge || !sge.hasData) {
      if (sgeAlimBox) sgeAlimBox.classList.add("hidden");
      if (sgeComptageBox) sgeComptageBox.classList.add("hidden");
      if (sgeContractuelBox) sgeContractuelBox.classList.add("hidden");
      if (sgeEmptyMessage) sgeEmptyMessage.classList.remove("hidden");
      if (badgeSgeStatus) {
        badgeSgeStatus.textContent = "Non synchronisé";
        badgeSgeStatus.className = "badge badge-warning";
      }
      if (syncSgeBtn) syncSgeBtn.classList.remove("hidden");
      return;
    }

    // Badge de statut global
    if (badgeSgeStatus) {
      const isAlim = sge.etatAlimentationCode === "ALIM";
      badgeSgeStatus.textContent = sge.etatAlimentation || "Synchronisé";
      badgeSgeStatus.className = isAlim ? "badge badge-success" : "badge badge-warning";
    }

    // Masquer le message vide et le bouton une fois les données chargées
    if (sgeEmptyMessage) sgeEmptyMessage.classList.add("hidden");
    if (syncSgeBtn) {
      const btnSpan = syncSgeBtn.querySelector("span");
      if (btnSpan) btnSpan.textContent = "🔄 Actualiser les données SGE";
    }

    // Encart Alimentation
    if (sgeAlimBox) {
      sgeAlimBox.classList.remove("hidden");
      if (sgeEtatAlim) {
        sgeEtatAlim.textContent = sge.etatAlimentation || "-";
        const isAlim = sge.etatAlimentationCode === "ALIM";
        sgeEtatAlim.className = isAlim ? "badge badge-success" : "badge badge-warning";
      }
      if (sgePuissanceRaccordement) sgePuissanceRaccordement.textContent = sge.puissanceRaccordementFormate || "-";
      if (sgeTensionLivraison) sgeTensionLivraison.textContent = sge.tensionLivraison || "-";
      if (sgeDomaineTension) sgeDomaineTension.textContent = sge.domaineTension || "-";
    }

    // Encart Compteur & Disjoncteur
    if (sgeComptageBox) {
      sgeComptageBox.classList.remove("hidden");

      // Disjoncteur
      if (sgeCalibre) sgeCalibre.textContent = sge.calibreDisjoncteur || "-";
      if (sgeIntensiteReglage) sgeIntensiteReglage.textContent = sge.intensiteReglageFormate || "-";
      if (sgeDisjAccessible) sgeDisjAccessible.textContent = sge.disjAccessible === true ? "Oui" : sge.disjAccessible === false ? "Non" : "-";

      // Compteur
      if (sgeTypeCompteur) sgeTypeCompteur.textContent = sge.typeCompteur || "-";
      if (sgeTeleoperable) sgeTeleoperable.textContent = sge.teleoperable === true ? "✅ Oui" : sge.teleoperable === false ? "❌ Non" : "-";
      if (sgeNumeroSerie) sgeNumeroSerie.textContent = sge.numeroSerie || "-";
      if (sgeNbFils) sgeNbFils.textContent = sge.nbFilsLabel || "-";
      if (sgeTensionCompteur) sgeTensionCompteur.textContent = sge.tensionCompteur || "-";
      if (sgeIntensiteNominale) sgeIntensiteNominale.textContent = sge.intensiteNominale || "-";

      // Relevé & HC
      if (sgePeriodicite) sgePeriodicite.textContent = sge.periodiciteReleve || "-";
      if (sgeHcRow && sgePlagesHc) {
        if (sge.plagesHcFormatees) {
          sgeHcRow.classList.remove("hidden");
          sgePlagesHc.textContent = sge.plagesHcFormatees;
        } else {
          sgeHcRow.classList.add("hidden");
        }
      }
    }

    // Encart Situation Contractuelle
    if (sgeContractuelBox) {
      const hasContractuel = sge.puissanceSouscriteFormate || sge.puissanceCoupureFormate || sge.calendrierFournisseur || sge.formuleTarifaire;
      if (hasContractuel) {
        sgeContractuelBox.classList.remove("hidden");
        if (sgePuissanceSouscrite) sgePuissanceSouscrite.textContent = sge.puissanceSouscriteFormate || "-";
        if (sgePuissanceCoupure) sgePuissanceCoupure.textContent = sge.puissanceCoupureFormate || "-";
        if (sgeCalendrier) sgeCalendrier.textContent = sge.calendrierFournisseur || "-";
        if (sgeFormuleTarifaire) {
          sgeFormuleTarifaire.textContent = sge.formuleTarifaire || "-";
          if (sge.formuleTarifaireCode) {
            sgeFormuleTarifaire.title = `Code : ${sge.formuleTarifaireCode}`;
          }
        }
      } else {
        sgeContractuelBox.classList.add("hidden");
      }
    }
  }

  // Copie du diagnostic en cliquant sur le tiret du prix du kWh s'il est indisponible
  prixKwh.addEventListener("click", () => {
    if (currentContract?.prixKwhTTC === "-" && currentContract.debugInfo) {
      navigator.clipboard.writeText(JSON.stringify(currentContract.debugInfo, null, 2)).then(() => {
        showCopyFeedback("Diagnostic copié !");
      });
    }
  });

  // Clic sur l'encart Conso pour copier le diagnostic si nécessaire
  consoMoisEnCoursBox?.addEventListener("click", async () => {
    const data = await chrome.storage.local.get(["kraken_page_debug", "kraken_diag_conso", "last_conso_raw"]);
    navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(() => {
      showCopyFeedback("Diagnostic conso copié !");
    });
  });

  // Copie du récapitulatif complet
  copySummaryBtn.addEventListener("click", () => {
    if (!currentContract) return;

    const consoLines = [];
    if (currentContract.consoMensuelle && currentContract.consoMensuelle.hasData) {
      const conso = currentContract.consoMensuelle;
      consoLines.push(`\n📊 SUIVI DE CONSOMMATION`);
      if (conso.derniereReleve) {
        consoLines.push(`• Dernière relève reçue : ${conso.derniereReleve}`);
      }
      if (conso.moisEnCours) {
        const cur = conso.moisEnCours;
        const costStr = (cur.costFormate && cur.costFormate !== "-") ? ` (${cur.costFormate})` : "";
        consoLines.push(`• Mois en cours (${cur.label}) : ${cur.kwhFormate}${costStr}`);
        if (cur.costEnergyEur !== undefined && cur.costAboEur !== undefined && cur.costAboEur > 0) {
          consoLines.push(`  (Énergie : ${cur.costEnergyEur.toFixed(2).replace(".", ",")} € • Abonnement : ${cur.costAboEur.toFixed(2).replace(".", ",")} €)`);
        }
      }
      if (conso.moisPrecedents?.length > 0) {
        const prec = conso.moisPrecedents.map(p => {
          const costStr = (p.costFormate && p.costFormate !== "-") ? ` (${p.costFormate})` : "";
          return `  - ${p.label} : ${p.kwhFormate}${costStr}`;
        });
        consoLines.push(`• Mois précédents :\n${prec.join("\n")}`);
      }
      const allMonths = [conso.moisEnCours, ...(conso.moisPrecedents || [])].filter(Boolean);
      if (allMonths.length > 0) {
        const nbM = allMonths.length;
        const totKwh = conso.totalKwh !== undefined ? conso.totalKwh : Math.round(allMonths.reduce((s, m) => s + (m.kwh || 0), 0) * 10) / 10;
        const totCost = conso.totalCostEur !== undefined ? conso.totalCostEur : Math.round(allMonths.reduce((s, m) => s + (m.costEur || 0), 0) * 100) / 100;
        const totCostStr = totCost > 0 ? `${totCost.toFixed(2).replace(".", ",")} €` : "-";
        const avgKwh = Math.round((totKwh / nbM) * 10) / 10;
        const avgCost = totCost > 0 ? Math.round((totCost / nbM) * 100) / 100 : null;
        const avgCostStr = avgCost > 0 ? `${avgCost.toFixed(2).replace(".", ",")} €/mois` : "-";

        consoLines.push(`• Total cumulé (${nbM} mois) : ${totKwh.toLocaleString("fr-FR")} kWh • ${totCostStr}`);
        consoLines.push(`• Moyenne mensuelle : ${avgKwh.toLocaleString("fr-FR")} kWh/mois • ${avgCostStr}`);
      }
    }

    // Données SGE Enedis
    const sgeLines = [];
    if (currentSgeData && currentSgeData.hasData) {
      const sge = currentSgeData;
      sgeLines.push(`\n⚡ DONNÉES SGE ENEDIS`);
      if (sge.etatAlimentation) sgeLines.push(`• État alimentation : ${sge.etatAlimentation}`);
      if (sge.puissanceRaccordementFormate) sgeLines.push(`• Puissance de raccordement : ${sge.puissanceRaccordementFormate}`);
      if (sge.tensionLivraison && sge.tensionLivraison !== "-") sgeLines.push(`• Tension de livraison : ${sge.tensionLivraison}`);
      if (sge.domaineTension) sgeLines.push(`• Domaine de tension : ${sge.domaineTension}`);
      if (sge.calibreDisjoncteur) sgeLines.push(`• Disjoncteur calibre : ${sge.calibreDisjoncteur}`);
      if (sge.intensiteReglageFormate) sgeLines.push(`• Intensité de réglage : ${sge.intensiteReglageFormate}`);
      if (sge.disjAccessible !== null) sgeLines.push(`• Disjoncteur accessible : ${sge.disjAccessible ? "Oui" : "Non"}`);
      if (sge.typeCompteur) sgeLines.push(`• Type compteur : ${sge.typeCompteur}`);
      if (sge.teleoperable !== null) sgeLines.push(`• Téléopérable : ${sge.teleoperable ? "Oui" : "Non"}`);
      if (sge.nbFilsLabel && sge.nbFilsLabel !== "-") sgeLines.push(`• Installation : ${sge.nbFilsLabel}`);
      if (sge.numeroSerie && sge.numeroSerie !== "-") sgeLines.push(`• N° série compteur : ${sge.numeroSerie}`);
      if (sge.intensiteNominale && sge.intensiteNominale !== "-") sgeLines.push(`• Intensité nominale : ${sge.intensiteNominale}`);
      if (sge.periodiciteReleve) sgeLines.push(`• Périodicité relevé : ${sge.periodiciteReleve}`);
      if (sge.plagesHcFormatees) sgeLines.push(`• Plages HC (Enedis) : ${sge.plagesHcFormatees}`);
      if (sge.puissanceSouscriteFormate) sgeLines.push(`• Puissance souscrite (SGE) : ${sge.puissanceSouscriteFormate}`);
      if (sge.puissanceCoupureFormate) sgeLines.push(`• Puissance de coupure : ${sge.puissanceCoupureFormate}`);
      if (sge.calendrierFournisseur) sgeLines.push(`• Calendrier fournisseur : ${sge.calendrierFournisseur}`);
      if (sge.formuleTarifaire) sgeLines.push(`• Formule tarifaire : ${sge.formuleTarifaire}${sge.formuleTarifaireCode ? ` (${sge.formuleTarifaireCode})` : ""}`);
    }

    const summaryText = [
      `📄 RÉCAPITULATIF CONTRAT CLIENT`,
      `• Compte : ${currentAccountNumber || "-"}`,
      `• Statut : ${currentContract.statut}`,
      `• Offre : ${currentContract.nomOffre} (${currentContract.codeProduit})`,
      `• Énergie : ${currentContract.typeEnergie}`,
      `• PRM : ${currentContract.prm}`,
      `• Puissance : ${currentContract.puissance}`,
      `• Option : ${currentContract.optionTarifaire}`,
      ...((currentContract.horairesHeuresCreuses || activeTabContext?.domHorairesHc) ? [`• Plages Heures Creuses : ${currentContract.horairesHeuresCreuses || activeTabContext?.domHorairesHc}`] : []),
      `• Prix du kWh TTC : ${currentContract.prixKwhTTC}`,
      `• Abonnement TTC : ${currentContract.prixAbonnementMoisTTC}`,
      `• Facturation : ${currentContract.modeFacturation}`,
      `• Date de début : ${currentContract.dateDebut || "-"}`,
      ...(currentContract.dateFin ? [`• Date de résiliation : ${currentContract.dateFin}`] : []),
      `• Compteur Linky : ${currentContract.linky}`,
      `• Adresse : ${currentContract.adresse}`,
      ...consoLines,
      ...sgeLines
    ].join("\n");

    navigator.clipboard.writeText(summaryText).then(() => {
      showCopyFeedback("Récapitulatif copié !");
    });
  });

  /**
   * Identifie l'onglet actif, extrait les données locales du DOM et demande les tarifs au background.
   * Utilise une stratégie Cache-First : restitution instantanée (0 ms) si les données sont déjà en cache local,
   * avec revalidation silencieuse en tâche de fond.
   * @param {boolean} forceRefresh - Si true, contourne le cache et force une requête en direct
   */
  async function loadData(forceRefresh = false) {
    try {
      let tab = null;

      // 1. Détermination prioritaire du compte cible
      let account = initialAccount || null;

      // 2. Recherche de l'onglet associé
      if (initialTabId) {
        try {
          const candidate = await chrome.tabs.get(initialTabId);
          if (candidate?.url && (candidate.url.includes("support.oefr-kraken.energy") || candidate.url.includes("octopusenergy.fr"))) {
            if (!account || candidate.url.includes(account)) {
              tab = candidate;
              if (!account) {
                const m = candidate.url.match(/(?:accounts|comptes)\/(A-[A-Z0-9]+)/i);
                if (m) account = m[1];
              }
            }
          }
        } catch (_) {}
      }

      // Si le compte est spécifié dans l'URL mais tab pas encore trouvée, chercher l'onglet Kraken correspondant exactement à ce compte
      if (!tab && account) {
        try {
          const allKraken = await chrome.tabs.query({ url: ["https://support.oefr-kraken.energy/*", "https://octopusenergy.fr/*"] });
          const matchingTab = allKraken.find(t => t.url && t.url.includes(account));
          if (matchingTab) {
            tab = matchingTab;
          }
        } catch (_) {}
      }

      // En mode fenêtre autonome ou plein écran, si toujours pas de tab, chercher parmi tous les onglets Kraken
      if (!tab && (currentMode === "window" || currentMode === "fullscreen")) {
        try {
          // D'abord chercher parmi les actifs
          const activeTabs = await chrome.tabs.query({ active: true });
          const krakenActive = activeTabs.find(t => t.url && (t.url.includes("support.oefr-kraken.energy") || t.url.includes("octopusenergy.fr")));
          if (krakenActive) {
            tab = krakenActive;
            if (!account) {
              const m = krakenActive.url.match(/(?:accounts|comptes)\/(A-[A-Z0-9]+)/i);
              if (m) account = m[1];
            }
          }
        } catch (_) {}

        // Si toujours pas trouvé (onglet Kraken non actif car le fullscreen a pris le focus), chercher parmi tous les onglets
        if (!tab) {
          try {
            const allKraken = await chrome.tabs.query({ url: ["https://support.oefr-kraken.energy/*", "https://octopusenergy.fr/*"] });
            if (allKraken.length > 0) {
              // Privilégier celui qui contient le compte si on le connaît
              tab = (account ? allKraken.find(t => t.url.includes(account)) : null) || allKraken[0];
              if (!account) {
                const m = tab.url.match(/(?:accounts|comptes)\/(A-[A-Z0-9]+)/i);
                if (m) account = m[1];
              }
            }
          } catch (_) {}
        }
      }

      // En mode standard popup (ou repli) : prendre l'onglet actif de la fenêtre courante
      if (!tab) {
        try {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          tab = activeTab;
        } catch (_) {}
      }

      // Extraction de secours du compte depuis tab si toujours non défini
      if (!account && tab?.url) {
        const krakenMatch = tab.url.match(/accounts\/(A-[A-Z0-9]+)/i);
        const clientMatch = tab.url.match(/comptes\/(A-[A-Z0-9]+)/i);
        account = krakenMatch ? krakenMatch[1] : (clientMatch ? clientMatch[1] : null);

        if (!account && tab.url.includes("support.oefr-kraken.energy")) {
          const titleMatch = tab.title?.match(/(A-[A-Z0-9]{8,})/i);
          if (titleMatch) account = titleMatch[1];
        }
      }

      if (!account) {
        showError("Veuillez vous positionner sur une page compte Kraken (support.oefr-kraken.energy) ou sur l'espace client.");
        return;
      }

      currentAccountNumber = account;
      accountBadge.textContent = `Compte ${account}`;

      // 1. Stratégie Cache-First : Restitution instantanée à 0 ms si données déjà prêtes en cache local
      if (!forceRefresh) {
        try {
          const cacheKey = `account_cache_${account}`;
          const stored = await chrome.storage.local.get([cacheKey]);
          const cached = stored[cacheKey];
          if (cached && cached.cacheVersion === CACHE_VERSION && cached.contracts && Array.isArray(cached.contracts) && cached.contracts.length > 0) {
            const ageMs = Date.now() - (cached.cachedAt || 0);
            if (ageMs < 5 * 60 * 1000) { // Valide 5 minutes
              console.log(`[Popup] ⚡ Affichage instantané depuis le cache local (${Math.round(ageMs / 1000)}s)`);
              handleContractsResult(cached.contracts);
              showContent();

              // Récupérer l'échéancier de paiement en parallèle
              if (tab?.id && account) {
                fetchPaymentSchedule(account, tab.id);
              }

              // Lancement discret d'une revalidation en tâche de fond sans bloquer l'UI
              triggerSilentBackgroundRevalidation(tab, account);
              return;
            }
          } else if (cached && cached.cacheVersion !== CACHE_VERSION) {
            // Nettoyage proactif de l'ancien cache v2 / v3
            chrome.storage.local.remove([cacheKey]);
          }
        } catch (cErr) {
          console.warn("[Popup] Erreur lecture cache local :", cErr.message);
        }
      }

      // 2. Si pas de cache valide ou rafraîchissement forcé demandé : afficher le spinner
      showLoading(forceRefresh ? "Actualisation en direct des données..." : "Récupération des données en temps réel...");

      let tabContext = { agreementIds: [], agreementId: null };

      // Si nous sommes sur Kraken, extraction directe des IDs de contrat et logements avec attente active si HTMX est en cours de chargement
      if (tab.url.includes("support.oefr-kraken.energy")) {
        try {
          const [injectionResult] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async () => {
              const getAgreements = () => {
                const agreementLinks = [...document.querySelectorAll('a[href*="agreements/"]')];
                return [...new Set(
                  agreementLinks.map((a) => a.getAttribute("href")?.match(/agreements\/(\d+)/)?.[1]).filter(Boolean)
                )];
              };

              const agreementIds = getAgreements();

              // Extraction de tous les identifiants de propriété (logement) sur Kraken
              const propLinks = [...document.querySelectorAll('a[href*="properties/"], a[href*="property/"], [data-property-id]')];
              const propertyIds = [...new Set(
                propLinks.map(a => a.getAttribute("data-property-id") || a.getAttribute("href")?.match(/propert(?:y|ies)\/(\d+)/)?.[1]).filter(Boolean)
              )];

              // Mapping des logements (propertyId <-> agreementId <-> PRM)
              const propertyMapping = [];
              for (const pl of propLinks) {
                const pId = pl.getAttribute("data-property-id") || pl.getAttribute("href")?.match(/propert(?:y|ies)\/(\d+)/)?.[1];
                if (!pId) continue;
                let parent = pl.parentElement;
                for (let i = 0; i < 8 && parent && parent !== document.body; i++) {
                  const agLink = parent.querySelector('a[href*="agreements/"]');
                  const agId = agLink?.getAttribute("href")?.match(/agreements\/(\d+)/)?.[1];
                  const prmMatch = parent.innerText.match(/\b\d{14}\b/);
                  const ledgerMatch = parent.innerText.match(/\b(L-[A-Z0-9]{8,})\b/);
                  if (agId || prmMatch) {
                    propertyMapping.push({
                      propertyId: pId,
                      agreementId: agId || null,
                      prm: prmMatch ? prmMatch[0].replace(/[\u2068\u2069\u200E\u200F\u202A-\u202E]/g, "") : null,
                      ledgerId: ledgerMatch ? ledgerMatch[1] : null
                    });
                    break;
                  }
                  parent = parent.parentElement;
                }
              }

              // Recherche d'horaires HC visibles dans le DOM Kraken (ex: "Heures Creuses : 23h00 - 07h00")
              const pageText = document.body.innerText || "";
              const hcMatch = pageText.match(/(?:Heures\s+Creuses|Plage[s]?\s+HC|Horaires\s+HC|Créneaux\s+HC)\s*[:]\s*([0-9hH:\-–\s,\/]+)/i);
              const domHorairesHc = hcMatch ? hcMatch[1].trim() : null;

              // Fallback PRM : si aucun PRM trouvé via propertyMapping, chercher dans le texte de la page
              // Nettoyage des caractères Unicode directionnels (LRI, PDI) qui entourent les PRM sur Kraken
              const cleanText = pageText.replace(/[\u2068\u2069\u200E\u200F\u202A-\u202E]/g, "");
              let fallbackPrmFromPage = null;
              const hasPrmInMapping = propertyMapping.some(m => m.prm && /^\d{14}$/.test(m.prm));
              if (!hasPrmInMapping) {
                const prmPageMatch = cleanText.match(/(\d{14})/);
                if (prmPageMatch) {
                  fallbackPrmFromPage = prmPageMatch[1];
                  // L'ajouter au propertyMapping pour que le fallback SGE fonctionne
                  propertyMapping.push({
                    propertyId: null,
                    agreementId: null,
                    prm: fallbackPrmFromPage
                  });
                }
              }

              return {
                agreementIds: agreementIds,
                agreementId: agreementIds[0] || null,
                propertyIds: propertyIds,
                propertyMapping: propertyMapping,
                domHorairesHc: domHorairesHc
              };
            }
          });

          if (injectionResult?.result) {
            tabContext = injectionResult.result;
            activeTabContext = injectionResult.result;
            activeTabContext.tabId = tab.id;
          }
        } catch (scriptErr) {
          // Poursuite avec tabContext par défaut si l'injection échoue
        }
      } else if (tab.url.includes("octopusenergy.fr")) {
        try {
          const [injectionResult] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              const contractLinks = [...document.querySelectorAll('a[href*="contrats/"]')];
              const agreementIds = [...new Set(contractLinks.map(a => a.getAttribute("href")?.match(/contrats\/(\d+)/)?.[1]).filter(Boolean))];
              
              const logementLinks = [...document.querySelectorAll('a[href*="logements/"]')];
              const propertyIds = [...new Set(logementLinks.map(a => a.getAttribute("href")?.match(/logements\/(\d+)/)?.[1]).filter(Boolean))];

              const urlPropMatch = window.location.pathname.match(/logements\/(\d+)/);
              if (urlPropMatch && !propertyIds.includes(urlPropMatch[1])) {
                propertyIds.push(urlPropMatch[1]);
              }

              // Détection proactive du total officiel affiché à l'écran sur l'Espace Client (ex: Total Décembre 2025: 151,64€ ou 857,7 kWh)
              let pageTotalConso = null;
              try {
                const bodyText = document.body?.innerText || "";
                const matchConso = bodyText.match(/Total\s+([A-Za-zéû]+)\s+(\d{4})[\s\S]{0,50}?([0-9]+[.,][0-9]{2})\s*€/i);
                if (matchConso) {
                  pageTotalConso = {
                    mois: matchConso[1],
                    annee: matchConso[2],
                    montantEur: parseFloat(matchConso[3].replace(",", ".")),
                    montantFormate: `${matchConso[3].replace(".", ",")} €`
                  };
                }
                const matchKwh = bodyText.match(/Total\s+([A-Za-zéû]+)\s+(\d{4})[\s\S]{0,50}?([0-9\s]+[.,][0-9]{1,2})\s*kWh/i);
                if (matchKwh) {
                  const rawVal = parseFloat(matchKwh[3].replace(/\s+/g, "").replace(",", "."));
                  if (!isNaN(rawVal) && rawVal > 0) {
                    if (!pageTotalConso) {
                      pageTotalConso = {
                        mois: matchKwh[1],
                        annee: matchKwh[2]
                      };
                    }
                    pageTotalConso.kwh = rawVal;
                    pageTotalConso.kwhFormate = `${matchKwh[3].trim()} kWh`;
                  }
                }
              } catch (_) {}

              return {
                agreementIds: agreementIds,
                agreementId: agreementIds[0] || null,
                propertyIds: propertyIds,
                propertyMapping: [],
                pageTotalConso: pageTotalConso
              };
            }
          });
          if (injectionResult?.result) {
            tabContext = injectionResult.result;
            activeTabContext = injectionResult.result;
            activeTabContext.tabId = tab.id;
          }
        } catch (_) {}
      }

      // Envoi de la requête au background service worker
      const requestData = () => {
        chrome.runtime.sendMessage(
          {
            type: "FETCH_CONTRACT_DATA",
            payload: {
              accountNumber: account,
              tabId: tab.id,
              agreementId: tabContext.agreementId,
              agreementIds: tabContext.agreementIds,
              propertyIds: tabContext.propertyIds || [],
              propertyMapping: tabContext.propertyMapping || [],
              bypassCache: forceRefresh
            }
          },
          async (response) => {
            if (chrome.runtime.lastError) {
              showError("Erreur d'extension : " + chrome.runtime.lastError.message);
              return;
            }

            if (!response || !response.success) {
              const errorMsg = response?.error || "Impossible de charger les données du contrat pour ce compte.";

              // Même si le contrat échoue, tenter SGE si un PRM est visible sur la page
              console.log("[Popup] Erreur contrat, tentative fallback SGE...");
              let fallbackPrm = null;

              // D'abord chercher dans le propertyMapping existant
              if (activeTabContext?.propertyMapping) {
                for (const mapping of activeTabContext.propertyMapping) {
                  if (mapping.prm && /^\d{14}$/.test(mapping.prm)) {
                    fallbackPrm = mapping.prm;
                    break;
                  }
                }
              }

              // Si pas trouvé, ré-injecter un script dans TOUS les frames de l'onglet Kraken
              if (!fallbackPrm && tab?.id) {
                try {
                  console.log("[Popup] Ré-injection PRM — tab.id:", tab.id, "tab.url:", tab.url);
                  const prmResults = await chrome.scripting.executeScript({
                    target: { tabId: tab.id, allFrames: true },
                    func: () => {
                      const raw = document.body.innerText || "";
                      const text = raw.replace(/[\u2068\u2069\u200E\u200F\u202A-\u202E]/g, "");
                      const match = text.match(/(\d{14})/);
                      return match ? match[1] : null;
                    }
                  });
                  // Consolider les résultats de tous les frames
                  for (const frame of prmResults) {
                    if (frame?.result) {
                      fallbackPrm = frame.result;
                      console.log("[Popup] PRM trouvé via ré-injection (frame) :", fallbackPrm);
                      break;
                    }
                  }
                } catch (injectErr) {
                  console.warn("[Popup] Échec ré-injection PRM :", injectErr.message);
                }
              }

              console.log("[Popup] fallbackPrm final:", fallbackPrm);

              if (fallbackPrm) {
                showError(errorMsg + "\nDonnées SGE disponibles ci-dessous.", response?.authRequired);
                // Afficher le contentState avec seulement la section SGE visible
                contentState.classList.remove("hidden");
                const heroCard = document.querySelector(".hero-card");
                const detailsCard = document.querySelector(".details-card");
                const consoCard = document.querySelector(".conso-card");
                const actionsFooter = document.querySelector(".actions-footer");
                if (heroCard) heroCard.style.display = "none";
                if (detailsCard) detailsCard.style.display = "none";
                if (consoCard) consoCard.style.display = "none";
                if (actionsFooter) actionsFooter.style.display = "none";
              } else {
                showError(errorMsg, response?.authRequired);
              }
              return;
            }

            handleContractsResult(response.data);
            showContent();

            // Récupérer l'échéancier de paiement en parallèle
            if (tab?.id && currentAccountNumber) {
              fetchPaymentSchedule(currentAccountNumber, tab.id);
            }
          }
        );
      };

      requestData();
    } catch (err) {
      showError("Erreur inattendue : " + (err.message || String(err)));
    }
  }

  /**
   * Effectue une revalidation silencieuse en tâche de fond (stale-while-revalidate)
   * pour actualiser le cache local sans bloquer la vue de l'utilisateur
   */
  async function triggerSilentBackgroundRevalidation(tab, account) {
    if (!tab || !account) return;
    try {
      chrome.runtime.sendMessage(
        {
          type: "FETCH_CONTRACT_DATA",
          payload: {
            accountNumber: account,
            tabId: tab.id,
            bypassCache: true
          }
        },
        (response) => {
          if (response?.success && response.data && currentAccountNumber === account) {
            console.log(`[Popup] 🔄 Revalidation silencieuse terminée (${response.data.length} contrats)`);
            handleContractsResult(response.data);
          }
        }
      );
    } catch (_) {}
  }

  /**
   * Synchronise la session pour le compte actif ET récupère les contrats via un fetch injecté
   * dans l'onglet octopusenergy.fr (contexte first-party → cookies SameSite=Lax envoyés).
   * @param {number} tabId - ID de l'onglet Kraken
   * @param {string} accountNumber - Numéro de compte Octopus
   * @param {string[]} agreementIds - IDs de contrats
   * @returns {Promise<{success: boolean, contracts: Array}>}
   */
  async function performSilentSync(tabId, accountNumber, agreementIds) {
    let createdTabId = null;
    try {
      // Écouteur pour intercepter le nouvel onglet ouvert lors de la soumission du formulaire masquerade
      const tabCreatedPromise = new Promise((resolve) => {
        const listener = (newTab) => {
          createdTabId = newTab.id;
          chrome.tabs.onCreated.removeListener(listener);
          // Refocaliser immédiatement l'onglet Kraken pour ne pas perturber l'utilisateur
          chrome.tabs.update(tabId, { active: true }).catch(() => {});
          resolve(newTab.id);
        };
        chrome.tabs.onCreated.addListener(listener);

        // Sécurité si aucun onglet n'est créé dans les 4 secondes
        setTimeout(() => {
          chrome.tabs.onCreated.removeListener(listener);
          resolve(null);
        }, 4000);
      });

      // Injection dans l'onglet Kraken pour trouver et soumettre le formulaire masquerade
      const [execRes] = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        args: [accountNumber],
        func: async (acctNum) => {
          // 1. Recherche directe d'un formulaire masquerade déjà présent dans le DOM
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
          if (formMasq) {
            formMasq.target = "_blank";
            HTMLFormElement.prototype.submit.call(formMasq);
            return { success: true, action: formMasq.action, method: "existing_form" };
          }

          // 2. Si absent du DOM direct, identifier le compte actif
          const effectiveAccount = acctNum || 
            window.location.pathname.match(/accounts\/(A-[A-Z0-9]+)/i)?.[1] ||
            document.body.innerText.match(/\b(A-[A-Z0-9]{8,})\b/i)?.[1];

          if (!effectiveAccount) {
            return { success: false, reason: "Numéro de compte Kraken introuvable" };
          }

          // 3. Récupération du jeton CSRF (DOM ou cookies)
          let csrfToken = document.querySelector('[name="csrfmiddlewaretoken"]')?.value ||
                          document.cookie.match(/csrftoken=([^;]+)/)?.[1];

          // 4. Recherche de l'ID utilisateur (userId) à travers plusieurs méthodes
          // A) Hash de l'URL courante (ex: #/account-users/88372)
          let userId = window.location.hash.match(/account-users\/(\d+)/)?.[1];

          // B) Liens dans le DOM vers les utilisateurs (ex: a[href*="account-users/"])
          if (!userId) {
            const userLinks = [...document.querySelectorAll('a[href*="account-users/"]')];
            userId = userLinks.map(a => a.getAttribute("href")?.match(/account-users\/(\d+)/)?.[1]).find(Boolean);
          }

          // C) Attributs data ou ID dans le DOM
          if (!userId) {
            userId = document.querySelector('[data-user-id]')?.getAttribute('data-user-id');
          }

          // D) Expressions dans le code HTML global
          if (!userId) {
            const bodyHtml = document.body.innerHTML;
            const matchUser = bodyHtml.match(/account-users\/(\d+)/) ||
                              bodyHtml.match(/\/users\/(\d+)\/masquerade/);
            if (matchUser) userId = matchUser[1];
          }

          // E) Requête vers le partial users-overview de Kraken pour ce compte
          if (!userId) {
            try {
              const overviewRes = await fetch(`/accounts/${effectiveAccount}/partial/users-overview/`);
              if (overviewRes.ok) {
                const overviewText = await overviewRes.text();
                const matchUser = overviewText.match(/account-users\/(\d+)/) || 
                                  overviewText.match(/\/users\/(\d+)\/masquerade/) ||
                                  overviewText.match(/\/users\/(\d+)\//);
                if (matchUser) userId = matchUser[1];
                if (!csrfToken) {
                  csrfToken = overviewText.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/)?.[1];
                }
              }
            } catch (_) {}
          }

          // 5. Avec l'ID utilisateur, interroger partial/account-users/${userId}/ pour obtenir l'action et le CSRF exacts
          let masqueradeAction = userId ? `/users/${userId}/masquerade/` : null;

          if (userId) {
            try {
              const userDetailRes = await fetch(`/accounts/${effectiveAccount}/partial/account-users/${userId}/`);
              if (userDetailRes.ok) {
                const userHtml = await userDetailRes.text();
                const parser = new DOMParser();
                const doc = parser.parseFromString(userHtml, "text/html");
                const partialForms = [...doc.querySelectorAll('form[action*="masquerade"]')];
                const foundForm = partialForms.find(f => 
                  !f.action.includes("mobile") && 
                  !f.querySelector('[name="host_override"]') &&
                  (f.textContent.toLowerCase().includes("site web") || 
                   f.querySelector('button')?.textContent.toLowerCase().includes("site web"))
                ) || partialForms.find(f => !f.action.includes("mobile") && !f.querySelector('[name="host_override"]')) || partialForms[0];

                if (foundForm) {
                  masqueradeAction = foundForm.getAttribute("action") || masqueradeAction;
                  const formCsrf = foundForm.querySelector('[name="csrfmiddlewaretoken"]')?.value;
                  if (formCsrf) csrfToken = formCsrf;
                } else {
                  const formMatch = userHtml.match(/action="(\/users\/\d+\/masquerade\/)"/);
                  if (formMatch) masqueradeAction = formMatch[1];
                  const tokenMatch = userHtml.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/);
                  if (tokenMatch) csrfToken = tokenMatch[1];
                }
              }
            } catch (_) {}
          }

          if (!masqueradeAction) {
            return { success: false, reason: "Utilisateur ou formulaire masquerade introuvable pour le compte " + effectiveAccount };
          }

          if (!csrfToken) {
            csrfToken = document.cookie.match(/csrftoken=([^;]+)/)?.[1];
          }

          if (!csrfToken) {
            return { success: false, reason: "Jeton CSRF Kraken introuvable" };
          }

          // 6. Création d'un formulaire dynamique dédié avec target="_blank" et soumission
          const dynamicForm = document.createElement("form");
          dynamicForm.method = "POST";
          dynamicForm.action = masqueradeAction;
          dynamicForm.target = "_blank";
          dynamicForm.style.display = "none";

          const csrfInput = document.createElement("input");
          csrfInput.type = "hidden";
          csrfInput.name = "csrfmiddlewaretoken";
          csrfInput.value = csrfToken;
          dynamicForm.appendChild(csrfInput);

          document.body.appendChild(dynamicForm);
          HTMLFormElement.prototype.submit.call(dynamicForm);

          setTimeout(() => {
            try { dynamicForm.remove(); } catch (_) {}
          }, 1000);

          return { success: true, action: masqueradeAction, method: "dynamic_form", userId: userId };
        }
      });

      if (!execRes?.result?.success) {
        console.warn("[Popup] Masquerade impossible :", execRes?.result?.reason);
        return { success: false, contracts: [], errorMsg: "Masquerade : " + (execRes?.result?.reason || "inconnu") };
      }

      // Attendre la création de l'onglet
      await tabCreatedPromise;

      if (!createdTabId) {
        console.warn("[Popup] Aucun onglet créé par le masquerade");
        return { success: false, contracts: [], errorMsg: "Aucun onglet créé par le masquerade" };
      }

      // Refocaliser l'onglet Kraken immédiatement pour ne pas perturber l'utilisateur
      try { await chrome.tabs.update(tabId, { active: true }); } catch (e) {}

      // Attendre que l'onglet masquerade atteigne octopusenergy.fr (après les redirections)
      let finalTabUrl = "";
      await new Promise((resolve) => {
        let resolved = false;
        const done = () => {
          if (!resolved) {
            resolved = true;
            chrome.tabs.onUpdated.removeListener(onUpdatedListener);
            resolve();
          }
        };

        const onUpdatedListener = (tId, changeInfo, tabInfo) => {
          if (tId !== createdTabId) return;
          const url = tabInfo.url || changeInfo.url || "";
          const isOctopus = url.includes("octopusenergy.fr");
          const isPastMasquerade = isOctopus && !url.includes("/masquerade/");
          if (isPastMasquerade) {
            finalTabUrl = url;
            if (changeInfo.status === "complete" || tabInfo.status === "complete") {
              done();
            }
          }
        };

        chrome.tabs.onUpdated.addListener(onUpdatedListener);

        // Polling de secours actif toutes les 400ms
        const pollInterval = setInterval(async () => {
          if (resolved) {
            clearInterval(pollInterval);
            return;
          }
          try {
            const currentTab = await chrome.tabs.get(createdTabId);
            const url = currentTab?.url || "";
            if (url.includes("octopusenergy.fr") && !url.includes("/masquerade/")) {
              finalTabUrl = url;
              if (currentTab.status === "complete") {
                clearInterval(pollInterval);
                done();
              }
            }
          } catch (e) {
            clearInterval(pollInterval);
            done();
          }
        }, 400);

        setTimeout(() => {
          clearInterval(pollInterval);
          done();
        }, 8000);
      });

      // Vérifier que l'onglet est bien sur octopusenergy.fr
      let tabInfo;
      try { tabInfo = await chrome.tabs.get(createdTabId); } catch (tabErr) {
        return { success: false, contracts: [], errorMsg: "Onglet fermé : " + tabErr.message };
      }
      const tabUrl = tabInfo.url || finalTabUrl || "";
      console.log("[Popup] URL onglet avant injection :", tabUrl);

      if (!tabUrl.includes("octopusenergy.fr")) {
        return { success: false, contracts: [], errorMsg: "Masquerade échoué - onglet sur : " + tabUrl };
      }

      // Extraire le numéro de compte résolu depuis l'URL de l'onglet ou garder le compte actuel
      const urlAccountMatch = tabUrl.match(/\/comptes\/(A-[A-Z0-9]+)/i);
      const resolvedAccount = urlAccountMatch ? urlAccountMatch[1] : accountNumber;
      console.log("[Popup] Compte résolu :", resolvedAccount, "| URL :", tabUrl);

      // Délai pour que NextAuth finalise l'écriture des cookies
      await new Promise(r => setTimeout(r, 1000));

      // ═══════════════════════════════════════════════════════════════════
      // ÉTAPE 1 : Injecter le fetch dans world:"MAIN" pour que les cookies
      // SameSite=Lax soient envoyés. Le résultat est stocké dans un div DOM
      // masqué (aucun risque de blocage CSP script).
      // ═══════════════════════════════════════════════════════════════════
      const RESULT_ELEMENT_ID = "__ext_gql_result__";

      try {
        await chrome.scripting.executeScript({
          target: { tabId: createdTabId },
          world: "MAIN",
          func: (acctNum, gqlQuery, resultId) => {
            const urlMatch = window.location.pathname.match(/\/comptes\/(A-[A-Z0-9]+)/i);
            const effectiveAccount = urlMatch ? urlMatch[1] : acctNum;

            const variables = { accountNumber: effectiveAccount };

            fetch("/api/graphql/kraken", {
              method: "POST",
              headers: {
                "Accept": "application/json",
                "Content-Type": "application/json"
              },
              credentials: "include",
              body: JSON.stringify({ query: gqlQuery, variables, operationName: "AgreementQuery" })
            })
            .then(res => {
              if (!res.ok) {
                throw new Error("HTTP " + res.status + " " + res.statusText);
              }
              return res.json();
            })
            .then(json => {
              const result = {
                edges: (json && json.data && json.data.agreements && json.data.agreements.edges) ? json.data.agreements.edges : [],
                errors: (json && json.errors) ? json.errors.map(e => e.message || String(e)) : [],
                account: effectiveAccount,
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
            })
            .catch(err => {
              let el = document.getElementById(resultId);
              if (!el) {
                el = document.createElement("div");
                el.id = resultId;
                el.style.display = "none";
                document.documentElement.appendChild(el);
              }
              el.textContent = JSON.stringify({ edges: [], errors: [err.message || String(err)], account: effectiveAccount, done: true });
            });
          },
          args: [resolvedAccount, GRAPHQL_AGREEMENTS_QUERY, RESULT_ELEMENT_ID]
        });
      } catch (scriptErr) {
        return { success: false, contracts: [], errorMsg: "Injection world:MAIN échouée : " + scriptErr.message };
      }

      // ═══════════════════════════════════════════════════════════════════
      // ÉTAPE 2 : Attendre que le résultat apparaisse dans le DOM,
      // puis le lire depuis world:ISOLATED (par défaut)
      // ═══════════════════════════════════════════════════════════════════
      let rawResult = null;
      const maxWaitMs = 8000;
      const pollIntervalMs = 300;
      const startPoll = Date.now();

      while (Date.now() - startPoll < maxWaitMs) {
        try {
          const [readRes] = await chrome.scripting.executeScript({
            target: { tabId: createdTabId },
            func: (resultId) => {
              const el = document.getElementById(resultId);
              if (!el || !el.textContent) return null;
              try { return JSON.parse(el.textContent); } catch (e) { return null; }
            },
            args: [RESULT_ELEMENT_ID]
          });
          if (readRes?.result?.done) {
            rawResult = readRes.result;
            break;
          }
        } catch (e) {
          // L'onglet a pu être fermé entre temps
          break;
        }
        await new Promise(r => setTimeout(r, pollIntervalMs));
      }

      // Nettoyage de l'élément DOM (best effort)
      try {
        await chrome.scripting.executeScript({
          target: { tabId: createdTabId },
          func: (resultId) => { const el = document.getElementById(resultId); if (el) el.remove(); },
          args: [RESULT_ELEMENT_ID]
        });
      } catch (_) {}

      if (!rawResult) {
        return { success: false, contracts: [], errorMsg: "Timeout : aucune réponse GraphQL après " + maxWaitMs + "ms" };
      }

      console.log("[Popup] GraphQL résultat :", rawResult.edges.length, "edges | compte :", rawResult.account, "| erreurs :", rawResult.errors);
      console.log("[Popup] Contrats reçus :", rawResult.edges.map(e => ({
        id: e.node?.id,
        ratesCount: e.node?.energySupplyRate?.rates?.edges?.length ?? 0,
        standingRate: e.node?.energySupplyRate?.standingRate?.pricePerUnitWithTaxes
      })));

      if (rawResult.edges.length === 0) {
        const errMsg = rawResult.errors.length > 0
          ? "GraphQL : " + rawResult.errors.join(" | ")
          : "0 contrat (compte : " + rawResult.account + " — URL : " + tabUrl + ")";
        return { success: false, contracts: [], errorMsg: errMsg };
      }

      const rawEdges = rawResult.edges;

      // Formater les edges via le background (qui contient formatAgreementNode)
      const formatted = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: "FORMAT_AGREEMENTS", payload: { edges: rawEdges } },
          (response) => {
            if (chrome.runtime.lastError || !response?.success) {
              resolve([]);
            } else {
              resolve(response.data || []);
            }
          }
        );
      });

      return { success: true, contracts: formatted };

    } catch (err) {
      console.warn("[Popup] Exception sync :", err.message || String(err));
      return { success: false, contracts: [], errorMsg: "Erreur inattendue : " + (err.message || String(err)) };
    } finally {
      // Fermeture garantie de l'onglet d'arrière-plan
      if (createdTabId) {
        try { await chrome.tabs.remove(createdTabId); } catch (e) {}
      }
    }
  }

  /**
   * Traite la liste des contrats reçus
   */
  function handleContractsResult(contracts) {
    if (!contracts || contracts.length === 0) {
      showError("Aucun contrat trouvé pour ce compte.");
      return;
    }

    // Trier les contrats : actifs en priorité, puis par date d'effet la plus récente
    contracts.sort((a, b) => {
      if (a.isReallyActive && !b.isReallyActive) return -1;
      if (!a.isReallyActive && b.isReallyActive) return 1;
      const dateA = new Date(a.rawValidFrom || 0).getTime();
      const dateB = new Date(b.rawValidFrom || 0).getTime();
      return dateB - dateA;
    });

    contractsList = contracts;

    // Gestion du sélecteur si plusieurs contrats/logements
    if (contracts.length > 1) {
      while (contractSelect.firstChild) {
        contractSelect.removeChild(contractSelect.firstChild);
      }

      contracts.forEach((c) => {
        const option = document.createElement("option");
        option.value = String(c.id);
        const icon = c.isReallyActive ? "🟢" : "🔴";
        const statutTxt = c.isReallyActive ? "Actif" : `Résilié${c.dateFin ? " le " + c.dateFin : ""}`;
        const tarifTxt = c.prixKwhTTC && c.prixKwhTTC !== "-" ? ` • ${c.prixKwhTTC}` : "";
        option.textContent = `${icon} ${c.typeEnergie} - PRM ${c.prm} [${statutTxt}] (${c.nomOffre}${tarifTxt})`;
        contractSelect.appendChild(option);
      });

      contractSelectorContainer.classList.remove("hidden");
    } else {
      contractSelectorContainer.classList.add("hidden");
    }

    // Sélection intelligente du contrat à afficher en priorité :
    // 1. Contrat correspondant à l'ID de la page active S'IL possède un tarif kWh
    // 2. Sinon, contrat actif ayant un tarif kWh disponible (évite d'afficher un contrat avec tiret par défaut)
    // 3. Sinon, contrat correspondant à l'ID détecté
    // 4. Premier contrat actif, ou premier contrat disponible
    let targetContract = null;
    if (activeTabContext?.agreementId) {
      const match = contracts.find((c) => String(c.id) === String(activeTabContext.agreementId));
      if (match && match.prixKwhTTC && match.prixKwhTTC !== "-") {
        targetContract = match;
      }
    }
    if (!targetContract) {
      targetContract = contracts.find((c) => c.isReallyActive && c.prixKwhTTC && c.prixKwhTTC !== "-");
    }
    if (!targetContract && activeTabContext?.agreementId) {
      targetContract = contracts.find((c) => String(c.id) === String(activeTabContext.agreementId));
    }
    if (!targetContract && activeTabContext?.agreementIds?.length > 0) {
      targetContract = contracts.find((c) => activeTabContext.agreementIds.includes(String(c.id)));
    }
    if (!targetContract) {
      targetContract = contracts.find((c) => c.isReallyActive) || contracts[0];
    }

    currentContract = targetContract;
    contractSelect.value = String(targetContract.id);

    renderContractDetails(targetContract);

    // Si le suivi conso n'a pas encore de données pour ce contrat, déclencher la récupération
    if ((!targetContract.consoMensuelle || !targetContract.consoMensuelle.hasData) && targetContract.prm && targetContract.prm !== "-") {
      if (badgeConsoStatus) {
        badgeConsoStatus.textContent = "Chargement...";
        badgeConsoStatus.className = "badge badge-info";
      }
      chrome.runtime.sendMessage({
        type: "FETCH_CONSO_DATA",
        payload: {
          accountNumber: currentAccountNumber,
          prmId: targetContract.prm,
          propertyId: targetContract.propertyId,
          contract: targetContract,
          propertyIds: activeTabContext?.propertyIds || [],
          propertyMapping: activeTabContext?.propertyMapping || []
        }
      }, (response) => {
        if (response?.success && response.data && response.data.hasData) {
          targetContract.consoMensuelle = response.data;
          if (currentContract && String(currentContract.id) === String(targetContract.id)) {
            renderConsoDetails(targetContract.consoMensuelle);
          }
          if (currentAccountNumber && contractsList && contractsList.length > 0) {
            chrome.storage.local.set({
              [`account_cache_${currentAccountNumber}`]: {
                accountNumber: currentAccountNumber,
                contracts: contractsList,
                cachedAt: Date.now(),
                cacheVersion: CACHE_VERSION
              }
            }).catch(() => {});
          }
        }
      });
    }

    showContent();
  }

  /**
   * Met à jour les champs du DOM avec les données du contrat sélectionné
   */
  function renderContractDetails(c) {
    badgeStatut.textContent = c.statut;
    if (c.statut === "Actif") {
      badgeStatut.className = "badge badge-success";
    } else if (c.statut === "Résilié" || c.statut === "Annulé") {
      badgeStatut.className = "badge badge-danger";
    } else {
      badgeStatut.className = "badge badge-warning";
    }

    labelEnergie.textContent = c.typeEnergie;
    nomOffre.textContent = c.nomOffre;
    codeOffre.textContent = c.codeProduit ? `Code : ${c.codeProduit}` : "";

    renderPrixKwh(prixKwh, c.prixKwhTTC);

    if (c.prixKwhTTC === "-") {
      prixKwh.title = "Tarif kWh non renseigné. Cliquez pour copier le diagnostic.";
      prixKwh.style.cursor = "pointer";
    } else {
      prixKwh.title = "";
      prixKwh.style.cursor = "";
    }
    prixAbonnement.textContent = c.prixAbonnementMoisTTC;

    valeurPrm.textContent = c.prm;
    valeurPuissance.textContent = c.puissance;
    valeurOption.textContent = c.optionTarifaire;

    // Affichage des plages Heures Creuses si disponibles
    const hcHoraires = c.horairesHeuresCreuses || activeTabContext?.domHorairesHc;
    if (rowHorairesHc && valeurHorairesHc) {
      if (hcHoraires) {
        rowHorairesHc.classList.remove("hidden");
        renderHcSchedule(valeurHorairesHc, hcHoraires);
      } else {
        rowHorairesHc.classList.add("hidden");
      }
    }

    valeurLinky.textContent = c.linky;
    valeurFacturation.textContent = c.modeFacturation;
    valeurDebut.textContent = c.dateDebut || "-";

    // Affichage de la date de résiliation si elle existe
    if (rowFinContrat && valeurFin) {
      if (c.dateFin) {
        rowFinContrat.classList.remove("hidden");
        valeurFin.textContent = c.dateFin;
      } else {
        rowFinContrat.classList.add("hidden");
      }
    }

    valeurAdresse.textContent = c.adresse;

    // Rendu du Suivi Conso Mensuel
    renderConsoDetails(c.consoMensuelle);

    // Réinitialiser l'état SGE pour le nouveau contrat
    currentSgeData = null;
    renderSgeDetails(null);

    // Rafraîchir l'échéancier pour le nouveau contrat (sans re-fetch, juste re-render)
    if (cachedPaymentData) {
      renderEcheancierForContract(c.prm);
    }
  }

  /**
   * Met à jour la section Suivi Conso Mensuel avec les données du mois en cours et passés
   */
  function renderConsoDetails(conso) {
    if (!consoCard) return;

    if (!conso || !conso.hasData) {
      if (consoMoisEnCoursBox) consoMoisEnCoursBox.classList.add("hidden");
      if (consoMoisPrecedentsSection) consoMoisPrecedentsSection.classList.add("hidden");
      if (consoTotalBox) consoTotalBox.classList.add("hidden");
      if (consoEmptyMessage) {
        consoEmptyMessage.classList.remove("hidden");
        const msgSpan = consoEmptyMessage.querySelector("span");
        if (msgSpan && conso?.message) msgSpan.textContent = conso.message;
      }
      if (badgeConsoStatus) {
        badgeConsoStatus.textContent = "Non synchronisé";
        badgeConsoStatus.className = "badge badge-warning";
      }
      return;
    }

    if (badgeConsoStatus) {
      badgeConsoStatus.textContent = "Linky Actif";
      badgeConsoStatus.className = "badge badge-success";
    }

    if (consoEmptyMessage) consoEmptyMessage.classList.add("hidden");

    // Réconciliation avec le total extrait directement de la page Espace Client si disponible
    if (activeTabContext?.pageTotalConso) {
      const pt = activeTabContext.pageTotalConso;
      const allM = [conso.moisEnCours, ...(conso.moisPrecedents || [])].filter(Boolean);
      for (const m of allM) {
        if (m.label && m.label.toLowerCase().includes(pt.mois.toLowerCase()) && m.label.includes(pt.annee)) {
          if (pt.montantEur) {
            m.costEur = pt.montantEur;
            m.costFormate = pt.montantFormate;
          }
          if (pt.kwh) {
            m.kwh = pt.kwh;
            m.kwhFormate = pt.kwhFormate;
          }
        }
      }
    }

    // 1. Mois en cours
    if (conso.moisEnCours) {
      if (consoMoisEnCoursBox) consoMoisEnCoursBox.classList.remove("hidden");
      if (consoMoisEnCoursLabel) consoMoisEnCoursLabel.textContent = conso.moisEnCours.label || "-";
      if (consoMoisEnCoursKwh) consoMoisEnCoursKwh.textContent = conso.moisEnCours.kwhFormate || "- kWh";
      if (consoMoisEnCoursCost) {
        consoMoisEnCoursCost.textContent = (conso.moisEnCours.costFormate && conso.moisEnCours.costFormate !== "-") 
          ? conso.moisEnCours.costFormate 
          : "";
      }

      if (consoMoisEnCoursBreakdown) {
        const parts = [];
        if (conso.moisEnCours.hpKwh && conso.moisEnCours.hcKwh) {
          parts.push(`HP : ${conso.moisEnCours.hpKwh.toLocaleString("fr-FR")} kWh • HC : ${conso.moisEnCours.hcKwh.toLocaleString("fr-FR")} kWh`);
        }
        if (conso.moisEnCours.costEnergyEur !== undefined && conso.moisEnCours.costAboEur !== undefined && conso.moisEnCours.costAboEur > 0) {
          parts.push(`Énergie : ${conso.moisEnCours.costEnergyEur.toFixed(2).replace(".", ",")} € • Abonnement : ${conso.moisEnCours.costAboEur.toFixed(2).replace(".", ",")} €`);
        }
        if (parts.length > 0) {
          consoMoisEnCoursBreakdown.textContent = parts.join(" | ");
          consoMoisEnCoursBreakdown.classList.remove("hidden");
        } else {
          consoMoisEnCoursBreakdown.textContent = "";
          consoMoisEnCoursBreakdown.classList.add("hidden");
        }
      }

      if (consoDerniereReleve) {
        if (conso.derniereReleve) {
          consoDerniereReleve.textContent = `Dernière relève reçue le ${conso.derniereReleve}`;
          consoDerniereReleve.classList.remove("hidden");
        } else {
          consoDerniereReleve.classList.add("hidden");
        }
      }
    } else if (consoMoisEnCoursBox) {
      consoMoisEnCoursBox.classList.add("hidden");
    }

    // 2. Mois précédents
    const precedents = conso.moisPrecedents || [];
    if (consoMonthsList) {
      while (consoMonthsList.firstChild) {
        consoMonthsList.removeChild(consoMonthsList.firstChild);
      }
    }

    if (precedents.length > 0 && consoMonthsList && consoMoisPrecedentsSection) {
      consoMoisPrecedentsSection.classList.remove("hidden");
      const maxKwh = conso.maxKwh || 1;

      precedents.forEach((item) => {
        const row = document.createElement("div");
        row.className = "conso-month-row";

        const header = document.createElement("div");
        header.className = "conso-month-row-header";

        const label = document.createElement("span");
        label.className = "conso-month-label";
        label.textContent = item.label;

        const stats = document.createElement("div");
        stats.className = "conso-month-stats";

        const kwhSpan = document.createElement("span");
        kwhSpan.className = "kwh";
        kwhSpan.textContent = item.kwhFormate;
        stats.appendChild(kwhSpan);

        if (item.costFormate && item.costFormate !== "-") {
          const costSpan = document.createElement("span");
          costSpan.className = "cost";
          costSpan.textContent = item.costFormate;
          stats.appendChild(costSpan);
        }

        header.appendChild(label);
        header.appendChild(stats);

        // Barre relative visuelle
        const barBg = document.createElement("div");
        barBg.className = "conso-bar-bg";
        const barFill = document.createElement("div");
        barFill.className = "conso-bar-fill";
        const pct = Math.min(100, Math.max(6, Math.round(((item.kwh || 0) / maxKwh) * 100)));
        barFill.style.width = `${pct}%`;
        barBg.appendChild(barFill);

        row.appendChild(header);
        row.appendChild(barBg);

        // Ventilation HP / HC si disponible
        if (item.hpKwh && item.hcKwh) {
          const sub = document.createElement("div");
          sub.className = "conso-breakdown-text";
          sub.textContent = `HP : ${item.hpKwh.toLocaleString("fr-FR")} kWh • HC : ${item.hcKwh.toLocaleString("fr-FR")} kWh`;
          row.appendChild(sub);
        }

        consoMonthsList.appendChild(row);
      });
    } else if (consoMoisPrecedentsSection) {
      consoMoisPrecedentsSection.classList.add("hidden");
    }

    // 3. Total cumulé et moyenne (sur les mois affichés : jusqu'à 12 mois)
    if (consoTotalBox) {
      const allMonths = [conso.moisEnCours, ...(conso.moisPrecedents || [])].filter(Boolean);
      if (allMonths.length > 0) {
        const nbM = allMonths.length;
        const totKwh = conso.totalKwh !== undefined ? conso.totalKwh : Math.round(allMonths.reduce((s, m) => s + (m.kwh || 0), 0) * 10) / 10;
        const totCost = conso.totalCostEur !== undefined ? conso.totalCostEur : Math.round(allMonths.reduce((s, m) => s + (m.costEur || 0), 0) * 100) / 100;
        const avgKwh = Math.round((totKwh / nbM) * 10) / 10;
        const avgCost = totCost > 0 ? Math.round((totCost / nbM) * 100) / 100 : null;

        if (consoTotalTitle) consoTotalTitle.textContent = `Total cumulé (${nbM} mois)`;
        if (consoTotalBadge) consoTotalBadge.textContent = `${nbM} mois`;
        if (consoTotalKwh) consoTotalKwh.textContent = `${totKwh.toLocaleString("fr-FR")} kWh`;
        if (consoTotalCost) consoTotalCost.textContent = totCost > 0 ? `${totCost.toFixed(2).replace(".", ",")} €` : "-";

        if (consoAvgKwh) consoAvgKwh.textContent = `Moy. ${avgKwh.toLocaleString("fr-FR")} kWh/m`;
        if (consoAvgCost) consoAvgCost.textContent = avgCost > 0 ? `Moy. ${avgCost.toFixed(2).replace(".", ",")} €/m` : "-";

        consoTotalBox.classList.remove("hidden");
      } else {
        consoTotalBox.classList.add("hidden");
      }
    }
  }

  function showLoading(customMsg) {
    loadingState.classList.remove("hidden");
    errorState.classList.add("hidden");
    contentState.classList.add("hidden");
    const msgEl = loadingState.querySelector(".state-message");
    if (msgEl) {
      msgEl.textContent = customMsg || "Récupération des données en temps réel...";
    }
  }

  function showError(msg, authRequired = false) {
    loadingState.classList.add("hidden");
    errorState.classList.remove("hidden");
    contentState.classList.add("hidden");
    errorMessage.textContent = msg;
    accountBadge.textContent = authRequired ? "Session requise" : "Erreur";

    if (syncSessionBtn) {
      if (authRequired) {
        syncSessionBtn.classList.remove("hidden");
      } else {
        syncSessionBtn.classList.add("hidden");
      }
    }
  }

  function showContent() {
    loadingState.classList.add("hidden");
    errorState.classList.add("hidden");
    contentState.classList.remove("hidden");
  }

  function showCopyFeedback(msg) {
    copyFeedback.textContent = msg;
    copyFeedback.classList.remove("hidden");
    setTimeout(() => {
      copyFeedback.classList.add("hidden");
    }, 2000);
  }

  // En mode fenêtre autonome : synchronisation dynamique automatique dès que le conseiller change d'onglet sur Kraken
  if (currentMode === "window") {
    let syncDebounceTimer = null;
    const handleTabChange = async () => {
      clearTimeout(syncDebounceTimer);
      syncDebounceTimer = setTimeout(async () => {
        try {
          const allTabs = await chrome.tabs.query({ active: true });
          const krakenTab = allTabs.find(t => t.url && (t.url.includes("support.oefr-kraken.energy") || t.url.includes("octopusenergy.fr")));
          if (krakenTab?.url) {
            const m = krakenTab.url.match(/(?:accounts|comptes)\/(A-[A-Z0-9]+)/i);
            const newAcc = m ? m[1] : null;
            if (newAcc && newAcc !== currentAccountNumber) {
              console.log(`[Fenêtre Compagnon] Changement de compte détecté dans Kraken (${newAcc}), actualisation automatique...`);
              loadData(false);
            }
          }
        } catch (_) {}
      }, 350);
    };

    chrome.tabs.onActivated.addListener(handleTabChange);
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === "complete" && tab.url && (tab.url.includes("support.oefr-kraken.energy") || tab.url.includes("octopusenergy.fr"))) {
        handleTabChange();
      }
    });
  }
});

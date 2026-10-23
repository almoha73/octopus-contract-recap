/**
 * Content Script — Bouton latéral d'accès au Récapitulatif Contrat
 * Charte graphique claire par défaut (alignée sur le thème clair Octopus Energy),
 * positionné proprement en bas à droite de la zone compte (à gauche de Kraken Phone et de la scrollbar,
 * loin des boutons d'action "Modifier le portfolio"), et masqué automatiquement dès que le volet latéral est ouvert.
 * Conforme Manifest V3 et politiques de sécurité d'entreprise (zéro innerHTML).
 */
(function initKrakenLauncher() {
  // Nettoyer tout ancien bouton inline éventuel dans le document ou les iframes
  function cleanupLegacyInlineButtons() {
    try {
      const oldInline = document.getElementById("octopus-recap-inline-btn");
      if (oldInline) oldInline.remove();
      const iframes = document.querySelectorAll("iframe");
      for (const f of iframes) {
        try {
          const doc = f.contentDocument;
          const oldInFrame = doc && doc.getElementById("octopus-recap-inline-btn");
          if (oldInFrame) oldInFrame.remove();
        } catch (_) {}
      }
    } catch (_) {}
  }

  cleanupLegacyInlineButtons();

  // Le bouton flottant ne doit s'exécuter que dans la fenêtre principale (top)
  if (window !== window.top) {
    return;
  }

  const LAUNCHER_ID = "octopus-recap-floating-launcher";
  // Si une version précédente du bouton existe déjà (ex: après rechargement de l'extension), la supprimer pour recréer la nouvelle version propre
  const prevBtn = document.getElementById(LAUNCHER_ID);
  if (prevBtn) {
    prevBtn.remove();
  }

  let isSidePanelOpen = false;
  let currentTheme = "light"; // Charte graphique claire par défaut

  const ALLOWED_ACCOUNT_HASH_PREFIXES = [
    "#/details",
    "#/account-users",
    "#/account-events",
    "#/payments",
    "#/statements",
    "#/properties",
    "#/agreements",
    "#/devices",
    "#/costed-periods",
    "#/account-schemes-tab",
    "#/flow-status-tab",
    "#/octopus-devices-tab"
  ];

  /**
   * Vérifie strictement qu'on est sur l'un des onglets du compte client Kraken autorisés
   * (exclut les popups d'e-mail /accounts/.../emails/..., les pages de recherche, files d'attente, etc.)
   */
  function isClientContractPage() {
    if (window.opener && window.outerWidth > 0 && window.outerWidth < 900) {
      return false;
    }

    const path = window.location.pathname || "";
    const href = window.location.href || "";

    if (href.includes("/emails/") || href.includes("/partial/")) {
      return false;
    }

    const isMainAccountPath = /^(?:\/app)?\/accounts\/A-[A-Z0-9]+\/?$/i.test(path);
    if (!isMainAccountPath) {
      return false;
    }

    const hash = (window.location.hash || "").toLowerCase();
    if (!hash || hash === "#" || hash === "#/") {
      return true;
    }

    return ALLOWED_ACCOUNT_HASH_PREFIXES.some((prefix) => hash.startsWith(prefix));
  }

  function extractAccountNumber() {
    const m = (window.location.pathname || "").match(/\/accounts\/(A-[A-Z0-9]+)/i);
    return m ? m[1].toUpperCase() : null;
  }

  /**
   * Calcule le décalage à droite (en px) pour que le bouton se place toujours à gauche
   * de la colonne Kraken Phone (qu'elle soit repliée ~50px ou déployée ~285px) et de la barre de défilement,
   * sans jamais chevaucher ni Kraken Phone ni la scrollbar.
   */
  function getRightOffsetForKrakenLayout() {
    let rightBarWidth = 52; // Largeur minimale de la barre Kraken Phone repliée à droite
    try {
      const candidates = document.querySelectorAll("aside, [class*='phone'], [class*='Phone'], [class*='sidebar'], div");
      for (const el of candidates) {
        if (el.id === LAUNCHER_ID) continue;
        const rect = el.getBoundingClientRect();
        // Colonne latérale droite (Kraken Phone replié ~48-65px ou déployé ~240-420px) collée au bord droit de la fenêtre
        if (
          rect.height >= window.innerHeight * 0.5 &&
          rect.width >= 40 &&
          rect.width <= 450 &&
          Math.abs(window.innerWidth - rect.right) <= 8
        ) {
          const txt = (el.textContent || "").trim();
          const hasPhoneContent =
            txt.includes("Kraken Phone") ||
            txt.includes("Démarrer le téléphone") ||
            txt.includes("Progressive App") ||
            rect.width <= 72;
          if (hasPhoneContent && rect.width > rightBarWidth) {
            rightBarWidth = Math.round(rect.width);
          }
        }
      }
    } catch (_) {}

    // Ajouter 18px de marge à gauche de la barre Kraken Phone (pour laisser libre la barre de défilement)
    return rightBarWidth + 18;
  }

  function applyButtonTheme(btn, isHover = false) {
    if (!btn) return;
    const titleSpan = btn.querySelector("[data-role='title-label']");
    const subSpan = btn.querySelector("[data-role='account-label']");
    const iconWrap = btn.querySelector("[data-role='icon-wrap']");

    if (currentTheme === "dark") {
      btn.style.background = "linear-gradient(135deg, #180048 0%, #2D1A83 100%)";
      btn.style.color = "#F0FFFF";
      btn.style.borderColor = isHover ? "#F050F8" : "#60F0F8";
      btn.style.boxShadow = isHover
        ? "0 8px 22px rgba(240, 80, 248, 0.35)"
        : "0 6px 18px rgba(16, 0, 48, 0.32)";
      if (titleSpan) titleSpan.style.color = "#F0FFFF";
      if (subSpan) {
        subSpan.style.color = "#60F0F8";
        subSpan.style.background = "rgba(96, 240, 248, 0.14)";
        subSpan.style.borderColor = "rgba(96, 240, 248, 0.30)";
      }
      if (iconWrap) {
        iconWrap.style.background = "rgba(96, 240, 248, 0.14)";
      }
    } else {
      // Charte graphique claire par défaut (Octopus Light : #FFFFFF / #F0FFFF / #180048 / #0099C4 / #5840FF)
      btn.style.background = isHover
        ? "linear-gradient(135deg, #FFFFFF 0%, #E6F9FE 100%)"
        : "linear-gradient(135deg, #FFFFFF 0%, #F4FBFF 100%)";
      btn.style.color = "#180048";
      btn.style.borderColor = isHover ? "#5840FF" : "rgba(0, 153, 196, 0.45)";
      btn.style.boxShadow = isHover
        ? "0 8px 22px rgba(88, 64, 255, 0.22), 0 2px 6px rgba(24, 0, 72, 0.08)"
        : "0 6px 18px rgba(24, 0, 72, 0.12), 0 2px 6px rgba(0, 153, 196, 0.10)";
      if (titleSpan) titleSpan.style.color = "#180048";
      if (subSpan) {
        subSpan.style.color = "#0077A8";
        subSpan.style.background = "rgba(0, 200, 248, 0.14)";
        subSpan.style.borderColor = "rgba(0, 153, 196, 0.28)";
      }
      if (iconWrap) {
        iconWrap.style.background = "rgba(88, 64, 255, 0.10)";
      }
    }
  }

  function updateLauncherVisibilityAndPosition() {
    cleanupLegacyInlineButtons();

    const existing = document.getElementById(LAUNCHER_ID);

    if (!isClientContractPage()) {
      if (existing) existing.remove();
      return;
    }

    const btn = existing || createLauncherButton();
    const account = extractAccountNumber();
    const subSpan = btn.querySelector("[data-role='account-label']");
    if (subSpan) {
      subSpan.textContent = account || "Contrat";
    }

    applyButtonTheme(btn, false);

    // Masquer le bouton dès que le volet latéral est ouvert
    if (isSidePanelOpen) {
      btn.style.opacity = "0";
      btn.style.pointerEvents = "none";
      btn.style.transform = "translateY(12px) scale(0.95)";
    } else {
      const rightOffset = getRightOffsetForKrakenLayout();
      btn.style.right = `${rightOffset}px`;
      btn.style.opacity = "1";
      btn.style.pointerEvents = "auto";
      btn.style.transform = "translateY(0) scale(1)";
    }
  }

  function createLauncherButton() {
    const btn = document.createElement("button");
    btn.id = LAUNCHER_ID;
    btn.type = "button";
    btn.title = "Ouvrir le volet latéral Récapitulatif Contrat (Contrat, Conso, Mensualités, SGE)";
    btn.setAttribute("aria-label", "Ouvrir le récapitulatif contrat");

    // Placé en bas à droite de la zone compte (loin des boutons "Modifier le portfolio" en haut et à gauche de Kraken Phone)
    btn.style.cssText = [
      "position: fixed",
      "bottom: 24px",
      "right: 70px",
      "z-index: 2147483640",
      "display: flex",
      "align-items: center",
      "gap: 9px",
      "padding: 8px 13px 8px 10px",
      "border: 1.5px solid rgba(0, 153, 196, 0.45)",
      "border-radius: 12px",
      "cursor: pointer",
      "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      "text-align: left",
      "transition: opacity 0.2s ease, transform 0.2s ease, right 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease"
    ].join("; ");

    const iconWrap = document.createElement("span");
    iconWrap.setAttribute("data-role", "icon-wrap");
    iconWrap.style.cssText = [
      "width: 28px",
      "height: 28px",
      "border-radius: 8px",
      "display: inline-flex",
      "align-items: center",
      "justify-content: center",
      "font-size: 16px",
      "line-height: 1",
      "flex-shrink: 0"
    ].join("; ");
    iconWrap.textContent = "🐙";

    const textCol = document.createElement("span");
    textCol.style.cssText = "display: flex; flex-direction: column; gap: 2px; line-height: 1.15;";

    const titleSpan = document.createElement("span");
    titleSpan.setAttribute("data-role", "title-label");
    titleSpan.textContent = "Récap Client";
    titleSpan.style.cssText = "font-size: 12px; font-weight: 800; letter-spacing: -0.2px; white-space: nowrap;";

    const subSpan = document.createElement("span");
    subSpan.setAttribute("data-role", "account-label");
    subSpan.textContent = extractAccountNumber() || "Contrat";
    subSpan.style.cssText = [
      "font-size: 10px",
      "font-weight: 700",
      "padding: 1px 6px",
      "border-radius: 5px",
      "border: 1px solid rgba(0, 153, 196, 0.28)",
      "font-family: ui-monospace, SFMono-Regular, Menlo, monospace",
      "white-space: nowrap",
      "align-self: flex-start"
    ].join("; ");

    textCol.appendChild(titleSpan);
    textCol.appendChild(subSpan);
    btn.appendChild(iconWrap);
    btn.appendChild(textCol);

    applyButtonTheme(btn, false);

    btn.addEventListener("mouseenter", () => {
      if (isSidePanelOpen) return;
      applyButtonTheme(btn, true);
      btn.style.transform = "translateY(-2px) scale(1.01)";
    });

    btn.addEventListener("mouseleave", () => {
      if (isSidePanelOpen) return;
      applyButtonTheme(btn, false);
      btn.style.transform = "translateY(0) scale(1)";
    });

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const account = extractAccountNumber();

      // Masquer immédiatement le bouton à l'ouverture du volet
      isSidePanelOpen = true;
      updateLauncherVisibilityAndPosition();

      try {
        chrome.runtime.sendMessage({
          type: "OPEN_SIDE_PANEL",
          payload: {
            account: account,
            url: window.location.href
          }
        });
      } catch (_) {}
    });

    document.body.appendChild(btn);
    return btn;
  }

  // Initialiser l'état d'ouverture du volet latéral et le thème (clair par défaut)
  try {
    chrome.storage.local.get(["sidepanel_is_open", "recap_theme"], (res) => {
      if (res && typeof res.sidepanel_is_open === "boolean") {
        isSidePanelOpen = res.sidepanel_is_open;
      }
      currentTheme = res?.recap_theme === "dark" ? "dark" : "light";
      updateLauncherVisibilityAndPosition();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.sidepanel_is_open) {
        isSidePanelOpen = Boolean(changes.sidepanel_is_open.newValue);
      }
      if (changes.recap_theme) {
        currentTheme = changes.recap_theme.newValue === "dark" ? "dark" : "light";
      }
      updateLauncherVisibilityAndPosition();
    });
  } catch (_) {}

  window.addEventListener("hashchange", updateLauncherVisibilityAndPosition);
  window.addEventListener("popstate", updateLauncherVisibilityAndPosition);
  window.addEventListener("resize", updateLauncherVisibilityAndPosition);

  // Surveillance légère des changements d'URL SPA ou d'ouverture/fermeture de Kraken Phone
  setInterval(updateLauncherVisibilityAndPosition, 800);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updateLauncherVisibilityAndPosition, { once: true });
  } else {
    updateLauncherVisibilityAndPosition();
  }
})();

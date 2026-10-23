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

  // Une seule instance active par page : après un rechargement de l'extension, l'ancienne instance (orpheline)
  // continuait à tourner et masquait le bouton de la nouvelle. Chaque instance s'enregistre sur le document
  // et s'arrête dès qu'elle n'est plus la plus récente ou que son contexte d'extension est invalidé.
  const INSTANCE_ATTR = "data-octopus-recap-launcher";
  const instanceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  document.documentElement.setAttribute(INSTANCE_ATTR, instanceId);

  function isActiveInstance() {
    let contextValid = false;
    try {
      contextValid = Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {}
    return contextValid && document.documentElement.getAttribute(INSTANCE_ATTR) === instanceId;
  }

  let isSidePanelOpen = false;

  // Position choisie par le conseiller en faisant glisser le bouton (distances au coin bas-droit de la fenêtre),
  // mémorisée pour tous les onglets Kraken. null = placement automatique à gauche de Kraken Phone.
  const POSITION_STORAGE_KEY = "recap_launcher_position";
  const DRAG_THRESHOLD_PX = 4;
  // Hauteur par défaut : juste au-dessus de la flèche Kraken Phone (en bas à droite) et de son infobulle « Ouvrir »
  const DEFAULT_BOTTOM_PX = 76;
  let customPosition = null;
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
    if (!isActiveInstance()) {
      teardown();
      return;
    }

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
      if (customPosition) {
        const clamped = clampPosition(btn, customPosition.right, customPosition.bottom);
        btn.style.right = `${clamped.right}px`;
        btn.style.bottom = `${clamped.bottom}px`;
      } else {
        btn.style.right = `${getRightOffsetForKrakenLayout()}px`;
        btn.style.bottom = `${DEFAULT_BOTTOM_PX}px`;
      }
      btn.style.opacity = "1";
      btn.style.pointerEvents = "auto";
      btn.style.transform = "translateY(0) scale(1)";
    }
  }

  // Garde le bouton entièrement visible dans la fenêtre
  function clampPosition(btn, right, bottom) {
    const rect = btn.getBoundingClientRect();
    const maxRight = Math.max(0, window.innerWidth - rect.width);
    const maxBottom = Math.max(0, window.innerHeight - rect.height);
    return {
      right: Math.round(Math.min(Math.max(0, right), maxRight)),
      bottom: Math.round(Math.min(Math.max(0, bottom), maxBottom))
    };
  }

  /**
   * Rend le bouton déplaçable à la souris. Un simple clic (déplacement < 4 px) ouvre toujours le volet ;
   * un glisser déplace le bouton sans ouvrir le volet, et la position est enregistrée.
   */
  function makeDraggable(btn) {
    let dragStart = null;
    let isDragging = false;
    let suppressNextClick = false;

    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || isSidePanelOpen) return;
      const rect = btn.getBoundingClientRect();
      dragStart = {
        x: e.clientX,
        y: e.clientY,
        right: window.innerWidth - rect.right,
        bottom: window.innerHeight - rect.bottom
      };
      isDragging = false;
    });

    btn.addEventListener("pointermove", (e) => {
      if (!dragStart) return;
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      if (!isDragging) {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        isDragging = true;
        btn.setPointerCapture(e.pointerId);
        btn.style.transition = "none";
        btn.style.cursor = "grabbing";
      }
      customPosition = clampPosition(btn, dragStart.right - dx, dragStart.bottom - dy);
      btn.style.right = `${customPosition.right}px`;
      btn.style.bottom = `${customPosition.bottom}px`;
    });

    const endDrag = (e) => {
      if (!dragStart) return;
      dragStart = null;
      if (!isDragging) return;
      isDragging = false;
      suppressNextClick = true;
      try {
        btn.releasePointerCapture(e.pointerId);
      } catch (_) {}
      btn.style.transition = LAUNCHER_TRANSITION;
      btn.style.cursor = "pointer";
      try {
        chrome.storage.local.set({ [POSITION_STORAGE_KEY]: customPosition });
      } catch (_) {}
    };
    btn.addEventListener("pointerup", endDrag);
    btn.addEventListener("pointercancel", endDrag);

    // Empêcher l'ouverture du volet à la fin d'un glisser (capture : passe avant l'écouteur de clic principal)
    btn.addEventListener("click", (e) => {
      if (!suppressNextClick) return;
      suppressNextClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }

  const LAUNCHER_TRANSITION = "opacity 0.2s ease, transform 0.2s ease, right 0.2s ease, bottom 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease";

  function createLauncherButton() {
    const btn = document.createElement("button");
    btn.id = LAUNCHER_ID;
    btn.type = "button";
    btn.title = "Ouvrir le volet latéral Récapitulatif Contrat (Contrat, Conso, Mensualités, SGE) — glisser pour déplacer le bouton";
    btn.setAttribute("aria-label", "Ouvrir le récapitulatif contrat");

    // Placé en bas à droite de la zone compte (loin des boutons "Modifier le portfolio" en haut et à gauche de Kraken Phone)
    btn.style.cssText = [
      "position: fixed",
      `bottom: ${DEFAULT_BOTTOM_PX}px`,
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
      "touch-action: none",
      "user-select: none",
      `transition: ${LAUNCHER_TRANSITION}`
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
    makeDraggable(btn);

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

      // Réafficher le bouton si l'ouverture a échoué
      const restoreButton = () => {
        isSidePanelOpen = false;
        updateLauncherVisibilityAndPosition();
      };

      try {
        chrome.runtime.sendMessage({
          type: "OPEN_SIDE_PANEL",
          payload: {
            account: account,
            url: window.location.href
          }
        }, (response) => {
          if (chrome.runtime.lastError || !response || !response.success) {
            restoreButton();
          }
        });
      } catch (_) {
        restoreButton();
      }
    });

    document.body.appendChild(btn);
    return btn;
  }

  // Thème (clair par défaut) et état du volet latéral de CET onglet (fourni par le background)
  function readPosition(value) {
    return value && Number.isFinite(value.right) && Number.isFinite(value.bottom)
      ? { right: value.right, bottom: value.bottom }
      : null;
  }

  const onStorageChanged = (changes, area) => {
    if (area !== "local") return;
    if (changes.recap_theme) {
      currentTheme = changes.recap_theme.newValue === "dark" ? "dark" : "light";
    }
    if (changes[POSITION_STORAGE_KEY]) {
      customPosition = readPosition(changes[POSITION_STORAGE_KEY].newValue);
    }
    if (changes.recap_theme || changes[POSITION_STORAGE_KEY]) {
      updateLauncherVisibilityAndPosition();
    }
  };

  const onRuntimeMessage = (message, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message && message.type === "SIDE_PANEL_STATE" && typeof message.open === "boolean") {
      isSidePanelOpen = message.open;
      updateLauncherVisibilityAndPosition();
    }
  };

  try {
    chrome.storage.local.get(["recap_theme", POSITION_STORAGE_KEY], (res) => {
      currentTheme = res?.recap_theme === "dark" ? "dark" : "light";
      customPosition = readPosition(res?.[POSITION_STORAGE_KEY]);
      updateLauncherVisibilityAndPosition();
    });

    chrome.runtime.sendMessage({ type: "GET_SIDE_PANEL_STATE" }, (response) => {
      if (chrome.runtime.lastError) return;
      isSidePanelOpen = Boolean(response && response.open);
      updateLauncherVisibilityAndPosition();
    });

    chrome.storage.onChanged.addListener(onStorageChanged);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  } catch (_) {}

  window.addEventListener("hashchange", updateLauncherVisibilityAndPosition);
  window.addEventListener("popstate", updateLauncherVisibilityAndPosition);
  window.addEventListener("resize", updateLauncherVisibilityAndPosition);

  // Surveillance légère des changements d'URL SPA ou d'ouverture/fermeture de Kraken Phone
  const watchTimer = setInterval(updateLauncherVisibilityAndPosition, 800);

  // Arrêt complet d'une instance remplacée ou orpheline (sans toucher au bouton de l'instance active)
  function teardown() {
    clearInterval(watchTimer);
    window.removeEventListener("hashchange", updateLauncherVisibilityAndPosition);
    window.removeEventListener("popstate", updateLauncherVisibilityAndPosition);
    window.removeEventListener("resize", updateLauncherVisibilityAndPosition);
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch (_) {}
    // Si plus aucune instance valide ne gère la page, retirer le bouton devenu inactif
    if (!document.documentElement.getAttribute(INSTANCE_ATTR) || document.documentElement.getAttribute(INSTANCE_ATTR) === instanceId) {
      const orphanBtn = document.getElementById(LAUNCHER_ID);
      if (orphanBtn) orphanBtn.remove();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updateLauncherVisibilityAndPosition, { once: true });
  } else {
    updateLauncherVisibilityAndPosition();
  }
})();

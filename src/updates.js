/* 同一离线页面中的版本记录路由，保留游戏的滚动位置和键盘焦点。 */
(function () {
  "use strict";
  const gamePage = document.getElementById("game-page");
  const updatesPage = document.getElementById("updates-page");
  const updatesTitle = document.getElementById("updates-title");
  const gameTitle = document.title;
  let viewingUpdates = false;
  let initialized = false;
  let navigation = 0;
  let gameScroll = { x: 0, y: 0 };
  let gameFocus = null;

  // 返回棋局时由本路由恢复滚动，避免浏览器将两个视图的历史滚动位置混用。
  if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";

  function changeView() {
    const nextUpdates = window.location.hash === "#updates";
    if (initialized && nextUpdates === viewingUpdates) return;
    const wasInitialized = initialized;
    if (nextUpdates && initialized) {
      gameScroll = { x: window.scrollX, y: window.scrollY };
      gameFocus = document.activeElement;
    }
    viewingUpdates = nextUpdates;
    initialized = true;
    const currentNavigation = ++navigation;
    gamePage.hidden = viewingUpdates;
    updatesPage.hidden = !viewingUpdates;
    document.querySelectorAll("[data-game-only]").forEach(element => { element.hidden = viewingUpdates; });
    document.querySelectorAll("[data-updates-only]").forEach(element => { element.hidden = !viewingUpdates; });
    document.querySelectorAll("[data-updates-link], [data-game-link]").forEach(link => {
      const current = link.hasAttribute("data-updates-link") ? viewingUpdates : !viewingUpdates;
      if (current) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    document.title = viewingUpdates ? `版本更新 · ${gameTitle}` : gameTitle;
    window.dispatchEvent(new CustomEvent("ludo:viewchange", { detail: { updates: viewingUpdates } }));

    if (!wasInitialized && !viewingUpdates) return;
    requestAnimationFrame(() => {
      if (currentNavigation !== navigation) return;
      if (viewingUpdates) {
        window.scrollTo({ left: 0, top: 0, behavior: "instant" });
        updatesTitle.focus({ preventScroll: true });
      } else {
        window.scrollTo({ left: gameScroll.x, top: gameScroll.y, behavior: "instant" });
        // 恢复棋局时可能出现延迟展示的结果弹窗，由弹窗继续持有焦点。
        if (!document.querySelector("dialog[open]")) {
          const target = gameFocus && gameFocus.isConnected && !gameFocus.closest("[hidden]")
            ? gameFocus : document.getElementById("roll-button");
          if (target) target.focus({ preventScroll: true });
        }
      }
    });
  }

  document.addEventListener("click", event => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest("a[data-updates-link], a[data-game-link]");
    if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
    event.preventDefault();
    const hash = link.hasAttribute("data-updates-link") ? "#updates" : "#game";
    if (window.location.hash !== hash) window.history.pushState(null, "", hash);
    changeView();
  });
  window.addEventListener("hashchange", changeView);
  window.addEventListener("popstate", changeView);
  changeView();
})();

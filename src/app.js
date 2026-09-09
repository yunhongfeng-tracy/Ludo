/* 网页控制器：真实状态由主线程持有，动画与策略不生成真实骰点。 */
(function () {
  "use strict";
  const E = window.LudoEngine;
  const AI = window.LudoAI;
  const $ = id => document.getElementById(id);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const names = ["你", "电脑"];
  const levelNames = { beginner: "初级", medium: "中级", advanced: "高级", ultimate: "终极" };
  const levelDescriptions = { beginner: "轻松练习", medium: "稳健出招", advanced: "推演应对", ultimate: "深思熟虑" };
  const aiClient = window.LudoAIClient.create($("ai-worker-source").textContent);
  const colors = ["#d66250", "#e6b647"];
  // 与 SVG 基地中的 80/160 中心对齐；渲染时统一加半格得到格心。
  const yardCells = [
    [{ row: 10.5, col: 1.5 }, { row: 10.5, col: 3.5 }, { row: 12.5, col: 1.5 }, { row: 12.5, col: 3.5 }],
    [{ row: 1.5, col: 10.5 }, { row: 1.5, col: 12.5 }, { row: 3.5, col: 10.5 }, { row: 3.5, col: 12.5 }]
  ];
  // 桌面切图的基地格心，坐标相对于 863×858 棋盘图；小屏 SVG 仍使用上面的网格坐标。
  const vintageYardCenters = [
    [[150.5, 611], [241.5, 611], [150.5, 701], [241.5, 701]],
    [[631, 140], [720, 140], [631, 228], [720, 228]]
  ];
  const tokenButtons = [[], []];
  const logEntries = [];
  const timers = new Set();
  let state = E.createGame(0);
  let difficulty = "ultimate";
  let started = false;
  let busy = false;
  let generation = 0;
  let revision = 0;
  let rollCount = 0;
  let captureCount = 0;
  let lastDie = null;
  let motion = null;
  let activity = "idle";
  let decisionRng = AI.createSeededRng(1);
  const soundPreferenceKey = "ludo.sound.enabled";
  let soundEnabled = true;
  try { soundEnabled = localStorage.getItem(soundPreferenceKey) !== "false"; } catch { /* 本地文件或隐私模式仍可使用本次开关。 */ }
  const sound = window.LudoSound.create();
  sound.setEnabled(soundEnabled);
  let soundRequest = 0;
  let soundUnlocking = null;
  let soundWarningShown = false;
  let lastDecision = null;
  let fatalError = null;
  let pendingCompletion = null;
  let rollingPlayer = null;
  let aiEpoch = 0;
  let compatibilityMode = false;
  let viewingUpdates = window.location.hash === "#updates";
  let resultAnnounced = false;
  let bonusReason = null;
  let bodyClassFrame = 0;
  let lobbyRenderFrame = 0;

  function cancelAI() {
    aiEpoch++;
    aiClient.cancel();
    if (activity === "thinking") { busy = false; activity = "idle"; }
  }

  function secureInt(limit) {
    if (!window.crypto || !window.crypto.getRandomValues) throw new Error("当前浏览器无法提供随机骰子，请使用新版 Chrome 或 Edge。");
    const values = new Uint32Array(1);
    const threshold = Math.floor(0x100000000 / limit) * limit;
    do { window.crypto.getRandomValues(values); } while (values[0] >= threshold);
    return values[0] % limit;
  }

  function later(fn, milliseconds) {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, milliseconds);
    timers.add(timer);
    return timer;
  }

  function delay(milliseconds) {
    // 动画等待不注册到会被清空的 timer 集合，旧链会在恢复后检查 generation。
    return new Promise(resolve => setTimeout(resolve, reducedMotion.matches ? 0 : milliseconds));
  }

  function clearScheduled() {
    timers.forEach(clearTimeout);
    timers.clear();
  }

  function completePending() {
    const complete = pendingCompletion;
    pendingCompletion = null;
    if (complete) complete();
  }

  function canPlaySound() {
    return soundEnabled && !document.hidden && !viewingUpdates && !$("restart-dialog").open && !$("rules-dialog").open;
  }

  function tone(kind, options) {
    if (!canPlaySound()) return;
    if (sound.isReady()) { sound.play(kind, options); return; }
    if (kind !== "roll" || !soundUnlocking) return;
    const currentGeneration = generation, currentRevision = revision, request = soundRequest;
    const endsAt = performance.now() + (options?.duration || 0) * 1000;
    // 设备恢复晚于点击时，只补当前仍在摇动的骰子，不补播过期动作。
    void soundUnlocking.then(ready => {
      const remaining = (endsAt - performance.now()) / 1000;
      if (ready && canPlaySound() && request === soundRequest && generation === currentGeneration &&
          revision === currentRevision && activity === "rolling" && remaining > 0) sound.play("roll", { duration: remaining });
    });
  }

  function unlockSound(preview = false) {
    if (!soundEnabled) return;
    const request = ++soundRequest;
    // 必须在用户手势中解锁；音频失败或等待不会阻塞开始游戏与真实骰点。
    const unlocking = sound.unlock();
    soundUnlocking = unlocking;
    void unlocking.then(ready => {
      if (request !== soundRequest || !soundEnabled) return;
      if (!ready) {
        soundEnabled = false; sound.setEnabled(false); setSoundIcon();
        if (!soundWarningShown) { soundWarningShown = true; log("当前浏览器暂时无法播放音效，仍可正常游戏。", null); }
      } else if (preview) tone("step");
    }).finally(() => { if (soundUnlocking === unlocking) soundUnlocking = null; });
  }

  function setSoundIcon() {
    $("sound-button").innerHTML = soundEnabled
      ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 4 4 7H1v6h3l4 3zM12 6a6 6 0 0 1 0 8M15 3a10 10 0 0 1 0 14"/></svg>'
      : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 4 4 7H1v6h3l4 3zM12 7l6 6M18 7l-6 6"/></svg>';
    const label = soundEnabled ? "关闭音效" : "开启音效";
    $("sound-button").setAttribute("aria-label", label);
    $("sound-button").setAttribute("aria-pressed", String(soundEnabled));
    $("sound-button").title = label;
  }

  function star(x, y, size, fill, stroke) {
    const points = Array.from({ length: 10 }, (_, i) => {
      const radius = i % 2 ? size * 0.45 : size;
      const angle = i * Math.PI / 5 - Math.PI / 2;
      return `${x + Math.cos(angle) * radius},${y + Math.sin(angle) * radius}`;
    }).join(" ");
    return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="1.2" stroke-linejoin="round"/>`;
  }

  function createBoard() {
    let svg = '<defs><filter id="paper-grain" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency=".62" numOctaves="3" seed="17" result="noise"/><feColorMatrix in="noise" type="saturate" values="0" result="mono"/><feComponentTransfer in="mono"><feFuncA type="table" tableValues="0 .12"/></feComponentTransfer></filter><linearGradient id="aged-paper" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f3e4bf"/><stop offset=".48" stop-color="#e8d4a9"/><stop offset="1" stop-color="#d5bd8d"/></linearGradient></defs>';
    svg += '<rect width="600" height="600" fill="url(#aged-paper)"/>';
    const quadrants = [
      { x: 0, y: 0, fill: "#6f9c57", dark: "#314a31", inactive: true },
      { x: 360, y: 0, fill: "#d8b43b", dark: "#6f5721", inactive: false },
      { x: 0, y: 360, fill: "#cc4835", dark: "#6d2a20", inactive: false },
      { x: 360, y: 360, fill: "#4d91a9", dark: "#254d5b", inactive: true }
    ];
    quadrants.forEach(q => {
      svg += `<rect x="${q.x}" y="${q.y}" width="240" height="240" fill="${q.fill}" stroke="#2d2920" stroke-width="2"/>`;
      svg += `<rect x="${q.x + 45}" y="${q.y + 45}" width="150" height="150" fill="#eadcb9" stroke="#2d2920" stroke-width="4"/>`;
      [80, 160].forEach(x => [80, 160].forEach(y => {
        svg += `<rect x="${q.x + x - 20}" y="${q.y + y - 20}" width="40" height="40" fill="${q.fill}" fill-opacity="${q.inactive ? '.92' : '.82'}" stroke="${q.dark}" stroke-width="2"/>`;
      }));
    });
    const startColors = { 0: "#cc4835", 13: "#6f9c57", 26: "#d8b43b", 39: "#4d91a9" };
    const arrowDirections = { 1: "up", 14: "left", 27: "down", 40: "right" };
    E.RING.forEach((cell, index) => {
      const x = cell.col * 40, y = cell.row * 40;
      const isSafe = E.SAFE_INDICES.includes(index);
      const fill = startColors[index] || "#eadbb8";
      svg += `<rect x="${x}" y="${y}" width="40" height="40" fill="${fill}" stroke="#2d302b" stroke-width="1.7"/>`;
      if (isSafe) svg += `<g data-safe-cell="${cell.cellId}">${star(x + 20, y + 20, 11, index in startColors ? "#eadbb8" : "none", "#335f58")}</g>`;
      if (arrowDirections[index]) {
        const direction = arrowDirections[index];
        const path = direction === "up" ? `M${x + 20} ${y + 30}V${y + 10}M${x + 12} ${y + 18}l8-8 8 8`
          : direction === "down" ? `M${x + 20} ${y + 10}v20M${x + 12} ${y + 22}l8 8 8-8`
          : direction === "right" ? `M${x + 10} ${y + 20}h20M${x + 22} ${y + 12}l8 8-8 8`
          : `M${x + 30} ${y + 20}H${x + 10}M${x + 18} ${y + 12}l-8 8 8 8`;
        svg += `<path d="${path}" fill="none" stroke="#3c392f" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"/>`;
      }
    });
    E.HOME_PATHS.forEach((path, player) => path.forEach(cell => {
      svg += `<rect x="${cell.col * 40}" y="${cell.row * 40}" width="40" height="40" fill="${player ? '#d5ae3e' : '#c84d37'}" stroke="#30302b" stroke-width="1.7"/>`;
    }));
    // 非参赛颜色保留棋盘结构，降低饱和度。
    for (let i = 1; i <= 5; i++) {
      svg += `<rect x="${i * 40}" y="280" width="40" height="40" fill="#6f9c57" stroke="#30302b" stroke-width="1.7"/>`;
      svg += `<rect x="${(14 - i) * 40}" y="280" width="40" height="40" fill="#4d91a9" stroke="#30302b" stroke-width="1.7"/>`;
    }
    svg += '<path d="M240 240 300 300 240 360Z" fill="#6f9c57"/><path d="M240 240 360 240 300 300Z" fill="#d8b43b"/><path d="M360 240 360 360 300 300Z" fill="#4d91a9"/><path d="M240 360 300 300 360 360Z" fill="#cc4835"/>';
    svg += '<path d="M240 240h120v120H240Z" fill="none" stroke="#2b2b26" stroke-width="3"/><path d="M240 240 360 360M360 240 240 360" stroke="#333029" stroke-width="1.5"/>';
    svg += '<g fill="#2f2a22" font-size="11" font-weight="700" font-family="Georgia,serif" letter-spacing=".5"><text x="300" y="266" text-anchor="middle">HOME</text><text x="300" y="343" text-anchor="middle">HOME</text><text x="265" y="304" text-anchor="middle" transform="rotate(90 265 300)">HOME</text><text x="335" y="304" text-anchor="middle" transform="rotate(-90 335 300)">HOME</text></g>';
    svg += '<rect width="600" height="600" fill="#5b3f27" opacity=".21" filter="url(#paper-grain)" pointer-events="none"/><rect x="4" y="4" width="592" height="592" fill="none" stroke="#5b321f" stroke-opacity=".22" stroke-width="8"/><path d="M300 0v600" stroke="#67442b" stroke-opacity=".38" stroke-width="2"/><path d="M303 0v600" stroke="#f4e5c2" stroke-opacity=".2"/><rect x="1.5" y="1.5" width="597" height="597" fill="none" stroke="#292019" stroke-width="3"/>';
    $("board-svg").innerHTML = svg;
    // 底图的四颗装饰星位置不符合规则，以同图邻近空白纸纹覆盖；不改动格线和箭头。
    // 坐标只描述 863×858 美术资产，实际安全格位置始终来自引擎，与棋子共用网格。
    const vintageStarRepairs = [
      { x: 221, y: 473, sampleX: 274, sampleY: 473 },
      { x: 383, y: 262, sampleX: 383, sampleY: 314 },
      { x: 650, y: 368, sampleX: 703, sampleY: 368 },
      { x: 490, y: 577, sampleX: 490, sampleY: 525 }
    ];
    $("board-star-repairs").innerHTML = vintageStarRepairs.map(({ x, y, sampleX, sampleY }) =>
      `<span class="board-star-repair" style="left:${x - 22}px;top:${y - 22}px;background-position:${22 - sampleX}px ${22 - sampleY}px"></span>`
    ).join("");
    $("board-safety").innerHTML = E.SAFE_INDICES.map(index => {
      const cell = E.RING[index];
      const fill = index in startColors ? "#eadbb8" : (cell.col > 7 ? "#b9c7bd" : "#b8c59b");
      return `<g data-safe-cell="${cell.cellId}">${star(cell.col * 40 + 20, cell.row * 40 + 20, 11, fill, "#3f5952")}</g>`;
    }).join("");
    for (let player = 0; player < 2; player++) {
      for (let token = 0; token < 4; token++) {
        const button = document.createElement("button");
        button.className = `token ${player ? "yellow" : "red"}`;
        button.id = `token-${player}-${token}`;
        button.dataset.player = player;
        button.dataset.token = token;
        const [yardX, yardY] = vintageYardCenters[player][token];
        button.style.setProperty("--yard-left", `${(yardX - 36) / 800 * 100}%`);
        button.style.setProperty("--yard-top", `${(yardY - 25) / 800 * 100}%`);
        button.innerHTML = `<span class="token-face">${token + 1}</span>`;
        button.addEventListener("click", () => { if (player === 0) { unlockSound(); performMove(token, false); } });
        tokenButtons[player].push(button);
        $("token-layer").appendChild(button);
      }
      $("dots-" + player).innerHTML = "<i></i>".repeat(4);
    }
  }

  function describePosition(progress) {
    if (progress === -1) return "在基地";
    if (progress === E.FINISH) return "已到家";
    if (progress > 50) return `归家通道，距终点 ${E.FINISH - progress} 步`;
    return `场内第 ${progress + 1} 格`;
  }

  function renderTokens() {
    const visual = motion ? motion.fromState : state;
    const locations = [];
    const groups = new Map();
    for (let player = 0; player < 2; player++) {
      for (let token = 0; token < 4; token++) {
        const isMoving = motion && motion.player === player && motion.token === token;
        const progress = isMoving ? motion.progress : visual.tokenProgress[player][token];
        const position = E.position(player, progress);
        const cell = progress === -1 ? yardCells[player][token] : position;
        const key = progress === -1 ? `yard-${player}-${token}` : position.cellId;
        const entry = { player, token, progress, cell, key, isMoving };
        locations.push(entry);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry);
      }
    }
    const legal = started && !busy && !viewingUpdates && state.activePlayer === 0 ? E.getLegalActions(state) : [];
    locations.forEach(entry => {
      const group = groups.get(entry.key);
      const slot = group.indexOf(entry);
      const count = group.length;
      let dx = 0, dy = 0;
      if (count > 1) {
        if (count === 2) dx = (slot - 0.5) * 0.4;
        else if (count === 3) { dx = [0, -0.19, 0.19][slot]; dy = [-0.22, 0.11, 0.11][slot]; }
        else if (count === 4) { dx = (slot % 2 - 0.5) * 0.36; dy = (Math.floor(slot / 2) - 0.5) * 0.36; }
        else { const angle = 2 * Math.PI * slot / count; dx = Math.cos(angle) * 0.3; dy = Math.sin(angle) * 0.3; }
      }
      const button = tokenButtons[entry.player][entry.token];
      const playable = entry.player === 0 && legal.includes(entry.token);
      button.style.left = `${(entry.cell.col + 0.5 + dx) / 15 * 100}%`;
      button.style.top = `${(entry.cell.row + 0.5 + dy) / 15 * 100}%`;
      button.className = `token ${entry.player ? "yellow" : "red"}${entry.progress === -1 ? " in-yard" : ""}${count > 1 ? " stacked" : ""}${entry.progress === E.FINISH ? " finished" : ""}${entry.isMoving ? " moving" : ""}${playable ? " legal" : ""}`;
      button.disabled = !playable;
      button.setAttribute("aria-label", `${names[entry.player]}的${entry.token + 1}号棋子，${describePosition(entry.progress)}${playable ? "，可以移动" : ""}`);
      button.title = `${names[entry.player]}的 ${entry.token + 1} 号棋子 · ${describePosition(entry.progress)}`;
    });
  }

  function renderDice() {
    const mapping = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
    const rolling = activity === "rolling";
    const visible = rolling ? [] : mapping[lastDie || 5];
    $("dice-dots").innerHTML = Array.from({ length: 9 }, (_, index) => `<i${visible.includes(index) ? ' class="visible"' : ""}></i>`).join("");
    $("dice").setAttribute("aria-label", rolling ? "正在掷骰，等待结果" : lastDie ? `骰子 ${lastDie} 点` : "尚未掷骰");
    $("dice").setAttribute("aria-busy", String(rolling));
    $("dice").classList.toggle("rolling", rolling);
  }

  function log(message, player) {
    logEntries.unshift({ message, player });
    if (logEntries.length > 12) logEntries.pop();
    const list = $("activity-list");
    list.replaceChildren();
    logEntries.forEach(entry => {
      const item = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = `log-dot${entry.player === 0 ? " red" : entry.player === 1 ? " yellow" : ""}`;
      const text = document.createElement("span"); text.textContent = entry.message;
      item.append(dot, text); list.appendChild(item);
    });
    list.scrollTop = 0;
    $("announcer").textContent = message;
  }

  function render() {
    renderTokens(); renderDice();
    const playing = started;
    if (document.body.classList.contains("playing") !== playing) {
      cancelAnimationFrame(bodyClassFrame);
      bodyClassFrame = requestAnimationFrame(() => {
        bodyClassFrame = 0;
        if (started === playing) document.body.classList.toggle("playing", playing);
      });
    }
    const mobileLegal = started && !busy && !viewingUpdates && state.activePlayer === 0 ? E.getLegalActions(state) : [];
    document.querySelectorAll("[data-move]").forEach(button => { button.disabled = !mobileLegal.includes(Number(button.dataset.move)); });
    const visual = motion ? motion.fromState : state;
    for (let player = 0; player < 2; player++) {
      const finished = visual.tokenProgress[player].filter(p => p === E.FINISH).length;
      $("finished-" + player).textContent = finished;
      Array.from($("dots-" + player).children).forEach((dot, index) => dot.classList.toggle("done", index < finished));
    }
    $("opponent-name").textContent = `电脑 · ${levelNames[difficulty]}`;
    $("opponent-level").textContent = compatibilityMode ? "兼容模式" : levelDescriptions[difficulty];
    document.querySelectorAll("[data-difficulty]").forEach(button => {
      button.disabled = started;
      const selected = button.dataset.difficulty === difficulty;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    $("difficulty-note").textContent = started ? "重新开始可更换难度" : "从容入门，或认真较量";
    $("restart-button").disabled = !started && !fatalError;
    let title, description, label, owner, footnote, badge;
    let enabled = false;
    if (fatalError) {
      title = "暂时无法继续"; description = fatalError; label = "请重新开始"; owner = "棋局已暂停"; badge = "需要重新开始"; footnote = "本次未额外掷骰或改变棋规。";
    } else if (!started) {
       title = "来掷第一颗骰子"; description = "先手随机 · 离线可玩"; label = "开始对局"; owner = "准备就绪"; badge = "等待开局"; footnote = "先手随机决定，双方使用同一颗公平骰子。"; enabled = true;
    } else if (busy) {
      const actor = motion ? motion.player : rollingPlayer ?? state.activePlayer;
      title = activity === "thinking" ? "对手正在思考" : activity === "rolling" ? "骰子转起来了" : "棋子向前一步步";
      description = activity === "thinking" ? "正在推演后续局面，寻找更好的走法。" : activity === "rolling" ? "好运气，也需要一点耐心。" : "走过每一格，离终点再近一点。";
      label = activity === "thinking" ? "等待电脑行动" : activity === "rolling" ? "正在掷骰…" : "正在移动…";
      owner = `${names[actor]}的回合`; badge = label; footnote = "落在星标安全格，可以暂避锋芒。";
    } else if (state.phase === "finished") {
      title = state.winner === 0 ? "这局，你赢了！" : "好棋，下局再来";
      description = state.winner === 0 ? "四枚棋子全部到家，漂亮！" : "电脑先将四枚棋子送到了终点。";
      label = "再来一局"; owner = "对局结束"; badge = state.winner === 0 ? "你获胜了" : "电脑获胜"; footnote = "每一局，都是一次新的开始。"; enabled = true;
    } else if (state.activePlayer === 1) {
      title = "对手正在思考"; description = "看看它会选择哪一步。"; label = "等待电脑行动"; owner = "电脑的回合"; badge = "电脑回合"; footnote = "你执红色，电脑执黄色。";
      if (state.phase === "awaitingRoll" && bonusReason) { title = "对手可以再掷一次"; description = `${bonusReason}，电脑获得一次再掷机会。`; }
    } else if (state.phase === "awaitingMove") {
      title = "选一枚棋子出发"; description = `掷出了 ${state.pendingDie} 点，点击带箭头和外圈的红色棋子。`; label = "点击带箭头的红色棋子"; owner = "你的回合"; badge = "请选择棋子"; footnote = "也可以用 Tab 选择棋子，按 Enter 移动。";
    } else {
      const again = Boolean(bonusReason) || state.consecutiveSixes > 0;
      title = again ? "再掷一次，继续出发" : "轮到你了"; description = again ? `${bonusReason || "掷出 6"}，获得一次再掷机会。` : "点击下方按钮，掷出你的下一步。"; label = "掷骰子"; owner = "你的回合"; badge = "你的回合"; footnote = again ? "同一步奖励不叠加；连续第三个 6 结束回合。" : "掷出 6，可以让一枚棋子离开基地。"; enabled = true;
    }
    $("status-title").textContent = title;
    $("status-title").classList.toggle("compact-title", title.length > 7);
    $("status-description").textContent = description;
    $("status-description").classList.toggle("error-notice", Boolean(fatalError));
    $("roll-label").textContent = label;
    $("roll-button").classList.toggle("compact-label", label.length > 7);
    $("turn-owner").textContent = owner;
    $("turn-footnote").textContent = footnote;
    $("roll-button").disabled = !enabled || viewingUpdates;
    $("roll-counter").textContent = started ? `${String(rollCount).padStart(2, "0")} ROLLS` : "LET’S PLAY";
    $("turn-badge").innerHTML = `<i></i>${badge}`;
    $("turn-badge").classList.toggle("your-turn", started && !busy && state.activePlayer === 0 && state.phase !== "finished");
  }

  function fail(error) {
    sound.stop();
    cancelAI();
    console.error(error);
    fatalError = error instanceof Error ? error.message : String(error);
    busy = false; motion = null; activity = "idle"; pendingCompletion = null; rollingPlayer = null;
    clearScheduled(); render();
    log("棋局暂停，请重新开始。", null);
  }

  function resetToLobby() {
    soundRequest++; sound.stop();
    cancelAI(); compatibilityMode = false;
    generation++; revision++; clearScheduled();
    state = E.createGame(0); started = false; busy = false; lastDie = null; motion = null;
    fatalError = null; activity = "idle"; rollCount = 0; captureCount = 0; lastDecision = null;
    pendingCompletion = null; rollingPlayer = null; resultAnnounced = false; bonusReason = null;
    logEntries.length = 0;
    document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
    const currentGeneration = generation;
    cancelAnimationFrame(lobbyRenderFrame);
    lobbyRenderFrame = requestAnimationFrame(() => {
      lobbyRenderFrame = 0;
      if (generation !== currentGeneration || started) return;
      log("新棋盘准备好了，选择难度后开始。", null);
      render();
      $("roll-button").focus({ preventScroll: true });
    });
  }

  function beginGame() {
    if (viewingUpdates || started || busy) return;
    try {
      cancelAI(); compatibilityMode = false;
      generation++; revision++;
      state = E.createGame(secureInt(2));
      decisionRng = AI.createSeededRng(secureInt(0x100000000));
      started = true; rollCount = 0; captureCount = 0; fatalError = null; lastDie = null; resultAnnounced = false; bonusReason = null;
      log(`棋局开始，${names[state.activePlayer]}先手。`, state.activePlayer);
      render(); scheduleAI();
    } catch (error) { fail(error); }
  }

  function scheduleAI() {
    if (viewingUpdates || !started || busy || fatalError || state.phase === "finished" || state.activePlayer !== 1) return;
    const currentGeneration = generation;
    later(() => {
      if (viewingUpdates || generation !== currentGeneration || busy || state.activePlayer !== 1 || fatalError) return;
      if (document.hidden) return;
      if (state.phase === "awaitingRoll") performRoll(true);
      else if (state.phase === "awaitingMove") chooseComputerMove();
    }, reducedMotion.matches ? 30 : (difficulty === "advanced" || difficulty === "ultimate") ? 180 : 600);
  }

  async function chooseComputerMove() {
    if (viewingUpdates || !started || busy || fatalError || document.hidden || state.activePlayer !== 1 || state.phase !== "awaitingMove") return;
    const currentGeneration = generation, currentRevision = revision;
    const requestEpoch = ++aiEpoch;
    const level = difficulty;
    const current = () => generation === currentGeneration && revision === currentRevision &&
      aiEpoch === requestEpoch && started && state.activePlayer === 1 && state.phase === "awaitingMove" && !document.hidden && !viewingUpdates;
    let fallback;
    try {
      const searching = level === "advanced" || level === "ultimate";
      // 主线程预先准备中级备用动作。唯一后继和立即获胜不需要启动搜索。
      fallback = AI.chooseAction(state, searching ? "medium" : level, decisionRng);
      let decision = fallback;
      if (searching && fallback.diagnostics.uniqueSuccessors > 1 && fallback.diagnostics.stopReason !== "immediate-win") {
        busy = true; activity = "thinking"; render();
        try {
          decision = await aiClient.choose(E.cloneState(state), level, {
            gameId: currentGeneration, stateRevision: currentRevision,
            strategyVersion: AI.STRATEGY_VERSION, evaluationVersion: AI.EVALUATION_VERSION,
            legalActions: E.getLegalActions(state)
          });
          if (!current() || decision.cancelled) return;
          compatibilityMode = false;
        } catch (error) {
          if (!current()) return;
          decision = { ...fallback, diagnostics: { ...fallback.diagnostics, difficulty: level,
            execution: "main-fallback", fallback: true, fallbackReason: error.code || "worker-unavailable" } };
          if (!compatibilityMode) log("计算线程暂不可用，已用中级策略继续本步。", 1);
          compatibilityMode = true;
        }
      } else if (searching) {
        decision = { ...fallback, diagnostics: { ...fallback.diagnostics, difficulty: level, execution: "forced-move" } };
      }
      if (!current()) return;
      busy = false; activity = "idle";
      if (!decision || !E.getLegalActions(state).includes(decision.action)) throw new Error("策略返回了非法走法");
      lastDecision = decision;
      performMove(decision.action, true);
    } catch (error) {
      if (!current()) return;
      busy = false; activity = "idle";
      const legal = E.getLegalActions(state);
      if (!legal.length) { fail(error); return; }
      lastDecision = { action: fallback && legal.includes(fallback.action) ? fallback.action : legal[0],
        reason: "使用合法备用走法", diagnostics: { difficulty: level, fallback: true, fallbackReason: "decision-error" } };
      log("电脑已使用备用走法继续。", 1);
      performMove(lastDecision.action, true);
    }
  }

  async function performRoll(isAI) {
    if (viewingUpdates || !started || busy || fatalError || state.phase !== "awaitingRoll" || state.activePlayer !== (isAI ? 1 : 0)) return;
    const currentGeneration = generation;
    const player = state.activePlayer;
    const previousSixes = state.consecutiveSixes;
    try {
      busy = true; activity = "rolling"; rollingPlayer = player; bonusReason = null;
      const die = secureInt(6) + 1;
      rollCount++;
      state = E.applyRoll(state, die); revision++;
      pendingCompletion = () => {
        lastDie = die;
        busy = false; activity = "idle"; rollingPlayer = null;
        bonusReason = state.phase === "awaitingRoll" && state.activePlayer === player && die === 6 ? "掷出 6" : null;
        if (die === 6 && previousSixes === 2) log(`${names[player]}连续第三次掷出 6，本次跳过。`, player);
        else if (state.phase === "awaitingRoll") log(`${names[player]}掷出 ${die}，没有可移动的棋子${die === 6 ? "，可以再掷" : ""}。`, player);
        else log(`${names[player]}掷出 ${die} 点。`, player);
        render(); scheduleAI();
      };
      render();
      // 骰点只生成一次，等骰子的实际动画结束再公布；重开导致的取消由 generation 拦截。
      const animation = $("dice").getAnimations().find(item => item.animationName === "dice-roll");
      tone("roll", { duration: animation ? animation.effect.getComputedTiming().activeDuration / 1000 : 0 });
      if (animation) await animation.finished.catch(() => {});
      if (generation !== currentGeneration) return;
      completePending();
    } catch (error) { if (generation === currentGeneration) fail(error); }
  }

  async function performMove(token, isAI) {
    if (viewingUpdates || !started || busy || fatalError || state.phase !== "awaitingMove" || state.activePlayer !== (isAI ? 1 : 0)) return;
    if (!E.getLegalActions(state).includes(token)) return;
    const currentGeneration = generation;
    const before = E.cloneState(state);
    const player = before.activePlayer;
    const from = before.tokenProgress[player][token];
    try {
      busy = true; activity = "moving";
      state = E.applyAction(before, token); revision++;
      const to = state.tokenProgress[player][token];
      const captured = before.tokenProgress[1 - player].filter((progress, index) => progress >= 0 && state.tokenProgress[1 - player][index] === -1).length;
      motion = { fromState: before, player, token, progress: from };
      pendingCompletion = () => {
        motion = null; busy = false; activity = "idle";
        let message = from === -1 ? `${names[player]}的 ${token + 1} 号棋子出营。` : `${names[player]}的 ${token + 1} 号棋子前进 ${before.pendingDie} 格。`;
        if (captured) { message = `${names[player]}吃掉了 ${captured} 枚对方棋子。`; captureCount++; tone("capture"); }
        else if (to === E.FINISH) { message = `${names[player]}的 ${token + 1} 号棋子到家了！`; tone("finish"); }
        bonusReason = state.phase !== "finished" && state.activePlayer === player
          ? (captured ? "吃掉对方棋子" : to === E.FINISH ? "棋子到达 HOME 终点" : "掷出 6") : null;
        if (bonusReason && (captured || to === E.FINISH)) message += " 获得一次额外掷骰机会。";
        log(message, player); render();
        if (state.phase === "finished") showResult();
        else scheduleAI();
      };
      render();
      const steps = from === -1 ? [0] : Array.from({ length: to - from }, (_, i) => from + i + 1);
      for (const progress of steps) {
        await delay(110);
        if (generation !== currentGeneration) return;
        motion.progress = progress; renderTokens();
        if (!reducedMotion.matches || progress === to) tone("step");
      }
      await delay(120);
      if (generation !== currentGeneration) return;
      completePending();
    } catch (error) { if (generation === currentGeneration) fail(error); }
  }

  function showResult() {
    if (viewingUpdates) return;
    const won = state.winner === 0;
    $("result-title").textContent = won ? "这一局，赢得漂亮！" : "好棋，我们下局再见";
    $("result-description").textContent = won ? "你的四枚红色棋子全部到家了。运气与巧思，这次都站在你这边。" : "电脑的四枚棋子先到达了终点。调整一下策略，再来一局吧。";
    $("result-eyebrow").textContent = won ? "VICTORY IS YOURS" : "WELL PLAYED";
    $("result-rolls").textContent = rollCount;
    $("result-captures").textContent = captureCount;
    if (!$("result-dialog").open) $("result-dialog").showModal();
    if (!resultAnnounced) {
      resultAnnounced = true;
      if (won) tone("win");
      log(won ? "你赢得了本局！" : "电脑赢得了本局。", state.winner);
    }
  }

  $("roll-button").addEventListener("click", () => {
    if (viewingUpdates) return;
    unlockSound();
    if (!started) beginGame();
    else if (state.phase === "finished") resetToLobby();
    else performRoll(false);
  });
  document.querySelectorAll("[data-difficulty]").forEach(button => button.addEventListener("click", () => {
    if (viewingUpdates || started) return;
    difficulty = button.dataset.difficulty;
    render();
  }));
  $("rules-button").addEventListener("click", () => { sound.stop(); $("rules-dialog").showModal(); });
  document.querySelectorAll("[data-move]").forEach(button => button.addEventListener("click", () => { unlockSound(); performMove(Number(button.dataset.move), false); }));
  function requestRestart() {
    sound.stop();
    requestAnimationFrame(() => { if (started && !$("restart-dialog").open) $("restart-dialog").showModal(); });
  }
  $("restart-button").addEventListener("click", requestRestart);
  $("mobile-restart").addEventListener("click", requestRestart);
  $("confirm-restart").addEventListener("click", resetToLobby);
  $("play-again").addEventListener("click", resetToLobby);
  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => $(button.dataset.close).close()));
  $("sound-button").addEventListener("click", () => {
    soundRequest++;
    soundEnabled = !soundEnabled;
    sound.setEnabled(soundEnabled);
    try { localStorage.setItem(soundPreferenceKey, String(soundEnabled)); } catch { /* 存储失败不影响本次静音。 */ }
    setSoundIcon();
    if (soundEnabled) unlockSound(true);
  });
  document.addEventListener("visibilitychange", () => {
    clearScheduled();
    if (document.hidden) { soundRequest++; sound.stop(); }
    if (document.hidden && activity === "thinking") { cancelAI(); render(); }
    if (!document.hidden && !busy) scheduleAI();
  });
  window.addEventListener("ludo:viewchange", event => {
    viewingUpdates = event.detail.updates;
    clearScheduled();
    if (viewingUpdates) {
      soundRequest++; sound.stop();
      // 保留已经提交的骰点与走法，让动画链恰好收尾一次，只取消下一步与未完成的搜索。
      cancelAI();
      document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
    }
    render();
    if (!viewingUpdates) {
      if (!busy && state.phase === "finished" && !resultAnnounced) showResult();
      else scheduleAI();
    }
  });
  window.addEventListener("pagehide", () => {
    soundRequest++; sound.stop();
    // 已提交的骰子与走法保留，只中断展示，返回页面后恰好收尾一次。
    cancelAI(); generation++; clearScheduled();
    busy = false; motion = null; activity = "idle"; rollingPlayer = null;
  });
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    clearScheduled();
    if (pendingCompletion) completePending();
    else { render(); scheduleAI(); }
  });

  // 只读快照用于浏览器验收，不能通过此接口写入局面或控制真实骰点。
  Object.defineProperty(window, "LudoGame", { value: Object.freeze({
    snapshot: () => ({ state: E.cloneState(state), started, busy, difficulty, generation, revision, rollCount, captureCount, lastDie, activity, viewingUpdates, error: fatalError }),
    diagnostics: () => lastDecision ? JSON.parse(JSON.stringify(lastDecision)) : null,
    workerStatus: () => aiClient.status()
  }), writable: false, configurable: false });
  createBoard(); setSoundIcon(); render();
})();

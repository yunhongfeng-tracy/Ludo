/* Ludo 基础棋规：纯函数内核，可在浏览器、Worker 和 Node 中共用。 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LudoEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var RULESET_ID = "basic-ludo-1v1@1";
  var BOARD_VERSION = 1;
  var FINISH = 56;
  var START_OFFSETS = Object.freeze([0, 26]);
  var SAFE_INDICES = Object.freeze([0, 8, 13, 21, 26, 34, 39, 47]);
  var PHASES = Object.freeze(["awaitingRoll", "awaitingMove", "finished"]);

  // 先列出完整环路，再旋转到左下红方起点；共 52 个唯一物理格。
  var baseRing = [
    [6, 1], [6, 2], [6, 3], [6, 4], [6, 5],
    [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6], [0, 7], [0, 8],
    [1, 8], [2, 8], [3, 8], [4, 8], [5, 8],
    [6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14], [7, 14], [8, 14],
    [8, 13], [8, 12], [8, 11], [8, 10], [8, 9],
    [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8], [14, 7], [14, 6],
    [13, 6], [12, 6], [11, 6], [10, 6], [9, 6],
    [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0], [7, 0], [6, 0]
  ];
  var RING = Object.freeze(baseRing.slice(39).concat(baseRing.slice(0, 39)).map(function (point, index) {
    return Object.freeze({ row: point[0], col: point[1], cellId: "ring-" + index });
  }));
  var HOME_PATHS = Object.freeze([
    Object.freeze([13, 12, 11, 10, 9].map(function (row, index) {
      return Object.freeze({ row: row, col: 7, cellId: "home-0-" + index });
    })),
    Object.freeze([1, 2, 3, 4, 5].map(function (row, index) {
      return Object.freeze({ row: row, col: 7, cellId: "home-1-" + index });
    }))
  ]);
  var FINISH_CELLS = Object.freeze([
    Object.freeze({ row: 8, col: 7, cellId: "finish-0" }),
    Object.freeze({ row: 6, col: 7, cellId: "finish-1" })
  ]);
  var safeCellIds = Object.create(null);
  SAFE_INDICES.forEach(function (index) { safeCellIds["ring-" + index] = true; });
  HOME_PATHS.forEach(function (path) {
    path.forEach(function (cell) { safeCellIds[cell.cellId] = true; });
  });
  FINISH_CELLS.forEach(function (cell) { safeCellIds[cell.cellId] = true; });
  Object.freeze(safeCellIds);

  function assert(condition, message) {
    if (!condition) throw new Error("LudoEngine: " + message);
  }

  function isPlayer(player) {
    return player === 0 || player === 1;
  }

  function isProgress(progress) {
    return Number.isInteger(progress) && progress >= -1 && progress <= FINISH;
  }

  function allFinished(tokens) {
    return tokens.every(function (progress) { return progress === FINISH; });
  }

  // 仅供内部使用，调用方已完成状态验证。
  function legalActions(state) {
    if (state.phase !== "awaitingMove") return [];
    var die = state.pendingDie;
    var tokens = state.tokenProgress[state.activePlayer];
    var result = [];
    for (var tokenId = 0; tokenId < 4; tokenId += 1) {
      var progress = tokens[tokenId];
      if ((progress === -1 && die === 6) ||
          (progress >= 0 && progress < FINISH && progress + die <= FINISH)) {
        result.push(tokenId);
      }
    }
    return result;
  }

  function validateState(state) {
    assert(state !== null && typeof state === "object" && !Array.isArray(state), "状态必须是对象");
    assert(state.rulesetId === RULESET_ID, "不支持的棋规版本");
    assert(state.boardVersion === BOARD_VERSION, "不支持的棋盘版本");
    assert(isPlayer(state.activePlayer), "活动玩家必须为 0 或 1");
    assert(PHASES.indexOf(state.phase) !== -1, "未知对局阶段");
    assert(Number.isInteger(state.consecutiveSixes) && state.consecutiveSixes >= 0 && state.consecutiveSixes <= 2,
      "连续 6 的计数必须为 0 到 2");
    assert(Array.isArray(state.tokenProgress) && state.tokenProgress.length === 2, "棋盘必须包含双方棋子");
    state.tokenProgress.forEach(function (tokens) {
      assert(Array.isArray(tokens) && tokens.length === 4, "每方必须恰好有 4 枚棋子");
      for (var index = 0; index < 4; index += 1) {
        assert(isProgress(tokens[index]), "棋子进度必须为 -1 到 56 的整数");
      }
    });
    assert(state.winner === null || isPlayer(state.winner), "获胜方必须为空、0 或 1");
    if (state.phase === "finished") {
      assert(isPlayer(state.winner), "结束状态必须有获胜方");
      assert(state.activePlayer === state.winner, "结束状态的活动玩家必须为获胜方");
      assert(allFinished(state.tokenProgress[state.winner]), "获胜方必须四子到家");
      assert(!allFinished(state.tokenProgress[1 - state.winner]), "双方不能同时获胜");
      assert(state.pendingDie === null && state.consecutiveSixes === 0, "结束状态必须清空骰点和连续计数");
    } else {
      assert(state.winner === null, "未结束状态不能有获胜方");
      assert(!allFinished(state.tokenProgress[0]) && !allFinished(state.tokenProgress[1]), "四子到家后必须立即结束");
      if (state.phase === "awaitingRoll") {
        assert(state.pendingDie === null, "等待掷骰时不能有待结算骰点");
      } else {
        assert(Number.isInteger(state.pendingDie) && state.pendingDie >= 1 && state.pendingDie <= 6,
          "待结算骰点必须为 1 到 6");
        assert(state.pendingDie === 6 ? state.consecutiveSixes >= 1 : state.consecutiveSixes === 0,
          "骰点与连续 6 计数不一致");
        assert(legalActions(state).length > 0, "无合法动作的骰点应当自动结算");
      }
    }
    return true;
  }

  function copyState(state) {
    return {
      rulesetId: state.rulesetId,
      boardVersion: state.boardVersion,
      activePlayer: state.activePlayer,
      phase: state.phase,
      pendingDie: state.pendingDie,
      consecutiveSixes: state.consecutiveSixes,
      tokenProgress: [state.tokenProgress[0].slice(), state.tokenProgress[1].slice()],
      winner: state.winner
    };
  }

  function createGame(firstPlayer) {
    if (firstPlayer === undefined) firstPlayer = 0;
    assert(isPlayer(firstPlayer), "先手必须为 0 或 1");
    return {
      rulesetId: RULESET_ID,
      boardVersion: BOARD_VERSION,
      activePlayer: firstPlayer,
      phase: "awaitingRoll",
      pendingDie: null,
      consecutiveSixes: 0,
      tokenProgress: [[-1, -1, -1, -1], [-1, -1, -1, -1]],
      winner: null
    };
  }

  function cloneState(state) {
    validateState(state);
    return copyState(state);
  }

  function getLegalActions(state) {
    validateState(state);
    return legalActions(state);
  }

  // 操作尚未对外返回的新副本，结算后清空待用骰点。
  function consumeDie(next, die) {
    next.phase = "awaitingRoll";
    next.pendingDie = null;
    if (die !== 6) {
      next.activePlayer = 1 - next.activePlayer;
      next.consecutiveSixes = 0;
    }
    return next;
  }

  function applyRoll(state, die) {
    validateState(state);
    assert(state.phase === "awaitingRoll", "仅等待掷骰时可以掷骰");
    assert(Number.isInteger(die) && die >= 1 && die <= 6, "骰点必须为 1 到 6 的整数");
    var next = copyState(state);
    if (die === 6 && next.consecutiveSixes === 2) {
      next.activePlayer = 1 - next.activePlayer;
      next.consecutiveSixes = 0;
      return next;
    }
    next.consecutiveSixes = die === 6 ? next.consecutiveSixes + 1 : 0;
    next.pendingDie = die;
    next.phase = "awaitingMove";
    if (legalActions(next).length === 0) consumeDie(next, die);
    return next;
  }

  function applyAction(state, tokenId) {
    validateState(state);
    assert(state.phase === "awaitingMove", "仅等待走棋时可以移动棋子");
    assert(Number.isInteger(tokenId) && legalActions(state).indexOf(tokenId) !== -1, "不是当前合法棋子");
    var next = copyState(state);
    var player = next.activePlayer;
    var die = next.pendingDie;
    var oldProgress = next.tokenProgress[player][tokenId];
    var newProgress = oldProgress === -1 ? 0 : oldProgress + die;
    next.tokenProgress[player][tokenId] = newProgress;

    if (newProgress <= 50) {
      var targetIndex = (START_OFFSETS[player] + newProgress) % RING.length;
      if (SAFE_INDICES.indexOf(targetIndex) === -1) {
        var opponent = 1 - player;
        for (var enemyId = 0; enemyId < 4; enemyId += 1) {
          var enemyProgress = next.tokenProgress[opponent][enemyId];
          if (enemyProgress >= 0 && enemyProgress <= 50 &&
              (START_OFFSETS[opponent] + enemyProgress) % RING.length === targetIndex) {
            next.tokenProgress[opponent][enemyId] = -1;
          }
        }
      }
    }

    if (allFinished(next.tokenProgress[player])) {
      next.phase = "finished";
      next.pendingDie = null;
      next.consecutiveSixes = 0;
      next.winner = player;
      return next;
    }
    return consumeDie(next, die);
  }

  function getTerminalResult(state) {
    validateState(state);
    return state.winner;
  }

  function position(player, progress) {
    assert(isPlayer(player), "阵营必须为 0 或 1");
    assert(isProgress(progress), "棋子进度必须为 -1 到 56 的整数");
    var cell;
    var zone;
    if (progress === -1) {
      return { zone: "yard", cellId: "yard-" + player, row: null, col: null };
    }
    if (progress <= 50) {
      cell = RING[(START_OFFSETS[player] + progress) % RING.length];
      zone = "ring";
    } else if (progress < FINISH) {
      cell = HOME_PATHS[player][progress - 51];
      zone = "home";
    } else {
      cell = FINISH_CELLS[player];
      zone = "finish";
    }
    return { zone: zone, cellId: cell.cellId, row: cell.row, col: cell.col };
  }

  function isSafeCell(cellId) {
    return typeof cellId === "string" && safeCellIds[cellId] === true;
  }

  function stateKey(state, options) {
    validateState(state);
    var tokens = state.tokenProgress;
    if (options && options.canonicalTokens) {
      tokens = tokens.map(function (side) {
        return side.slice().sort(function (left, right) { return left - right; });
      });
    }
    return JSON.stringify([
      state.rulesetId, state.boardVersion, state.activePlayer, state.phase,
      state.pendingDie, state.consecutiveSixes, tokens, state.winner
    ]);
  }

  return Object.freeze({
    RULESET_ID: RULESET_ID,
    BOARD_VERSION: BOARD_VERSION,
    FINISH: FINISH,
    START_OFFSETS: START_OFFSETS,
    SAFE_INDICES: SAFE_INDICES,
    RING: RING,
    HOME_PATHS: HOME_PATHS,
    FINISH_CELLS: FINISH_CELLS,
    createGame: createGame,
    cloneState: cloneState,
    validateState: validateState,
    getLegalActions: getLegalActions,
    applyRoll: applyRoll,
    applyAction: applyAction,
    getTerminalResult: getTerminalResult,
    position: position,
    isSafeCell: isSafeCell,
    stateKey: stateKey
  });
});

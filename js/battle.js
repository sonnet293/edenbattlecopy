// js/battle.js
import { auth, db } from "./firebase.js";
import { onAuthStateChanged }
from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc,
  getDoc,
  updateDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// 기대하는 모양:
//   MOVES["화염바퀴"] = { power, type, accuracy, alwaysHit, effect: { chance, status?, volatile?, rank? } }
import { MOVES } from "./moves.js";
// 기대하는 모양: getTypeMultiplier(moveType, defenderType) -> 1.2 / 0.8 / 0 / 1
import { getTypeMultiplier } from "./typeChart.js";
import {
  applyStatus,
  applyVolatile,
  applyEndOfTurnStatusDamage,
  checkActionPrevented,
  checkConfusionInterrupt,
  formatPokemonName,
  josa,
} from "./effecthandler.js";

const roomRef = doc(db, "rooms", ROOM_ID);
const isSpectatorView = new URLSearchParams(location.search).get("spectator") === "true";

const MOVE_BUTTON_COUNT = 4;

// 기술 타입별 버튼 배경색
const TYPE_COLORS = {
  노말: "#949495", 불: "#e56c3e", 물: "#5185c5", 전기: "#fbb917", 풀: "#66a945",
  얼음: "#6dc8eb", 격투: "#e09c40", 독: "#735198", 땅: "#9c7743", 바위: "#bfb889",
  비행: "#a2c3e7", 에스퍼: "#dd6b7b", 벌레: "#9fa244", 고스트: "#684870",
  드래곤: "#535ca8", 악: "#4c4948", 강철: "#69a9c7", 페어리: "#dab4d4",
};

// 랭크 -3 ~ +3 -> 배율 0.7 ~ 1.3
const RANK_MULT_TABLE = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3];

let myUid = null;
let mySlot = null; // "player1" | "player2" | "spectator" | null
let roundInitInFlight = false; // player1의 첫 주사위 굴리기 중복 방지용 가드
let lastAnimatedRound = 0; // 마지막으로 다이스 애니메이션 재생한 round_no
let isAnimating = false; // 다이스 애니메이션 재생 중인지
let resolvedForcedTurn = 0; // 얼음/마비/혼란 등 강제행동 체크를 끝낸 round_no
let forcedActionPending = false; // 강제행동 체크 처리 중인지 (버튼 잠금용)

const DICE_SOUND_URL = "https://slippery-copper-mzpmcmc2ra.edgeone.app/soundreality-bicycle-bell-155622.mp3";
const diceSound = new Audio(DICE_SOUND_URL);

function slotKey(slot) {
  if (slot === "player1") return "p1";
  if (slot === "player2") return "p2";
  return null;
}

function displayName(key, room) {
  return key === "p1" ? (room.player1_name ?? "Player1") : (room.player2_name ?? "Player2");
}

function calcMySlot(room) {
  if (!room || !myUid) return null;
  if (room.player1_uid === myUid) return "player1";
  if (room.player2_uid === myUid) return "player2";
  return "spectator";
}

function rollD10() {
  return Math.floor(Math.random() * 10) + 1;
}

function clampRank(value) {
  return Math.max(-3, Math.min(3, value));
}

function rankMultiplier(rank) {
  return RANK_MULT_TABLE[clampRank(rank) + 3];
}

function defaultRanks() {
  return {
    atk: { value: 0, expireTurn: 0 },
    def: { value: 0, expireTurn: 0 },
    evasion: { value: 0, expireTurn: 0 },
  };
}

// 3턴(사용 시점 포함) 지나면 자동으로 0으로 풀림
function getEffectiveRank(ranks, stat, currentTurn) {
  const data = ranks?.[stat];
  if (!data) return 0;
  if (currentTurn > data.expireTurn) return 0;
  return data.value;
}

// 기술 타입 vs 방어 포켓몬의 다중 타입 -> 각 타입 배율을 곱해서 반환
function getDefenderTypeMultiplier(moveType, defenderTypes) {
  if (!Array.isArray(defenderTypes) || defenderTypes.length === 0) return 1;
  return defenderTypes.reduce((mult, t) => mult * getTypeMultiplier(moveType, t), 1);
}

// 공격자 타입 배열에 기술 타입이 포함되어 있으면 자속 보정
function hasStab(attackerTypes, moveType) {
  return Array.isArray(attackerTypes) && attackerTypes.includes(moveType);
}

// 회피율(%) = 5 * (방어자 spd - 공격자 spd), 0~10% 범위로 clamp
function calcBaseEvasionPercent(attackerSpd, defenderSpd) {
  return Math.max(0, Math.min(10, 5 * (defenderSpd - attackerSpd)));
}

// 명중 판정. alwaysHit이면 항상 명중.
// 회피율 = spd차 기반 회피율(0~10%) * 회피 랭크 보정값
// 최종 명중률 = 기술 명중률 * (1 - 최종 회피율)
function rollHit(moveData, attacker, defender, defenderRanks, currentTurn) {
  if (moveData.alwaysHit) return true;

  const baseEvasionPct = calcBaseEvasionPercent(attacker.spd, defender.spd);
  const evasionRankMult = rankMultiplier(getEffectiveRank(defenderRanks, "evasion", currentTurn));
  const finalEvasionPct = baseEvasionPct * evasionRankMult;

  const chance = Math.max(0, Math.min(1, (moveData.accuracy / 100) * (1 - finalEvasionPct / 100)));
  return Math.random() < chance;
}

// spd + 1d10 비교로 선공 결정. 동점이면 다시 굴림. 굴린 다이스 값은 애니메이션용으로 같이 반환.
function decideFirst(p1Active, p2Active) {
  let score1, score2, r1, r2;
  for (let i = 0; i < 20; i++) {
    r1 = rollD10();
    r2 = rollD10();
    score1 = p1Active.spd + r1;
    score2 = p2Active.spd + r2;
    if (score1 !== score2) break;
  }
  return { first: score1 > score2 ? "p1" : "p2", r1, r2 };
}

// 활성 포켓몬이 쓰러졌으면 다음 포켓몬으로 교체. entries/activeIdx를 직접 변경함.
// 반환: { fainted, allFainted, name }
function handleFaintSwitch(entries, sideKey, activeIdx) {
  const arr = entries[sideKey];
  const idx = activeIdx[sideKey];
  const pkmn = arr[idx];
  if (!pkmn || pkmn.hp > 0) return { fainted: false };

  const name = pkmn.name ?? "포켓몬";
  const nextIdx = idx + 1;
  if (nextIdx < arr.length) {
    activeIdx[sideKey] = nextIdx;
    return { fainted: true, allFainted: false, name };
  }
  return { fainted: true, allFainted: true, name };
}

// 한 명(선공 or 후공)의 행동이 끝난 뒤 다음 단계를 계산.
// 같은 턴이면 상대 턴으로 넘기고, 턴이 다 끝났으면 독/화상 틱 적용 후 다음 턴 다이스를 굴림.
// entries/activeIdx를 직접 변경하며, log에 메시지를 push함.
function buildTurnAdvanceUpdate(room, entries, activeIdx, currentTurn, log) {
  const update = {};

  if (room.battle_turn === room.round_first) {
    update.battle_turn = room.battle_turn === "p1" ? "p2" : "p1";
    return update; // 아직 이번 턴 안 끝남
  }

  // 후공까지 행동 끝남 -> 이번 턴 종료. 독/화상 틱 적용.
  for (const side of ["p1", "p2"]) {
    const pkmn = entries[side][activeIdx[side]];
    if (!pkmn) continue;
    const tick = applyEndOfTurnStatusDamage(pkmn);
    if (tick.damage > 0) {
      entries[side][activeIdx[side]] = tick.pokemon;
      log.push(tick.message);
    }
  }

  // 틱 데미지로 쓰러졌는지 체크
  let winner = null;
  for (const side of ["p1", "p2"]) {
    const opp = side === "p1" ? "p2" : "p1";
    const faint = handleFaintSwitch(entries, side, activeIdx);
    if (!faint.fainted) continue;

    if (faint.allFainted) {
      winner = opp;
      log.push(`${displayName(opp, room)} 승리!`);
    } else {
      update[`${side}_active_idx`] = activeIdx[side];
      update[`${side}_ranks`] = defaultRanks();
      log.push(`${faint.name}${josa(faint.name, "이가")} 쓰러졌다! 다음 포켓몬 출전`);
    }
  }

  if (winner) {
    update.battle_winner = winner;
    return update;
  }

  const p1Active = entries.p1[activeIdx.p1];
  const p2Active = entries.p2[activeIdx.p2];
  const { first, r1, r2 } = decideFirst(p1Active, p2Active);
  update.battle_turn = first;
  update.round_first = first;
  update.round_no = currentTurn + 1;
  update.p1_roll = r1;
  update.p2_roll = r2;
  log.push(`다음 턴! ${displayName(first, room)} 선공`);

  return update;
}

onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  myUid = user.uid;
  listenBattle();
});

function listenBattle() {
  onSnapshot(roomRef, (snap) => {
    const room = snap.data();
    if (!room) return;

    mySlot = isSpectatorView ? "spectator" : calcMySlot(room);

    renderBoard(room);
    maybeInitRound(room);

    const roundNo = room.round_no ?? 0;
    const isNewRound = !!room.battle_turn && roundNo !== lastAnimatedRound;

    if (isNewRound && !isAnimating) {
      isAnimating = true;
      document.getElementById("turn-indicator").innerText = "주사위 굴리는 중...";
      renderTurnUI(room); // 버튼들 잠그기
      playDiceRoll(room.p1_roll, room.p2_roll).then(() => {
        isAnimating = false;
        lastAnimatedRound = roundNo;
        afterDiceSettled(room);
      });
    } else if (!isAnimating) {
      afterDiceSettled(room);
    }
  });
}

// 다이스(선공 결정)가 끝난 뒤: 얼음/마비/풀죽음/혼란부터 체크하고 화면을 갱신
function afterDiceSettled(room) {
  maybeResolveForcedAction(room);
  renderTurnUI(room);
}

// 게임이 막 시작됐는데 아직 선공이 안 정해졌으면 player1이 한 번 굴려서 세팅
async function maybeInitRound(room) {
  if (!room.game_started || room.battle_turn || room.battle_winner) return;
  if (mySlot !== "player1" || roundInitInFlight) return;

  const p1Active = room.p1_entry?.[room.p1_active_idx ?? 0];
  const p2Active = room.p2_entry?.[room.p2_active_idx ?? 0];
  if (!p1Active || !p2Active) return;

  roundInitInFlight = true;
  const { first, r1, r2 } = decideFirst(p1Active, p2Active);
  await updateDoc(roomRef, {
    battle_turn: first,
    round_first: first,
    round_no: 1,
    p1_roll: r1,
    p2_roll: r2,
    p1_ranks: defaultRanks(),
    p2_ranks: defaultRanks(),
    battle_log: [`턴 1 시작! ${displayName(first, room)} 선공`],
  });
}

// 내 턴이 됐을 때 얼음/마비/풀죽음/혼란부터 체크. 막히면 기술 선택 없이 바로 턴을 넘김.
function maybeResolveForcedAction(room) {
  const myKey = slotKey(mySlot);
  if (!myKey || room.battle_turn !== myKey || room.battle_winner) return;
  if (room.round_no === resolvedForcedTurn) return; // 이미 이번 턴은 체크함

  const activeIdx = room[`${myKey}_active_idx`] ?? 0;
  const pkmn = room[`${myKey}_entry`]?.[activeIdx];
  if (!pkmn) return;

  if (!pkmn.status && !pkmn.volatile) {
    resolvedForcedTurn = room.round_no; // 막을 게 없으면 바로 통과
    return;
  }

  forcedActionPending = true;
  resolveForcedActionAsync(myKey).finally(() => {
    forcedActionPending = false;
  });
}

async function resolveForcedActionAsync(myKey) {
  const snap = await getDoc(roomRef);
  const room = snap.data();
  if (!room || room.battle_winner || room.battle_turn !== myKey) return;
  if (room.round_no === resolvedForcedTurn) return; // 이미 처리됨

  const oppKey = myKey === "p1" ? "p2" : "p1";
  const entries = { p1: [...(room.p1_entry ?? [])], p2: [...(room.p2_entry ?? [])] };
  const activeIdx = { p1: room.p1_active_idx ?? 0, p2: room.p2_active_idx ?? 0 };
  const currentTurn = room.round_no ?? 1;

  let pkmn = entries[myKey][activeIdx[myKey]];
  if (!pkmn) return;

  const log = [...(room.battle_log ?? [])];
  const update = {};

  const gate = checkActionPrevented(pkmn);
  pkmn = gate.pokemon;
  let blocked = !gate.canAct;
  if (gate.message) log.push(gate.message);

  if (gate.canAct && pkmn.volatile === "혼란") {
    const confusion = checkConfusionInterrupt(pkmn);
    pkmn = confusion.pokemon;
    if (confusion.message) log.push(confusion.message);
    if (confusion.confused) blocked = true;
  }

  entries[myKey][activeIdx[myKey]] = pkmn;
  resolvedForcedTurn = currentTurn;

  if (!blocked) {
    // 행동 가능해짐 (얼음 풀림 / 마비 통과 / 혼란 회복 등) - 엔트리만 갱신, 턴은 그대로 둠
    update[`${myKey}_entry`] = entries[myKey];
    update.battle_log = log;
    await updateDoc(roomRef, update);
    return;
  }

  // 막혔음 (혼란 자기 공격 포함) -> 자기 자신이 쓰러졌는지 체크
  const faint = handleFaintSwitch(entries, myKey, activeIdx);
  if (faint.fainted) {
    if (faint.allFainted) {
      update.battle_winner = oppKey;
      log.push(`${faint.name}${josa(faint.name, "이가")} 쓰러졌다!`);
      log.push(`${displayName(oppKey, room)} 승리!`);
      update[`${myKey}_entry`] = entries[myKey];
      update.battle_log = log;
      await updateDoc(roomRef, update);
      return;
    }
    update[`${myKey}_active_idx`] = activeIdx[myKey];
    update[`${myKey}_ranks`] = defaultRanks();
    log.push(`${faint.name}${josa(faint.name, "이가")} 쓰러졌다! 다음 포켓몬 출전`);
  }

  update[`${myKey}_entry`] = entries[myKey];
  update[`${oppKey}_entry`] = entries[oppKey];

  const advance = buildTurnAdvanceUpdate(room, entries, activeIdx, currentTurn, log);
  Object.assign(update, advance);
  update[`${myKey}_entry`] = entries[myKey];
  update[`${oppKey}_entry`] = entries[oppKey];

  update.battle_log = log;
  await updateDoc(roomRef, update);
}

async function useMove(moveIdx) {
  const myKey = slotKey(mySlot);
  if (!myKey || isAnimating || forcedActionPending) return;

  const snap = await getDoc(roomRef);
  const room = snap.data();
  if (!room || room.battle_winner) return;
  if (room.battle_turn !== myKey) return; // 내 턴 아니면 무시
  if (room.round_no !== resolvedForcedTurn) return; // 강제행동 체크 전이면 무시

  const oppKey = myKey === "p1" ? "p2" : "p1";
  const entries = {
    p1: [...(room.p1_entry ?? [])],
    p2: [...(room.p2_entry ?? [])],
  };
  const activeIdx = {
    p1: room.p1_active_idx ?? 0,
    p2: room.p2_active_idx ?? 0,
  };
  const currentTurn = room.round_no ?? 1;

  const attacker = entries[myKey][activeIdx[myKey]];
  const defender = entries[oppKey][activeIdx[oppKey]];
  if (!attacker || !defender) return;

  const moveSlot = attacker.moves?.[moveIdx];
  if (!moveSlot || (moveSlot.pp ?? 0) <= 0) return; // PP 없으면 사용 불가

  const moveData = MOVES[moveSlot.name];
  if (!moveData) {
    console.warn(`moves.js에 "${moveSlot.name}" 기술이 정의되어 있지 않음`);
    return;
  }

  // PP 소모
  const newMoves = [...attacker.moves];
  newMoves[moveIdx] = { ...moveSlot, pp: moveSlot.pp - 1 };
  entries[myKey][activeIdx[myKey]] = { ...attacker, moves: newMoves };

  let myRanks = room[`${myKey}_ranks`] ?? defaultRanks();
  let oppRanks = room[`${oppKey}_ranks`] ?? defaultRanks();

  const log = [...(room.battle_log ?? [])];
  const update = {};

  const hit = rollHit(moveData, attacker, defender, oppRanks, currentTurn);

  if (!hit) {
    log.push(`${displayName(myKey, room)}의 ${moveSlot.name}! 빗나갔다...`);
  } else {
    const atkMult = rankMultiplier(getEffectiveRank(myRanks, "atk", currentTurn));
    const defMult = rankMultiplier(getEffectiveRank(oppRanks, "def", currentTurn));
    const correctedAtk = attacker.atk * atkMult;
    const correctedDef = defender.def * defMult;

    const typeMult = getDefenderTypeMultiplier(moveData.type, defender.types);
    const stab = hasStab(attacker.types, moveData.type) ? 1.3 : 1;

    const rawDamage = (moveData.power + correctedAtk * 4 + rollD10()) * typeMult * stab - correctedDef * 3;
    const dmg = Math.max(0, Math.round(rawDamage));
    const newHp = Math.max(0, defender.hp - dmg);

    let updatedDefender = { ...defender, hp: newHp };

    const effectText =
      typeMult === 0 ? " (효과가 없는 듯하다...)" :
      typeMult > 1 ? " (효과가 굉장했다!)" :
      typeMult < 1 ? " (효과가 별로인 듯하다...)" : "";
    log.push(`${displayName(myKey, room)}의 ${moveSlot.name}! ${dmg} 데미지${effectText}`);

    // 상태이상 / 상태변화 부여 시도
    if (moveData.effect && Math.random() < moveData.effect.chance) {
      if (moveData.effect.status) {
        const before = updatedDefender.status;
        updatedDefender = applyStatus(updatedDefender, moveData.effect.status);
        if (updatedDefender.status !== before) {
          const dn = updatedDefender.name ?? "포켓몬";
          log.push(`${dn}${josa(dn, "이가")} ${moveData.effect.status} 상태가 되었다!`);
        }
      } else if (moveData.effect.volatile) {
        const before = updatedDefender.volatile;
        updatedDefender = applyVolatile(updatedDefender, moveData.effect.volatile);
        if (updatedDefender.volatile !== before) {
          const dn = updatedDefender.name ?? "포켓몬";
          log.push(`${dn}${josa(dn, "이가")} ${moveData.effect.volatile} 상태가 되었다!`);
        }
      }
    }

    entries[oppKey][activeIdx[oppKey]] = updatedDefender;

    // 랭크 변화 (moves.js에 아직 없는 필드지만, 추가될 경우를 대비한 처리)
    if (moveData.effect?.rank) {
      const { stat, target, value } = moveData.effect.rank;
      const targetKey = target === "self" ? myKey : oppKey;
      const targetRanks = targetKey === myKey ? myRanks : oppRanks;
      const newValue = clampRank(getEffectiveRank(targetRanks, stat, currentTurn) + value);
      const newRanks = { ...targetRanks, [stat]: { value: newValue, expireTurn: currentTurn + 2 } };
      if (targetKey === myKey) myRanks = newRanks; else oppRanks = newRanks;
      update[`${targetKey}_ranks`] = newRanks;
      const tn = entries[targetKey][activeIdx[targetKey]]?.name ?? "포켓몬";
      log.push(`${tn}의 ${stat} 랭크가 ${value > 0 ? "올랐다" : "내려갔다"}!`);
    }

    // 전멸 체크 (직접 데미지로 쓰러진 경우)
    const faint = handleFaintSwitch(entries, oppKey, activeIdx);
    if (faint.fainted) {
      if (faint.allFainted) {
        update.battle_winner = myKey;
        log.push(`${displayName(myKey, room)} 승리!`);
        update[`${myKey}_entry`] = entries[myKey];
        update[`${oppKey}_entry`] = entries[oppKey];
        update.battle_log = log;
        await updateDoc(roomRef, update);
        return;
      }
      update[`${oppKey}_active_idx`] = activeIdx[oppKey];
      update[`${oppKey}_ranks`] = defaultRanks();
      log.push(`${faint.name}${josa(faint.name, "이가")} 쓰러졌다! 다음 포켓몬 출전`);
    }
  }

  update[`${myKey}_entry`] = entries[myKey];
  update[`${oppKey}_entry`] = entries[oppKey];

  const advance = buildTurnAdvanceUpdate(room, entries, activeIdx, currentTurn, log);
  Object.assign(update, advance);
  update[`${myKey}_entry`] = entries[myKey];
  update[`${oppKey}_entry`] = entries[oppKey];

  update.battle_log = log;
  await updateDoc(roomRef, update);
}

function renderBoard(room) {
  document.getElementById("p1-name").innerText = room.player1_name ?? "Player1";
  document.getElementById("p2-name").innerText = room.player2_name ?? "Player2";
  document.getElementById("dice-p1-name").innerText = room.player1_name ?? "Player1";
  document.getElementById("dice-p2-name").innerText = room.player2_name ?? "Player2";

  renderPokemon("p1", room.p1_entry, room.p1_active_idx ?? 0);
  renderPokemon("p2", room.p2_entry, room.p2_active_idx ?? 0);

  renderLog(room.battle_log);
  renderResult(room);
}

function renderTurnUI(room) {
  renderTurn(room);
  renderMoveButtons(room);
}

function renderPokemon(key, entry, idx) {
  const pkmn = entry?.[idx];
  const hpText = document.getElementById(`${key}-hp`);
  const hpBar = document.getElementById(`${key}-hp-bar`);
  const stats = document.getElementById(`${key}-stats`);
  if (!hpText || !hpBar || !stats) return;

  if (!pkmn) {
    hpText.innerText = "-";
    hpBar.style.width = "0%";
    stats.innerText = "";
    return;
  }

  hpText.innerText = `${pkmn.hp} / ${pkmn.maxHp}`;
  const pct = Math.max(0, Math.round((pkmn.hp / pkmn.maxHp) * 100));
  hpBar.style.width = pct + "%";
  hpBar.classList.toggle("low", pct <= 25);

  stats.innerText = `${formatPokemonName(pkmn)}  ATK ${pkmn.atk}  DEF ${pkmn.def}  SPD ${pkmn.spd}`;
}

// 내 활성 포켓몬의 기술로 빈 버튼(moveBtn0~3)을 채움
function renderMoveButtons(room) {
  const myKey = slotKey(mySlot);

  for (let i = 0; i < MOVE_BUTTON_COUNT; i++) {
    const btn = document.getElementById(`moveBtn${i}`);
    if (!btn) continue;

    if (!myKey) {
      btn.style.display = "none";
      continue;
    }

    const activeIdx = room[`${myKey}_active_idx`] ?? 0;
    const myPkmn = room[`${myKey}_entry`]?.[activeIdx];
    const move = myPkmn?.moves?.[i];

    if (!move) {
      btn.style.display = "none";
      continue;
    }

    const canAct =
      room.battle_turn === myKey &&
      !room.battle_winner &&
      !isAnimating &&
      !forcedActionPending &&
      room.round_no === resolvedForcedTurn;
    const usable = canAct && (move.pp ?? 0) > 0;

    const moveData = MOVES[move.name];
    btn.style.display = "inline-block";
    btn.style.backgroundColor = TYPE_COLORS[moveData?.type] ?? "var(--accent)";
    btn.style.opacity = usable ? "1" : "0.45";
    btn.textContent = `${move.name} (PP ${move.pp})`;
    btn.disabled = !usable;
    btn.onclick = () => useMove(i);
  }
}

function renderLog(log = []) {
  const el = document.getElementById("battle-log");
  el.innerHTML = "";
  log.slice(-8).forEach((line) => {
    const div = document.createElement("div");
    div.textContent = line;
    el.appendChild(div);
  });
  el.scrollTop = el.scrollHeight;
}

function renderTurn(room) {
  const el = document.getElementById("turn-indicator");
  if (room.battle_winner) {
    el.innerText = "전투 종료";
    return;
  }
  if (!room.battle_turn) {
    el.innerText = "선공 결정 중...";
    return;
  }
  if (forcedActionPending || room.round_no !== resolvedForcedTurn) {
    el.innerText = "상태 확인 중...";
    return;
  }
  el.innerText = `${displayName(room.battle_turn, room)}의 턴`;
}

function renderResult(room) {
  const el = document.getElementById("result");
  if (!room.battle_winner) {
    el.innerText = "";
    return;
  }
  const myKey = slotKey(mySlot);
  if (myKey) {
    el.innerText = room.battle_winner === myKey ? "승리!" : "패배...";
  } else {
    el.innerText = `${displayName(room.battle_winner, room)} 승리!`;
  }
}

// 다이스 한 개를 finalValue로 멈추는 애니메이션 (숫자 빠르게 돌다가 착지)
function animateOneDice(elId, finalValue) {
  return new Promise((resolve) => {
    const el = document.getElementById(elId);
    let elapsed = 0;
    const interval = 10;
    const duration = 1200;
    const timer = setInterval(() => {
      el.textContent = Math.floor(Math.random() * 10) + 1;
      elapsed += interval;
      if (elapsed >= duration) {
        clearInterval(timer);
        el.textContent = finalValue;
        el.classList.remove("pop");
        void el.offsetWidth;
        el.classList.add("pop");
        resolve();
      }
    }, interval);
  });
}

// 양쪽 주사위를 동시에 굴려서 실제 저장된 값(p1Roll, p2Roll)으로 착지시킴
async function playDiceRoll(p1Roll, p2Roll) {
  const diceRow = document.getElementById("diceRow");
  diceRow.style.display = "flex";
  document.getElementById("dice-p1").textContent = "-";
  document.getElementById("dice-p2").textContent = "-";

  await Promise.all([
    animateOneDice("dice-p1", p1Roll),
    animateOneDice("dice-p2", p2Roll),
  ]);

  diceSound.currentTime = 0;
  diceSound.play().catch(() => {});

  await new Promise((resolve) => setTimeout(resolve, 700)); // 결과 잠깐 보여주기
  diceRow.style.display = "none";
}
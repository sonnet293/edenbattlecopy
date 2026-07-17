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
import { MOVES } from "./moves.js";
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

const TYPE_COLORS = {
  노말: "#949495", 불: "#e56c3e", 물: "#5185c5", 전기: "#fbb917", 풀: "#66a945",
  얼음: "#6dc8eb", 격투: "#e09c40", 독: "#735198", 땅: "#9c7743", 바위: "#bfb889",
  비행: "#a2c3e7", 에스퍼: "#dd6b7b", 벌레: "#9fa244", 고스트: "#684870",
  드래곤: "#535ca8", 악: "#4c4948", 강철: "#69a9c7", 페어리: "#dab4d4",
};

const RANK_MULT_TABLE = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3];

const BATTLE_RESET_FIELDS = {
  game_started: false,
  game_started_at: null,
  player1_ready: false,
  player2_ready: false,
  p1_entry: null,
  p2_entry: null,
  p1_active_idx: 0,
  p2_active_idx: 0,
  p1_pending_switch: false,
  p2_pending_switch: false,
  p1_ranks: null,
  p2_ranks: null,
  battle_turn: null,
  round_first: null,
  round_no: 0,
  p1_roll: null,
  p2_roll: null,
  battle_log: [],
  battle_event_log: [],
  battle_winner: null,
};

let myUid = null;
let mySlot = null; 
let roundInitInFlight = false; 
let lastAnimatedRound = 0; 
let isAnimating = false; 
let diceRolling = false; 
let pendingDiceRoll = null;
let actionInFlight = false;
let pendingFirstMoveLog = null; // 다이스 롤이 끝난 뒤에야 재생할 "~의 선공!" 로그 줄

const DICE_SOUND_URL = "https://slippery-copper-mzpmcmc2ra.edgeone.app/soundreality-bicycle-bell-155622.mp3";
const diceSound = new Audio(DICE_SOUND_URL);

const BUTTON_SOUND_URL = "https://usual-salmon-mnqxptwyvw.edgeone.app/Pokemon%20(A%20Button)%20-%20Sound%20Effect%20(HD)%20(1)%20(1).mp3";
const buttonSound = new Audio(BUTTON_SOUND_URL);

function playButtonSound() {
  buttonSound.currentTime = 0;
  buttonSound.play().catch(() => {});
}

function slotKey(slot) {
  if (slot === "player1") return "p1";
  if (slot === "player2") return "p2";
  return null;
}

function displayName(key, room) {
  return key === "p1" ? (room.player1_name ?? "Player1") : (room.player2_name ?? "Player2");
}

function perspectiveKeys() {
  const myKey = slotKey(mySlot);
  if (myKey === "p2") return { mineKey: "p2", enemyKey: "p1" };
  return { mineKey: "p1", enemyKey: "p2" };
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

const RANK_FIELD_MAP = {
  atk: { self: true, stat: "atk" },
  def: { self: true, stat: "def" },
  spd: { self: true, stat: "evasion" },
  targetAtk: { self: false, stat: "atk" },
  targetDef: { self: false, stat: "def" },
  targetSpd: { self: false, stat: "evasion" },
};

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

// 명중 판정 (기술 자체의 명중률만 사용). 실패하면 "빗나갔다" - 공격자 쪽 귀책.
function rollAccuracy(moveData) {
  if (moveData.alwaysHit) return true;
  return Math.random() < moveData.accuracy / 100;
}

// 회피 판정 (방어자의 회피율만 사용). 성공하면 "맞지 않았다" - 방어자 쪽 회피.
// 회피율 = spd차 기반 회피율(0~10%) * 회피 랭크 보정값(0.7~1.3)
function rollEvasion(attacker, defender, defenderRanks, currentTurn) {
  const baseEvasionPct = calcBaseEvasionPercent(attacker.spd, defender.spd);
  const evasionRankMult = rankMultiplier(getEffectiveRank(defenderRanks, "evasion", currentTurn));
  const finalEvasionPct = Math.max(0, Math.min(100, baseEvasionPct * evasionRankMult));
  return Math.random() < finalEvasionPct / 100;
}

// 급소 판정. 급소율 = 공격력 * 2% (100% 상한). 급소 시 최종 피해량 x1.5.
function rollCrit(attacker) {
  return Math.random() < Math.min(1, (attacker.atk ?? 0) * 0.02);
}

// 랭크 변화 로그 메시지. oldValue/newValue는 적용 전/후의 유효 랭크값(-3~3), wasIncrease는 이번에 올리려던 시도였는지.
function buildRankChangeMessage(name, statLabel, oldValue, newValue, wasIncrease) {
  const delta = newValue - oldValue;
  if (delta === 0) {
    return wasIncrease
      ? `${name}의 ${statLabel}${josa(statLabel, "은는")} 더 이상 올라가지 않는다!`
      : `${name}의 ${statLabel}${josa(statLabel, "은는")} 더 이상 내려가지 않는다!`;
  }
  if (newValue === 0) {
    return `${name}의 ${statLabel}${josa(statLabel, "이가")} 원래대로 돌아왔다!`;
  }
  if (delta > 0) {
    return `${name}의 ${statLabel}${josa(statLabel, "이가")} ${delta} 상승했다!`;
  }
  return `${name}의 ${statLabel}${josa(statLabel, "이가")} ${-delta} 하락했다!`;
}

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

function handleFaintSwitch(entries, sideKey, activeIdx) {
  const arr = entries[sideKey];
  const idx = activeIdx[sideKey];
  const pkmn = arr[idx];
  if (!pkmn || pkmn.hp > 0) return { fainted: false };

  const name = pkmn.name ?? "포켓몬";
  const hasAliveBench = arr.some((p, i) => i !== idx && p && p.hp > 0);
  return { fainted: true, allFainted: !hasAliveBench, name };
}

function buildTurnAdvanceUpdate(room, entries, activeIdx, currentTurn, log, events, alreadyPendingSides = new Set()) {
  const update = {};

  if (alreadyPendingSides.size > 0) {

    update.battle_turn = null;
    return update;
  }

  if (room.battle_turn === room.round_first) {
    update.battle_turn = room.battle_turn === "p1" ? "p2" : "p1";
    return update; 
  }

  for (const side of ["p1", "p2"]) {
    const pkmn = entries[side][activeIdx[side]];
    if (!pkmn) continue;
    const tick = applyEndOfTurnStatusDamage(pkmn, currentTurn);
    if (tick.damage > 0) {
      entries[side][activeIdx[side]] = tick.pokemon;
      log.push(tick.message);
      events.push({ logIndex: log.length - 1, type: "hit", side, hp: tick.pokemon.hp, hasAttacker: false });
    }
  }

  let winner = null;
  let needsSwitch = false;
  for (const side of ["p1", "p2"]) {
    const opp = side === "p1" ? "p2" : "p1";
    const faint = handleFaintSwitch(entries, side, activeIdx);
    if (!faint.fainted) continue;

    if (faint.allFainted) {
      winner = opp;
      log.push(`${displayName(opp, room)} 승리!`);
    } else {
      update[`${side}_pending_switch`] = true;
      needsSwitch = true;
      log.push(`${faint.name}${josa(faint.name, "은는")} 쓰러졌다!`);
    }
  }

  if (winner) {
    update.battle_winner = winner;
    return update;
  }

  if (needsSwitch) {
    update.battle_turn = null; 
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
  const firstPkmnName = (first === "p1" ? p1Active : p2Active)?.name ?? "포켓몬";
  log.push(`${firstPkmnName}의 선공!`);

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

    const roundNo = room.round_no ?? 0;
    const isNewRound = !!room.battle_turn && roundNo !== lastAnimatedRound;

    renderBoard(room, isNewRound);
    maybeInitRound(room);

    if (isNewRound) {
      if (!isAnimating) {
        isAnimating = true;
        renderTurnUI(room); 
      }
      // 이전 라운드의 로그/연출 큐가 다 끝난 뒤에 굴리도록 일단 대기시켜둠
      const { mineKey, enemyKey } = perspectiveKeys();
      pendingDiceRoll = { roundNo, mineRoll: room[`${mineKey}_roll`], enemyRoll: room[`${enemyKey}_roll`], room };
      tryStartPendingDiceRoll();
    } else if (!isAnimating) {
      afterDiceSettled(room);
    }
  });
}

// 이전 라운드의 로그 타이핑/피격 연출 큐가 완전히 빌 때까지는 다이스를 굴리지 않음.
// processBoardQueue가 큐를 다 비울 때마다도 호출해서, 마지막 로그 줄 연출이 끝나자마자 이어서 굴림.
function tryStartPendingDiceRoll() {
  if (!pendingDiceRoll || diceRolling) return;
  if (boardBusy || boardQueue.length > 0) return; // 아직 이전 라운드 연출 재생 중

  const { roundNo, mineRoll, enemyRoll, room } = pendingDiceRoll;
  pendingDiceRoll = null;
  diceRolling = true;
  // document.getElementById("turn-indicator").innerText = "주사위 굴리는 중...";
  playDiceRoll(mineRoll, enemyRoll).then(() => {
    diceRolling = false;
    isAnimating = false;
    lastAnimatedRound = roundNo;
    afterDiceSettled(room);
    flushPendingFirstMoveLog();
  });
}

// 다이스 결과가 확정된 뒤에야 보류해뒀던 "~의 선공!" 로그 줄을 재생
function flushPendingFirstMoveLog() {
  if (!pendingFirstMoveLog) return;
  const { text } = pendingFirstMoveLog;
  pendingFirstMoveLog = null;
  boardQueue.push({ kind: "log", text });
  processBoardQueue();
}

// 다이스(선공 결정)가 끝난 뒤 화면을 갱신
function afterDiceSettled(room) {
  renderTurnUI(room);
}

// 게임이 막 시작됐는데 아직 선공이 안 정해졌으면 player1이 한 번 굴려서 세팅.
// round_no로 판단(battle_turn만 보면 강제교체 대기 중의 null 상태와 구분이 안 돼서 재시작 취급될 수 있음).
async function maybeInitRound(room) {
  if (!room.game_started || (room.round_no ?? 0) > 0 || room.battle_winner) return;
  if (mySlot !== "player1" || roundInitInFlight) return;

  const p1Active = room.p1_entry?.[room.p1_active_idx ?? 0];
  const p2Active = room.p2_entry?.[room.p2_active_idx ?? 0];
  if (!p1Active || !p2Active) return;

  roundInitInFlight = true;
  const { first, r1, r2 } = decideFirst(p1Active, p2Active);

  const p1Name = displayName("p1", room);
  const p2Name = displayName("p2", room);
  const p1PkmnName = p1Active.name ?? "포켓몬";
  const p2PkmnName = p2Active.name ?? "포켓몬";
  const firstPkmnName = (first === "p1" ? p1Active : p2Active)?.name ?? "포켓몬";

  await updateDoc(roomRef, {
    battle_turn: first,
    round_first: first,
    round_no: 1,
    p1_roll: r1,
    p2_roll: r2,
    p1_ranks: defaultRanks(),
    p2_ranks: defaultRanks(),
    p1_pending_switch: false,
    p2_pending_switch: false,
    battle_log: [
      `${p1Name}${josa(p1Name, "과와")} ${p2Name}의 승부가 시작됐다!`,
      `${p1Name}${josa(p1Name, "은는")} ${p1PkmnName}${josa(p1PkmnName, "을를")} 내보냈다!`,
      `${p2Name}${josa(p2Name, "은는")} ${p2PkmnName}${josa(p2PkmnName, "을를")} 내보냈다!`,
      `${firstPkmnName}의 선공!`,
    ],
    battle_event_log: [],
  });
}

async function useMove(moveIdx) {
  const myKey = slotKey(mySlot);
  if (!myKey || isAnimating || actionInFlight) return;

  actionInFlight = true;
  try {
    const snap = await getDoc(roomRef);
    const room = snap.data();
    if (!room || room.battle_winner) return;
    if (room.battle_turn !== myKey) return; // 내 턴 아니면 무시

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
    let currentAttacker = { ...attacker, moves: newMoves };
    entries[myKey][activeIdx[myKey]] = currentAttacker;

    let myRanks = room[`${myKey}_ranks`] ?? defaultRanks();
    let oppRanks = room[`${oppKey}_ranks`] ?? defaultRanks();

    const log = [...(room.battle_log ?? [])];
    const events = [...(room.battle_event_log ?? [])];
    const update = {};
    let directPendingSide = null;

    // 기술을 고른 뒤에야 얼음/마비/혼란으로 인한 행동 저지를 판정 (버튼은 항상 활성화된 상태로 유지)
    const gate = checkActionPrevented(currentAttacker);
    currentAttacker = gate.pokemon;
    let blocked = !gate.canAct;
    if (gate.message) log.push(gate.message);

    if (gate.canAct && currentAttacker.volatiles?.["혼란"]) {
      const confusion = checkConfusionInterrupt(currentAttacker);
      currentAttacker = confusion.pokemon;
      if (confusion.message) log.push(confusion.message);
      if (confusion.confused) {
        blocked = true;
        events.push({ logIndex: log.length - 1, type: "hit", side: myKey, hp: currentAttacker.hp, hasAttacker: false });
      }
    }

    entries[myKey][activeIdx[myKey]] = currentAttacker;

    if (blocked) {
      // 행동 저지(혼란 자해 포함) -> 자기 자신이 쓰러졌는지 체크
      const faint = handleFaintSwitch(entries, myKey, activeIdx);
      if (faint.fainted) {
        if (faint.allFainted) {
          update.battle_winner = oppKey;
          log.push(`${faint.name}${josa(faint.name, "은는")} 쓰러졌다!`);
          log.push(`${displayName(oppKey, room)} 승리!`);
          update[`${myKey}_entry`] = entries[myKey];
          update.battle_log = log;
          update.battle_event_log = events;
          await updateDoc(roomRef, update);
          return;
        }
        update[`${myKey}_pending_switch`] = true;
        log.push(`${faint.name}${josa(faint.name, "은는")} 쓰러졌다!`);
        directPendingSide = myKey;
      }
    } else {
      const attackerName = currentAttacker.name ?? "포켓몬";
      log.push(`${attackerName}의 ${moveSlot.name}!`);
      const moveLogIndex = log.length - 1;

      const accuracyHit = rollAccuracy(moveData);

      if (!accuracyHit) {
        log.push(`그러나 ${attackerName}의 공격은 빗나갔다!`);
      } else {
        const evaded = !moveData.alwaysHit && rollEvasion(attacker, defender, oppRanks, currentTurn);
        const defenderName = defender.name ?? "포켓몬";

        if (evaded) {
          log.push(`${defenderName}에게는 맞지 않았다!`);
        } else {
          // 공격 랭크업/다운: (위력 + 공격력x4 + 1d10) 전체에 곱해짐, 타입상성/자속 적용 "이전" 보정값 (급소율에는 영향 없음)
          // 방어 랭크업/다운: 방어력x3 항에만 곱해짐
          const atkMult = rankMultiplier(getEffectiveRank(myRanks, "atk", currentTurn));
          const defMult = rankMultiplier(getEffectiveRank(oppRanks, "def", currentTurn));

          const typeMult = getDefenderTypeMultiplier(moveData.type, defender.types);
          const stab = hasStab(attacker.types, moveData.type) ? 1.3 : 1;

          let updatedDefender = { ...defender };

          // 위력이 0인 기술(상태이상/랭크 변화 전용)은 데미지를 주지 않음
          if (moveData.power > 0) {
            // 최종 피해량 = ((위력 + 공격력x4 + 1d10) x 공격랭크보정 x 타입상성 x 자속) - (방어력x3 x 방어랭크보정)
            const rawDamage =
              (moveData.power + attacker.atk * 4 + rollD10()) * atkMult * typeMult * stab -
              defender.def * 3 * defMult;
            const isCrit = rollCrit(attacker);
            const dmg = Math.max(0, Math.round(rawDamage * (isCrit ? 1.5 : 1)));
            const newHp = Math.max(0, defender.hp - dmg);

            updatedDefender = { ...defender, hp: newHp };
            events.push({ logIndex: moveLogIndex, type: "hit", side: oppKey, hp: newHp, hasAttacker: true });

            if (isCrit && dmg > 0) log.push("급소에 맞았다!");

            if (typeMult === 0) log.push(`${defenderName}에게는 효과가 없는 듯하다...`);
            else if (typeMult > 1) log.push("효과가 굉장했다!");
            else if (typeMult < 1) log.push("효과가 별로인 듯하다...");
          }

          // 상태이상 / 상태변화 부여 시도
          if (moveData.effect && Math.random() < moveData.effect.chance) {
            if (moveData.effect.status) {
              const statusResult = applyStatus(updatedDefender, moveData.effect.status, currentTurn);
              updatedDefender = statusResult.pokemon;
              if (statusResult.message) log.push(statusResult.message);
            } else if (moveData.effect.volatile) {
              const volName = moveData.effect.volatile;
              const dn = updatedDefender.name ?? "포켓몬";
              if (updatedDefender.volatiles?.[volName]) {
                log.push(`${dn}${josa(dn, "은는")} 이미 ${volName} 상태다!`);
              } else {
                updatedDefender = applyVolatile(updatedDefender, volName);
                log.push(`${dn}${josa(dn, "은는")} ${volName} 상태가 되었다!`);
              }
            }
          }

          entries[oppKey][activeIdx[oppKey]] = updatedDefender;

          // 랭크 변화. moves.js의 rank: { atk?, def?, spd?, targetAtk?, targetDef?, targetSpd?, turns, chance? }
          // 갱신 시점부터 turns만큼 다시 지속 시작.
          if (moveData.rank && Math.random() < (moveData.rank.chance ?? 1)) {
            const { turns } = moveData.rank;
            for (const [field, { self, stat }] of Object.entries(RANK_FIELD_MAP)) {
              const value = moveData.rank[field];
              if (!value) continue;

              const targetKey = self ? myKey : oppKey;
              const targetRanks = targetKey === myKey ? myRanks : oppRanks;
              const oldValue = getEffectiveRank(targetRanks, stat, currentTurn);
              const newValue = clampRank(oldValue + value);
              const newRanks = { ...targetRanks, [stat]: { value: newValue, expireTurn: currentTurn + turns } };
              if (targetKey === myKey) myRanks = newRanks; else oppRanks = newRanks;
              update[`${targetKey}_ranks`] = newRanks;

              const tn = entries[targetKey][activeIdx[targetKey]]?.name ?? "포켓몬";
              const statLabel = stat === "evasion" ? "속도" : stat === "atk" ? "공격" : "방어";
              log.push(buildRankChangeMessage(tn, statLabel, oldValue, newValue, value > 0));
            }
          }

          // 전멸/교체 체크 (직접 데미지로 쓰러진 경우)
          const faint = handleFaintSwitch(entries, oppKey, activeIdx);
          if (faint.fainted) {
            if (faint.allFainted) {
              update.battle_winner = myKey;
              log.push(`${faint.name}${josa(faint.name, "은는")} 쓰러졌다!`);
              log.push(`${displayName(myKey, room)} 승리!`);
              update[`${myKey}_entry`] = entries[myKey];
              update[`${oppKey}_entry`] = entries[oppKey];
              update.battle_log = log;
              update.battle_event_log = events;
              await updateDoc(roomRef, update);
              return;
            }
            update[`${oppKey}_pending_switch`] = true;
            log.push(`${faint.name}${josa(faint.name, "은는")} 쓰러졌다!`);
            directPendingSide = oppKey;
          }
        }
      }
    }

    update[`${myKey}_entry`] = entries[myKey];
    update[`${oppKey}_entry`] = entries[oppKey];

    const advance = buildTurnAdvanceUpdate(
      room, entries, activeIdx, currentTurn, log, events,
      directPendingSide ? new Set([directPendingSide]) : undefined
    );
    Object.assign(update, advance);
    update[`${myKey}_entry`] = entries[myKey];
    update[`${oppKey}_entry`] = entries[oppKey];

    update.battle_log = log;
    update.battle_event_log = events;
    await updateDoc(roomRef, update);
  } finally {
    actionInFlight = false;
  }
}

// 벤치 포켓몬 교체.
// - pending switch 상태(쓰러져서 강제로 교체해야 하는 상태)면: 턴 소모 없이 바로 다음 포켓몬으로.
//   상대도 더 이상 교체 대기가 아니면 그 시점에 다음 라운드 다이스를 굴림.
// - 평상시(자발적 교체)면: 기술 사용과 동등하게 내 턴(액션) 하나를 소모함.
async function switchPokemon(targetIdx) {
  const myKey = slotKey(mySlot);
  if (!myKey || isAnimating) return;

  const snap = await getDoc(roomRef);
  const room = snap.data();
  if (!room || room.battle_winner) return;

  const pendingSwitch = !!room[`${myKey}_pending_switch`];

  if (!pendingSwitch) {
    // 자발적 교체: 내 턴일 때만 가능
    if (room.battle_turn !== myKey) return;
  }

  const entries = { p1: [...(room.p1_entry ?? [])], p2: [...(room.p2_entry ?? [])] };
  const activeIdx = { p1: room.p1_active_idx ?? 0, p2: room.p2_active_idx ?? 0 };
  const myArr = entries[myKey];
  const target = myArr[targetIdx];

  if (!target || target.hp <= 0) return; // 쓰러진 포켓몬으론 못 나감
  if (!pendingSwitch && targetIdx === activeIdx[myKey]) return; // 이미 나가 있는 포켓몬

  const prevPkmn = myArr[activeIdx[myKey]];
  activeIdx[myKey] = targetIdx;

  const update = {};
  const log = [...(room.battle_log ?? [])];
  const events = [...(room.battle_event_log ?? [])];

  update[`${myKey}_active_idx`] = targetIdx;
  update[`${myKey}_ranks`] = defaultRanks(); // 교체하면 랭크 초기화

  if (pendingSwitch) {
    update[`${myKey}_pending_switch`] = false;
    const pName = displayName(myKey, room);
    const dn = target.name ?? "포켓몬";
    log.push(`${pName}${josa(pName, "은는")} ${dn}${josa(dn, "을를")} 내보냈다!`);
    events.push({ logIndex: log.length - 1, type: "switch", side: myKey, idx: targetIdx });

    const oppKey = myKey === "p1" ? "p2" : "p1";
    const oppStillPending = !!room[`${oppKey}_pending_switch`];
    if (!oppStillPending) {
      // 양쪽 다 교체 끝났으면 다음 라운드 다이스
      const p1Active = entries.p1[activeIdx.p1];
      const p2Active = entries.p2[activeIdx.p2];
      const { first, r1, r2 } = decideFirst(p1Active, p2Active);
      update.battle_turn = first;
      update.round_first = first;
      update.round_no = (room.round_no ?? 1) + 1;
      update.p1_roll = r1;
      update.p2_roll = r2;
      const firstPkmnName = (first === "p1" ? p1Active : p2Active)?.name ?? "포켓몬";
      log.push(`${firstPkmnName}의 선공!`);
    }

    update.battle_log = log;
    update.battle_event_log = events;
    await updateDoc(roomRef, update);
    return;
  }

  // 자발적 교체는 내 턴(액션)을 소모함
  {
    const prevName = prevPkmn?.name ?? "포켓몬";
    const dn = target.name ?? "포켓몬";
    const pName = displayName(myKey, room);
    log.push(`돌아와, ${prevName}!`);
    log.push(`${pName}${josa(pName, "은는")} ${dn}${josa(dn, "을를")} 내보냈다!`);
  }
  events.push({ logIndex: log.length - 1, type: "switch", side: myKey, idx: targetIdx });

  const oppKeyForAdvance = myKey === "p1" ? "p2" : "p1";
  const advance = buildTurnAdvanceUpdate(room, entries, activeIdx, room.round_no ?? 1, log, events);
  Object.assign(update, advance);
  update[`${myKey}_entry`] = entries[myKey];
  update[`${oppKeyForAdvance}_entry`] = entries[oppKeyForAdvance];

  update.battle_log = log;
  update.battle_event_log = events;
  await updateDoc(roomRef, update);
}

// 전투 종료 후 LEAVE 버튼 클릭 시: 내 슬롯을 비우고(관전자가 있으면 그 자리로 승격) 다음 게임을 위해 전투 필드를 초기화한 뒤 로비로 이동.
async function leaveBattle() {
  const snap = await getDoc(roomRef);
  const room = snap.data();
  if (!room || !room.battle_winner) return; // 전투가 끝났을 때만 나갈 수 있음

  const update = { ...BATTLE_RESET_FIELDS };
  const spectators = room.spectators ?? [];
  const spectatorNames = room.spectator_names ?? [];

  if (mySlot === "player1" || mySlot === "player2") {
    if (spectators.length > 0) {
      const randIdx = Math.floor(Math.random() * spectators.length);
      update[`${mySlot}_uid`] = spectators[randIdx];
      update[`${mySlot}_name`] = spectatorNames[randIdx];
      update.spectators = spectators.filter((_, i) => i !== randIdx);
      update.spectator_names = spectatorNames.filter((_, i) => i !== randIdx);
    } else {
      update[`${mySlot}_uid`] = null;
      update[`${mySlot}_name`] = null;
    }
  } else if (mySlot === "spectator") {
    const idx = spectators.indexOf(myUid);
    if (idx >= 0) {
      update.spectators = spectators.filter((_, i) => i !== idx);
      update.spectator_names = spectatorNames.filter((_, i) => i !== idx);
    }
  }

  await updateDoc(roomRef, update);
  const roomNumber = ROOM_ID.replace("battleroom", "");
  location.href = `../pages/battleroom${roomNumber}.html`;
}

function renderLeaveButton(room) {
  const btn = document.getElementById("leaveBtn");
  if (!btn) return;
  btn.style.display = room.battle_winner ? "inline-block" : "none";
  btn.onclick = () => {
    playButtonSound();
    leaveBattle();
  };
}

function renderBoard(room, isNewRound = false) {
  const { mineKey, enemyKey } = perspectiveKeys();
  const myKey = slotKey(mySlot);

  const mineLabel = myKey ? `${displayName(mineKey, room)}` : displayName(mineKey, room);
  const enemyLabel = myKey ? `${displayName(enemyKey, room)}` : displayName(enemyKey, room);

  document.getElementById("mine-name").innerText = mineLabel;
  document.getElementById("enemy-name").innerText = enemyLabel;
  document.getElementById("dice-mine-name").innerText = mineLabel;
  document.getElementById("dice-enemy-name").innerText = enemyLabel;

  renderLogAndBoard(room, isNewRound);
  renderResult(room);
  renderLeaveButton(room);
}

function renderTurnUI(room) {
  renderTurn(room);
  renderMoveButtons(room);
  renderBench(room);
}

// HP바 하나를 지정된 색상 구간(초록/주황/빨강)으로 갱신. showNumbers가 false면 텍스트는 비워둠(적군 HP 숨김 등에 사용 가능).
function updateHpBar(barId, textId, hp, maxHp, showNumbers) {
  const bar = document.getElementById(barId), txt = textId ? document.getElementById(textId) : null;
  if (!bar) return;
  const pct = maxHp > 0 ? Math.max(0, Math.min(100, (hp / maxHp) * 100)) : 0;
  bar.style.width = pct + "%";
  bar.style.backgroundColor = pct > 50 ? "#4caf50" : pct > 20 ? "#ff9800" : "#f44336";
  if (txt) txt.innerText = showNumbers ? `HP: ${hp} / ${maxHp}` : "";
}

// mine/enemy 포트레이트를 갱신. animate가 true면 등장 슬라이드 애니메이션을 재생(교체 시에만 사용).
function updatePortrait(prefix, pokemon, animate = false) {
  const img = document.getElementById(`${prefix}-portrait`);
  const placeholder = document.getElementById(`${prefix}-portrait-placeholder`);
  if (!img) return;
  if (!pokemon?.portrait) {
    img.classList.remove("visible"); img.style.display = "none";
    if (placeholder) placeholder.style.display = "block"; return;
  }
  if (placeholder) placeholder.style.display = "none";
  img.classList.remove("visible", "slide-in-mine", "slide-in-enemy");
  img.style.display = "block"; img.src = pokemon.portrait; img.alt = pokemon.name;
  setTimeout(() => {
    img.classList.add("visible", ...(animate ? [prefix === "mine" ? "slide-in-mine" : "slide-in-enemy"] : []));
  }, 80);
}

// 공격 연출: 공격자 플래시 + 화면 흔들림 + (짧은 딜레이 후) 피격자 흔들림
function triggerAttackEffect(atkPfx, defPfx) {
  return new Promise(resolve => {
    const atkArea = document.getElementById(`${atkPfx}-pokemon-area`);
    const defArea = document.getElementById(`${defPfx}-pokemon-area`);
    const wrapper = document.getElementById("battle-wrapper");
    if (atkArea) { atkArea.classList.add("attacker-flash"); atkArea.addEventListener("animationend", () => atkArea.classList.remove("attacker-flash"), { once: true }); }
    if (wrapper) { wrapper.classList.add("screen-shake"); wrapper.addEventListener("animationend", () => wrapper.classList.remove("screen-shake"), { once: true }); }
    setTimeout(() => {
      if (defArea) { defArea.classList.add("defender-hit"); defArea.addEventListener("animationend", () => { defArea.classList.remove("defender-hit"); resolve(); }, { once: true }); }
      else resolve();
    }, 120);
  });
}

// 도트 데미지(독/화상) 등 공격자가 없는 피해에 쓰는 단순 깜빡임 연출
function triggerBlink(prefix) {
  return new Promise(resolve => {
    const area = document.getElementById(`${prefix}-pokemon-area`);
    if (!area) { resolve(); return; }
    area.classList.add("blink-damage");
    area.addEventListener("animationend", () => { area.classList.remove("blink-damage"); resolve(); }, { once: true });
  });
}

// mine/enemy 패널의 HP바/스탯/초상화를 즉시(연출 없이) 채워 넣음.
// 슬라이드 인 연출이 필요하면 호출부에서 updatePortrait(side, pkmn, true)를 따로 호출한다.
function applyPokemonVisual(side, pkmn, idx) {
  const hpText = document.getElementById(`${side}-hp`);
  const hpBar = document.getElementById(`${side}-hp-bar`);
  const stats = document.getElementById(`${side}-stats`);
  if (!hpText || !hpBar || !stats) return;

  if (!pkmn) {
    hpText.innerText = "-";
    hpBar.style.width = "0%";
    stats.innerText = "";
    updatePortrait(side, null);
    return;
  }

  updateHpBar(`${side}-hp-bar`, `${side}-hp`, pkmn.hp, pkmn.maxHp, true);
  stats.innerText = formatPokemonName(pkmn);

  const portrait = document.getElementById(`${side}-portrait`);
  if (portrait) portrait.classList.toggle("fainted", pkmn.hp <= 0);
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
      !actionInFlight;
    const usable = canAct && (move.pp ?? 0) > 0;

    const moveData = MOVES[move.name];
    btn.style.display = "inline-block";
    btn.style.backgroundColor = TYPE_COLORS[moveData?.type] ?? "var(--accent)";
    btn.style.opacity = usable ? "1" : "0.45";
    btn.textContent = `${move.name} (PP ${move.pp})`;
    btn.disabled = !usable;
    btn.onclick = () => {
      playButtonSound();
      useMove(i);
    };
  }
}

// 양쪽 벤치를 렌더링. 클릭 가능한 건 "내 쪽"이고, 교체 대기 중이거나(강제) 내 차례에 자발적 교체가 가능할 때만.
// dataKey(p1/p2)는 room 문서에서 데이터를 읽는 키, uiKey(mine/enemy)는 화면에 표시되는 위치.
function renderBench(room) {
  const { mineKey, enemyKey } = perspectiveKeys();
  renderBenchSide(mineKey, "mine", room);
  renderBenchSide(enemyKey, "enemy", room);
}

function renderBenchSide(dataKey, uiKey, room) {
  const container = document.getElementById(`${uiKey}-bench`);
  if (!container) return;

  const entry = room[`${dataKey}_entry`] ?? [];
  const activeIdx = room[`${dataKey}_active_idx`] ?? 0;
  const myKey = slotKey(mySlot);
  const pendingSwitch = !!room[`${dataKey}_pending_switch`];
  const anyonePending = !!room.p1_pending_switch || !!room.p2_pending_switch;

  const canForcedSwitch = myKey === dataKey && pendingSwitch;
  const canVoluntarySwitch =
    myKey === dataKey &&
    !pendingSwitch &&
    !anyonePending &&
    !room.battle_winner &&
    !isAnimating &&
    !actionInFlight &&
    room.battle_turn === dataKey;

  container.innerHTML = "";
  container.style.flexWrap = "wrap";
  container.style.gap = "6px";

  if (myKey !== dataKey) return; // 상대 벤치는 아예 표시하지 않음

  entry.forEach((pkmn, idx) => {
    if (!pkmn) return;

    const isActive = idx === activeIdx && !pendingSwitch;
    if (isActive) return; // 이미 출전 중인 포켓몬은 벤치에 버튼을 표시하지 않음

    const isFainted = pkmn.hp <= 0;
    const usable = (canForcedSwitch || canVoluntarySwitch) && !isFainted;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bench-btn";
    btn.disabled = !usable;
    if (isFainted) btn.classList.add("fainted");

    const name = document.createElement("span");
    name.className = "bench-name";
    name.textContent = formatPokemonName(pkmn);
    btn.appendChild(name);

    const hp = document.createElement("span");
    hp.className = "bench-hp";
    hp.textContent = `${pkmn.hp}/${pkmn.maxHp}`;
    btn.appendChild(hp);

    btn.onclick = () => {
      playButtonSound();
      switchPokemon(idx);
    };
    container.appendChild(btn);
  });

  container.style.display = "flex";
}

// ---- 로그 타이핑 + 전투 연출 시퀀서 ----
// battle_log(대사 한 줄씩)와 battle_event_log(그 줄에 달린 연출: 피격/교체)를 함께 받아서
// "로그 한 줄 타이핑 -> (그 줄에 연출이 달려 있으면 재생 + HP바 반영) -> 다음 줄" 순서로 재생한다.
const LOG_MAX_LINES = 8;
const LOG_TYPE_CHAR_MS = 18; // 한 글자 타이핑 간격
const LOG_TYPE_GAP_MS = 80; // 한 스텝 끝난 후 다음 스텝 시작 전 여백
const HIT_ANIM_DELAY_MS = 350; // 로그 타이핑이 끝난 뒤 shake/blink 연출 시작까지의 텀

let renderedLogCount = 0; // 지금까지 큐에 반영한 로그 줄 수
let renderedEventCount = 0; // 지금까지 큐에 반영한 연출 이벤트 수
let boardInitialized = false; // 최초 진입/재접속 시엔 연출 없이 즉시 표시
let boardQueue = []; // { kind: "log", text } | { kind: "hit"|"switch", side, pkmn, idx, hasAttacker? }
let boardBusy = false;

function trimLogLines(el) {
  while (el.children.length > LOG_MAX_LINES) {
    el.removeChild(el.firstChild);
  }
}

function appendLogLineInstant(el, text) {
  const div = document.createElement("div");
  div.textContent = text;
  el.appendChild(div);
  trimLogLines(el);
}

function typeLogLine(text, onDone) {
  const el = document.getElementById("battle-log");
  if (!el) { onDone(); return; }

  const div = document.createElement("div");
  el.appendChild(div);

  const chars = [...text];
  let i = 0;
  function typeNext() {
    if (i >= chars.length) {
      trimLogLines(el);
      onDone();
      return;
    }
    div.textContent += chars[i++];
    el.scrollTop = el.scrollHeight;
    setTimeout(typeNext, LOG_TYPE_CHAR_MS);
  }
  typeNext();
}

function processBoardQueue() {
  if (boardBusy) return;
  if (boardQueue.length === 0) {
    tryStartPendingDiceRoll(); // 큐가 방금 다 비었으면, 대기 중이던 다음 라운드 다이스를 굴림
    return;
  }
  boardBusy = true;
  const step = boardQueue.shift();
  const next = () => {
    boardBusy = false;
    setTimeout(processBoardQueue, LOG_TYPE_GAP_MS);
  };

  if (step.kind === "log") {
    typeLogLine(step.text, next);
    return;
  }

  if (step.kind === "hit") {
    // 로그가 다 보인 뒤 잠깐 텀을 두고 나서야 shake/blink 연출이 시작되도록
    setTimeout(() => {
      const atkSide = step.side === "mine" ? "enemy" : "mine";
      const playEffect = step.hasAttacker ? triggerAttackEffect(atkSide, step.side) : triggerBlink(step.side);
      playEffect.then(() => {
        applyPokemonVisual(step.side, step.pkmn, step.idx);
        next();
      });
    }, HIT_ANIM_DELAY_MS);
    return;
  }

  if (step.kind === "switch") {
    updatePortrait(step.side, step.pkmn, true);
    applyPokemonVisual(step.side, step.pkmn, step.idx);
    setTimeout(next, 400); // 슬라이드 인 연출 재생 시간만큼 대기
    return;
  }

  next();
}

// room 스냅샷 -> 로그/연출 재생 큐 구성. 최초 렌더는 즉시 전부 표시하고,
// 그 이후엔 새로 추가된 줄만 한 줄씩, 해당 줄에 달린 연출과 함께 순서대로 재생한다.
function renderLogAndBoard(room, isNewRound = false) {
  const el = document.getElementById("battle-log");
  if (!el) return;

  const log = room.battle_log ?? [];
  const events = room.battle_event_log ?? [];

  if (log.length < renderedLogCount) {
    // 새 전투 등으로 로그가 리셋된 경우
    el.innerHTML = "";
    renderedLogCount = 0;
    renderedEventCount = 0;
    boardInitialized = false;
    boardQueue = [];
    boardBusy = false;
    pendingFirstMoveLog = null;
  }

  const { mineKey, enemyKey } = perspectiveKeys();
  const mineIdx = room[`${mineKey}_active_idx`] ?? 0;
  const enemyIdx = room[`${enemyKey}_active_idx`] ?? 0;
  const minePkmn = room[`${mineKey}_entry`]?.[mineIdx] ?? null;
  const enemyPkmn = room[`${enemyKey}_entry`]?.[enemyIdx] ?? null;

  if (!boardInitialized) {
    // 최초 렌더링(또는 재접속)은 기존 로그/보드를 연출 없이 즉시 표시
    const holdLast = isNewRound && log.length > 0;
    const visibleLog = holdLast ? log.slice(0, -1) : log;

    el.innerHTML = "";
    visibleLog.slice(-LOG_MAX_LINES).forEach((line) => appendLogLineInstant(el, line));
    el.scrollTop = el.scrollHeight;
    renderedLogCount = log.length;
    renderedEventCount = events.length;
    if (holdLast) pendingFirstMoveLog = { text: log[log.length - 1] };

    applyPokemonVisual("mine", minePkmn, mineIdx);
    updatePortrait("mine", minePkmn, false);
    applyPokemonVisual("enemy", enemyPkmn, enemyIdx);
    updatePortrait("enemy", enemyPkmn, false);

    boardInitialized = true;
    return;
  }

  if (log.length === renderedLogCount) return; // 새로 추가된 줄 없음

  const startIdx = renderedLogCount;
  const newLines = log.slice(renderedLogCount);
  const newEvents = events.slice(renderedEventCount);
  renderedLogCount = log.length;
  renderedEventCount = events.length;

  const sideMap = { [mineKey]: "mine", [enemyKey]: "enemy" };

  // 새 라운드가 시작된 경우, 마지막 줄(항상 "~의 선공!")은 다이스 연출이 끝난 뒤에 재생하도록 보류
  const holdLastLine = isNewRound && newLines.length > 0;
  const linesToQueue = holdLastLine ? newLines.slice(0, -1) : newLines;

  linesToQueue.forEach((text, i) => {
    boardQueue.push({ kind: "log", text });

    const absoluteIdx = startIdx + i;
    for (const ev of newEvents) {
      if (ev.logIndex !== absoluteIdx) continue;
      const side = sideMap[ev.side];

      if (ev.type === "hit") {
        const finalPkmn = side === "mine" ? minePkmn : enemyPkmn;
        const idx = side === "mine" ? mineIdx : enemyIdx;
        boardQueue.push({ kind: "hit", side, pkmn: { ...finalPkmn, hp: ev.hp }, idx, hasAttacker: ev.hasAttacker });
      } else if (ev.type === "switch") {
        const finalPkmn = side === "mine" ? minePkmn : enemyPkmn;
        boardQueue.push({ kind: "switch", side, pkmn: finalPkmn, idx: ev.idx });
      }
    }
  });

  if (holdLastLine) {
    pendingFirstMoveLog = { text: newLines[newLines.length - 1] };
  }

  processBoardQueue();
}

function renderTurn(room) {
  const el = document.getElementById("turn-indicator");
  if (room.battle_winner) {
    el.innerText = "배틀 종료";
    return;
  }

  const pendingSides = ["p1", "p2"].filter((s) => room[`${s}_pending_switch`]);
  if (pendingSides.length > 0) {
    const myKey = slotKey(mySlot);
    if (myKey && pendingSides.includes(myKey)) {
      el.innerText = "교체할 포켓몬을 선택!";
    } else {
      el.innerText = `${pendingSides.map((s) => displayName(s, room)).join(", ")} 교체 대기 중...`;
    }
    return;
  }

  if (!room.battle_turn) {
    el.innerText = "선공 결정 중...";
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

// 양쪽 주사위를 동시에 굴려서 실제 저장된 값(mineRoll, enemyRoll)으로 착지시킴
async function playDiceRoll(mineRoll, enemyRoll) {
  const diceRow = document.getElementById("diceRow");
  diceRow.style.display = "flex";
  document.getElementById("dice-mine").textContent = "-";
  document.getElementById("dice-enemy").textContent = "-";

  await Promise.all([
    animateOneDice("dice-mine", mineRoll),
    animateOneDice("dice-enemy", enemyRoll),
  ]);

  diceSound.currentTime = 0;
  diceSound.play().catch(() => {});

  await new Promise((resolve) => setTimeout(resolve, 700)); // 결과 잠깐 보여주기
  diceRow.style.display = "none";
}
// js/effecthandler.js
// 상태이상(status) / 상태변화(volatile) 부여 및 매턴 처리 담당.
//
// 기대하는 포켓몬 객체 필드:
//   status: null | "독" | "화상" | "얼음" | "마비"
//   statusData: 상태별 부가 정보 (예: 얼음의 freezeTurn)
//   volatiles: { [상태변화이름]: 부가정보 } (예: { "혼란": { duration, turnCount }, "풀죽음": {} })
//     상태변화끼리는 서로 다른 종류면 동시에 걸릴 수 있음(중첩 가능). 같은 종류는 중복 적용 불가.
//   types: array (예: ["독", "땅"]) - 면역 체크용

export const STATUS_LIST = ["독", "화상", "얼음", "마비"];
export const VOLATILE_LIST = ["혼란", "풀죽음"];

// 한국어 조사 자동 선택. word가 빈 값/한글이 아니면 받침 없는 쪽 기본값으로.
export function josa(word, type) {
  const fallback = { 은는: "은", 이가: "이", 을를: "을", 과와: "과", 으로: "으로" } [type] ?? "";
  if (!word) return fallback;
  
  const code = word.charCodeAt(word.length - 1);
  if (code < 0xAC00 || code > 0xD7A3) return fallback;
  
  const hasFinal = (code - 0xAC00) % 28 !== 0;
  if (type === "은는") return hasFinal ? "은" : "는";
  if (type === "이가") return hasFinal ? "이" : "가";
  if (type === "을를") return hasFinal ? "을" : "를";
  if (type === "과와") return hasFinal ? "과" : "와";
  if (type === "으로") return hasFinal ? "으로" : "로";
  return "";
}

function hasType(pokemon, typeName) {
  return Array.isArray(pokemon.types) && pokemon.types.includes(typeName);
}

// 상태이상별 면역 체크
function isImmuneToStatus(pokemon, statusName) {
  if (statusName === "독") return hasType(pokemon, "독") || hasType(pokemon, "강철");
  if (statusName === "화상") return hasType(pokemon, "불");
  return false;
}

// 포켓몬 이름 옆에 상태이상만 표시 ("피카츄 [마비]"). 상태변화는 표시 안 함.
export function formatPokemonName(pokemon) {
  if (!pokemon?.name) return "";
  return pokemon.status ? `${pokemon.name} [${pokemon.status}]` : pokemon.name;
}

// 상태이상 부여 시도. 면역이거나 이미 상태이상이 있으면 변화 없이 그대로 반환.
export function applyStatus(pokemon, statusName) {
  if (!STATUS_LIST.includes(statusName)) return pokemon;
  if (pokemon.status) return pokemon; // 상태이상끼리는 중첩 불가
  if (isImmuneToStatus(pokemon, statusName)) return pokemon;
  
  const statusData = statusName === "얼음" ? { freezeTurn: 0 } : {};
  return { ...pokemon, status: statusName, statusData };
}

// 상태변화 부여 시도. 같은 종류의 상태변화가 이미 있으면 변화 없이 그대로 반환.
// 다른 종류의 상태변화는 서로 중첩되어 동시에 걸릴 수 있음 (status와도 별개로 동시 보유 가능).
export function applyVolatile(pokemon, volatileName) {
  if (!VOLATILE_LIST.includes(volatileName)) return pokemon;
  if (pokemon.volatiles?.[volatileName]) return pokemon; // 같은 상태변화 중복 적용 불가

  let volatileData = {};
  if (volatileName === "혼란") {
    // 3~5턴 지속
    volatileData = { duration: 3 + Math.floor(Math.random() * 3), turnCount: 0 };
  }
  return { ...pokemon, volatiles: { ...pokemon.volatiles, [volatileName]: volatileData } };
}

// 상태변화를 하나라도 가지고 있는지 체크
export function hasAnyVolatile(pokemon) {
  return !!pokemon.volatiles && Object.keys(pokemon.volatiles).length > 0;
}

// 상태변화 맵에서 특정 항목만 제거한 새 맵을 반환
function removeVolatile(pokemon, volatileName) {
  const { [volatileName]: _removed, ...rest } = pokemon.volatiles ?? {};
  return rest;
}

// 턴 종료 시(다이스 던지기 직전) 독/화상 데미지 처리. 매턴 양쪽 포켓몬에 대해 호출.
// 반환: { pokemon: 갱신된 포켓몬, damage, message }
export function applyEndOfTurnStatusDamage(pokemon) {
  if (pokemon.status !== "독" && pokemon.status !== "화상") {
    return { pokemon, damage: 0, message: null };
  }
  
  const damage = Math.max(1, Math.floor(pokemon.maxHp / 16));
  const newHp = Math.max(0, pokemon.hp - damage);
  const updated = { ...pokemon, hp: newHp };
  const message = `${pokemon.name}${josa(pokemon.name, "이가")} ${pokemon.status} 데미지를 입었다! (${damage})`;
  
  return { pokemon: updated, damage, message };
}

// 얼음 해제 확률표 (얼음에 걸린 지 n턴째)
function freezeReleaseChance(freezeTurn) {
  if (freezeTurn <= 1) return 0.25;
  if (freezeTurn === 2) return 0.35;
  if (freezeTurn === 3) return 0.45;
  return 0.65; // 4턴째 이후 고정
}

// 자신의 턴이 시작될 때(기술 선택 전) 호출. 얼음/마비/풀죽음으로 행동 불가능한지 체크.
// 반환: { canAct: boolean, pokemon: 갱신된 포켓몬, message }
export function checkActionPrevented(pokemon) {
  if (pokemon.status === "얼음") {
    const freezeTurn = (pokemon.statusData?.freezeTurn ?? 0) + 1;
    const released = Math.random() < freezeReleaseChance(freezeTurn);
    
    if (released) {
      return {
        canAct: true,
        pokemon: { ...pokemon, status: null, statusData: {} },
        message: `${pokemon.name}의 얼음이 풀렸다!`,
      };
    }
    return {
      canAct: false,
      pokemon: { ...pokemon, statusData: { ...pokemon.statusData, freezeTurn } },
      message: `${pokemon.name}${josa(pokemon.name, "은는")} 얼어서 움직일 수 없다!`,
    };
  }
  
  if (pokemon.status === "마비") {
    const paralyzed = Math.random() < 0.2;
    if (paralyzed) {
      return {
        canAct: false,
        pokemon,
        message: `${pokemon.name}${josa(pokemon.name, "은는")} 마비되어 움직일 수 없다!`,
      };
    }
    return { canAct: true, pokemon, message: null };
  }
  
  if (pokemon.volatiles?.["풀죽음"]) {
    // 1턴 지속이라 이번 턴 막고 바로 해제
    return {
      canAct: false,
      pokemon: { ...pokemon, volatiles: removeVolatile(pokemon, "풀죽음") },
      message: `${pokemon.name}${josa(pokemon.name, "은는")} 풀이 죽어 움직일 수 없다!`,
    };
  }
  
  return { canAct: true, pokemon, message: null };
}

// checkActionPrevented에서 canAct: true가 나온 후, 혼란이면 한 번 더 체크.
// 40% 확률로 기술이 취소되고 자기 자신을 (atk * 2) 고정 데미지로 공격함.
// 반환: { confused: boolean, pokemon: 갱신된 포켓몬, selfDamage, message }
export function checkConfusionInterrupt(pokemon) {
  const confusionData = pokemon.volatiles?.["혼란"];
  if (!confusionData) {
    return { confused: false, pokemon, selfDamage: 0, message: null };
  }

  const turnCount = (confusionData.turnCount ?? 0) + 1;
  const duration = confusionData.duration ?? 3;

  // 지속 턴 종료 또는 3턴째부터 33.3% 확률로 회복
  const durationOver = turnCount >= duration;
  const recovered = !durationOver && turnCount >= 3 && Math.random() < 1 / 3;

  if (durationOver || recovered) {
    return {
      confused: false,
      pokemon: { ...pokemon, volatiles: removeVolatile(pokemon, "혼란") },
      selfDamage: 0,
      message: `${pokemon.name}의 혼란이 풀렸다!`,
    };
  }

  const updatedPokemon = {
    ...pokemon,
    volatiles: { ...pokemon.volatiles, "혼란": { ...confusionData, turnCount } },
  };
  
  if (Math.random() < 0.4) {
    const selfDamage = (pokemon.atk ?? 0) * 2;
    const newHp = Math.max(0, pokemon.hp - selfDamage);
    return {
      confused: true,
      pokemon: { ...updatedPokemon, hp: newHp },
      selfDamage,
      message: `${pokemon.name}${josa(pokemon.name, "은는")} 혼란에 빠져 자신을 공격했다! (${selfDamage})`,
    };
  }
  
  return { confused: false, pokemon: updatedPokemon, selfDamage: 0, message: null };
}
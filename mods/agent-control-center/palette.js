// Local Control Center layers. These never change Herdr's theme or Classic UI.
export function controlPalette(dark = true) {
  return {
    dark,
    toolbar: {
      bg: "#13243c", card: "#243c59", hover: "#355779", border: "#557396",
      text: "#f4f8ff", muted: "#c5d6eb", accent: "#8fe9df", accentText: "#102f35",
    },
    context: dark ? {
      bg: "#11161d", card: "#171e28", hover: "#202c3b", border: "#344158",
      text: "#f0f5ff", muted: "#adbbd0", accent: "#87aaff", accentText: "#0d1a32",
      orbOuter: "#24344f", chipBg: "#243650", chipText: "#bbd0ff",
    } : {
      bg: "#f7f9ff", card: "#ffffff", hover: "#edf3ff", border: "#becdeb",
      text: "#162641", muted: "#4e627d", accent: "#2d58ca", accentText: "#ffffff",
      orbOuter: "#e0e8ff", chipBg: "#e7efff", chipText: "#24478e",
    },
    attention: dark ? {
      bg: "#101010", card: "#191919", hover: "#262626", border: "#343434",
      text: "#f1f1f1", muted: "#b5b5b5", accent: "#c1cbd9", accentText: "#202020",
      nativeDot: "#86adff",
    } : {
      bg: "#fff2c6", card: "#fffaf0", hover: "#ffe6a0", border: "#d4ab57",
      text: "#463417", muted: "#6d552b", accent: "#2453bb", accentText: "#ffffff",
      nativeDot: "#2d65cc",
    },
    evidence: dark ? {
      bg: "#142033", card: "#1c2d43", hover: "#2b425f", border: "#54708e",
      text: "#eef5ff", muted: "#b9cce3", accent: "#8fded6", accentText: "#123733",
    } : {
      bg: "#edf2f8", card: "#ffffff", hover: "#dde7f2", border: "#7089a4",
      text: "#203851", muted: "#4a647f", accent: "#14665f", accentText: "#ffffff",
    },
    boundary: dark ? "#7399ba" : "#456c91",
    important: dark ? "#ffd176" : "#89510a",
    review: dark ? "#72e5d8" : "#106660",
    failure: dark ? "#ffb3a4" : "#a72d20",
  };
}

export function contrastRatio(first, second) {
  const luminance = color => {
    const rgb = color.replace("#", "").match(/../g).map(component => parseInt(component, 16) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

export function attentionCategory(item) {
  if (item?.type === "review") return "review";
  if (["conflict", "dependency"].includes(item?.type)) return "repository";
  return "decision";
}

export function boundedAttentionCards(items, tab, width) {
  return (items ?? []).filter(item => item.meaningful && attentionCategory(item) === tab)
    .slice(0, width < 600 ? 1 : width < 900 ? 2 : 3);
}

// Tell the person what selecting an item opens and what they should check.
export function attentionInstruction(item) {
  if (item?.type === "test_failure") return { button: "실패 근거 보기", next: "할 일: 실패 명령과 로그를 확인하고, 재실행이 필요한지 판단하세요." };
  if (item?.type === "review") return { button: "변경 검토", next: "할 일: 변경 내용과 실행한 검증을 확인하세요. 완료 보고만으로 검증되지는 않습니다." };
  if (["conflict", "dependency"].includes(item?.type)) return { button: "영향 비교", next: "할 일: 관련 작업과 변경 파일을 비교하세요. 잠재 영향이며 자동 병합하지 않습니다." };
  return { button: "요청 보기", next: "할 일: 이 에이전트의 요청을 읽고 해당 터미널에서 답변하거나 승인하세요." };
}

// Herdr's native done state is its unread completion dot. Stored review ACKs
// and historical test failures must never create entries in this list.
export function unreadCompletedAgents(nativeAgents, tasks) {
  const byAddress = new Map((tasks ?? []).map(task => [task.address, task]));
  return (nativeAgents ?? []).filter(agent => agent.status === "done")
    .map(agent => ({ agent, task: byAddress.get(agent.address) ?? null }));
}

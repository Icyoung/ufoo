const {
  buildAgentMaps,
  getAgentLabel,
  resolveAgentId,
  resolveAgentDisplayName,
  clampAgentWindowWithSelection,
} = require("../../../src/chat/agentDirectory");

describe("chat agentDirectory helpers", () => {
  test("buildAgentMaps prefers meta nickname, then fallback, then id", () => {
    const activeAgents = ["a:1", "b:2", "c:3"];
    const metaList = [{ id: "a:1", nickname: "alpha", display_nickname: "alpha", launch_mode: "internal" }];
    const fallback = new Map([["b:2", "beta"]]);

    const maps = buildAgentMaps(activeAgents, metaList, fallback);
    expect(maps.labelMap.get("a:1")).toBe("alpha");
    expect(maps.labelMap.get("b:2")).toBe("beta");
    expect(maps.labelMap.get("c:3")).toBe("c:3");
    expect(maps.metaMap.get("a:1")).toEqual(metaList[0]);
    expect(maps.metaMap.has("b:2")).toBe(false);
  });

  test("buildAgentMaps prefers display nickname over scoped/raw fallback", () => {
    const activeAgents = ["a:1"];
    const metaList = [{ id: "a:1", nickname: "neptune-alpha", display_nickname: "alpha" }];

    const maps = buildAgentMaps(activeAgents, metaList, null);
    expect(maps.labelMap.get("a:1")).toBe("alpha");
  });

  test("getAgentLabel returns mapped label or id", () => {
    const map = new Map([["a:1", "alpha"]]);
    expect(getAgentLabel(map, "a:1")).toBe("alpha");
    expect(getAgentLabel(map, "x:0")).toBe("x:0");
  });

  test("resolveAgentId resolves by id, label map, and fallback lookup", () => {
    const activeAgents = ["a:1"];
    const labelMap = new Map([["a:1", "alpha"]]);

    expect(resolveAgentId({ label: "a:1", activeAgents, labelMap })).toBe("a:1");
    expect(resolveAgentId({ label: "alpha", activeAgents, labelMap })).toBe("a:1");
    expect(resolveAgentId({
      label: "beta",
      activeAgents,
      labelMap,
      lookupNickname: (nick) => (nick === "beta" ? "b:2" : null),
    })).toBe("b:2");
    expect(resolveAgentId({ label: "none", activeAgents, labelMap })).toBeNull();
  });

  test("resolveAgentDisplayName prefers label map then fallback lookup", () => {
    const labelMap = new Map([["a:1", "alpha"]]);
    expect(resolveAgentDisplayName({ publisher: "a:1", labelMap })).toBe("alpha");
    expect(resolveAgentDisplayName({
      publisher: "b:2",
      labelMap,
      lookupNicknameById: (id) => (id === "b:2" ? "beta" : null),
    })).toBe("beta");
    expect(resolveAgentDisplayName({ publisher: "plain", labelMap })).toBe("plain");
  });

  test("clampAgentWindowWithSelection keeps selection visible", () => {
    expect(clampAgentWindowWithSelection({
      activeCount: 0,
      maxWindow: 4,
      windowStart: 10,
      selectionIndex: -1,
    })).toBe(0);

    expect(clampAgentWindowWithSelection({
      activeCount: 6,
      maxWindow: 4,
      windowStart: 0,
      selectionIndex: 5,
    })).toBe(2);

    expect(clampAgentWindowWithSelection({
      activeCount: 6,
      maxWindow: 4,
      windowStart: 3,
      selectionIndex: 1,
    })).toBe(1);
  });
});

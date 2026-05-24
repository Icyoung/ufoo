const {
  PTY_SOCKET_MESSAGE_TYPES,
  PTY_SOCKET_SUBSCRIBE_MODES,
} = require("../../../src/runtime/contracts/ptySocketContract");

describe("shared ptySocketContract", () => {
  test("defines expected PTY socket message types", () => {
    expect(PTY_SOCKET_MESSAGE_TYPES).toEqual({
      OUTPUT: "output",
      REPLAY: "replay",
      SNAPSHOT: "snapshot",
      SUBSCRIBED: "subscribed",
      SUBSCRIBE: "subscribe",
      RAW: "raw",
      RESIZE: "resize",
    });
  });

  test("defines subscribe modes", () => {
    expect(PTY_SOCKET_SUBSCRIBE_MODES).toEqual({
      FULL: "full",
      SCREEN: "screen",
    });
  });
});

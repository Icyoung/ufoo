"use strict";

const PTY_SOCKET_MESSAGE_TYPES = {
  OUTPUT: "output",
  REPLAY: "replay",
  SNAPSHOT: "snapshot",
  SUBSCRIBED: "subscribed",
  SUBSCRIBE: "subscribe",
  RAW: "raw",
  RESIZE: "resize",
};

const PTY_SOCKET_SUBSCRIBE_MODES = {
  FULL: "full",
  SCREEN: "screen",
};

module.exports = {
  PTY_SOCKET_MESSAGE_TYPES,
  PTY_SOCKET_SUBSCRIBE_MODES,
};

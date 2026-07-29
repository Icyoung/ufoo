"use strict";

const EventBus = require("../../coordination/bus");

class AgentProcessManager {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.processes = new Map(); // subscriber_id -> { child, onExit, onError }
  }

  /**
   * 注册子进程并监听退出事件
   */
  register(subscriberId, childProcess) {
    if (!subscriberId || !childProcess) return;

    const onExit = (code, signal) => {
      this.processes.delete(subscriberId);

      // 自动清理 bus 状态
      try {
        const eventBus = new EventBus(this.projectRoot);
        eventBus.loadBusData();
        if (eventBus.busData.agents?.[subscriberId]) {
          eventBus.busData.agents[subscriberId].status = "inactive";
          eventBus.busData.agents[subscriberId].last_seen = new Date().toISOString();
          eventBus.saveBusData();
          console.log(`[daemon] Agent ${subscriberId} exited (code=${code}, signal=${signal}), marked inactive`);
        }
      } catch (err) {
        console.error(`[daemon] Failed to cleanup ${subscriberId}:`, err.message);
      }
    };

    const onError = (err) => {
      console.error(`[daemon] Agent ${subscriberId} error:`, err.message);
      this.processes.delete(subscriberId);
    };
    this.processes.set(subscriberId, {
      child: childProcess,
      onExit,
      onError,
    });
    childProcess.on("exit", onExit);
    childProcess.on("error", onError);
  }

  /**
   * 获取运行中的进程
   */
  get(subscriberId) {
    return this.processes.get(subscriberId)?.child;
  }

  /**
   * 获取所有进程数量
   */
  count() {
    return this.processes.size;
  }

  /**
   * 清理所有子进程
   */
  cleanup(options = {}) {
    const terminate = options.terminate !== false;
    for (const [subscriberId, entry] of this.processes.entries()) {
      const { child, onExit, onError } = entry;
      if (terminate) {
        try {
          child.kill("SIGTERM");
          console.log(`[daemon] Killed agent ${subscriberId}`);
        } catch {
          // ignore
        }
      } else {
        // Global-daemon ownership is logical, not a parent/child lifetime
        // contract. Let the runner survive daemon replacement and reconnect
        // through its durable bus state.
        try {
          child.removeListener("exit", onExit);
          child.removeListener("error", onError);
          if (typeof child.unref === "function") child.unref();
        } catch {
          // best-effort detachment
        }
      }
    }
    this.processes.clear();
  }
}


module.exports = { AgentProcessManager };

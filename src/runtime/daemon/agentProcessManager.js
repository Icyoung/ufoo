"use strict";

const EventBus = require("../../coordination/bus");

class AgentProcessManager {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.processes = new Map(); // subscriber_id -> child_process
  }

  /**
   * 注册子进程并监听退出事件
   */
  register(subscriberId, childProcess) {
    if (!subscriberId || !childProcess) return;

    this.processes.set(subscriberId, childProcess);

    childProcess.on("exit", (code, signal) => {
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
    });

    childProcess.on("error", (err) => {
      console.error(`[daemon] Agent ${subscriberId} error:`, err.message);
      this.processes.delete(subscriberId);
    });
  }

  /**
   * 获取运行中的进程
   */
  get(subscriberId) {
    return this.processes.get(subscriberId);
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
  cleanup() {
    for (const [subscriberId, child] of this.processes.entries()) {
      try {
        child.kill("SIGTERM");
        console.log(`[daemon] Killed agent ${subscriberId}`);
      } catch {
        // ignore
      }
    }
    this.processes.clear();
  }
}


module.exports = { AgentProcessManager };

"use strict";

const { composeCapabilities } = require("./composeCapabilities");
const { runAgentLoop } = require("./core/agentLoop");
const { assertTransport } = require("../providers/transports/transportContract");
const { randomUUID, createHash } = require("crypto");
const { createCommandStore } = require("./context/commandStore");
const { stableStringify } = require("./core/stableJson");
const { createRuntimeHooks, formatWakeEvent } = require("./tasks/hooks");

const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "waiting_user"]);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } };

function terminalResult(result) {
  if (!Array.isArray(result?.messages) || !Number.isInteger(result.historyOffset)) return result;
  // Persist this invocation once, rather than repeating all preceding turns.
  // Paused invocations retain their full input separately for tool resume.
  return { ...result, messages: result.messages.filter(message => message.role !== "system").slice(result.historyOffset), historyOffset: 0 };
}

/** A host injects persistence and preparation; core owns accepted invocation lifecycle. */
function createAgentRuntime({ profile, transport, capabilities, host = {}, defaults = {} } = {}) {
  assertTransport(transport);
  const composition = composeCapabilities({ profile, capabilities, host, providerFeatures: transport.features || [] });
  let running = false;
  let closed = false;
  let pumpPromise = null;
  let controller = null;
  let activeTask = "";
  let activeRun = null;
  let runController = null;
  let closePromise = null;
  let hooks = host.runtimeHooks || null;
  const ownsHooks = !hooks && Boolean(host.hookSources && host.sessionStore);
  const ownerId = randomUUID();
  const waiters = new Map();
  const storage = host.sessionStore;
  const store = storage && Object.freeze({ ...storage,
    transaction(mutator) {
      return storage.transaction((state) => {
        const additions = mutator(state) || [];
        const events = [];
        for (const event of additions) {
          events.push(event);
          for (const update of composition.reduceState(state.capabilityState, event)) {
            events.push({ type: "capability.state_committed", ...update });
            state.capabilityState[update.capabilityId] = { version: update.version, value: update.value };
          }
        }
        return events;
      });
    },
    append(event) { return this.transaction(() => [event]); },
  });
  const commandStore = store && createCommandStore(store);
  const requireStore = () => { if (!store) throw new Error("durable runtime requires host.sessionStore"); };
  const notify = () => {
    if (!store) return;
    const state = store.read();
    for (const [id, listeners] of waiters) {
      const task = state.tasks[id];
      if (task && terminal.has(task.status)) { listeners.forEach((resolve) => resolve(task)); waiters.delete(id); }
    }
  };
  let interruptedTasks = [];
  if (store) store.transaction((state) => {
    if (state.profile && state.profile !== (profile && profile.id || "custom")) throw new Error("session profile is pinned; use a new session or explicit checkpoint migration");
    if (state.owner && pidAlive(state.owner.pid)) throw Object.assign(new Error("runtime session already owned"), { code: "runtime_busy" });
    const selectedCapabilities = composition.capabilities.map((capability) => capability.id);
    const matchesAdditively = Array.isArray(state.capabilities)
      && stableStringify(state.capabilities) === stableStringify(selectedCapabilities.filter((id) => !["turn-recall", "browser", "mac-app"].includes(id) || state.capabilities.includes(id)));
    if (state.capabilities && stableStringify(state.capabilities) !== stableStringify(selectedCapabilities) && !matchesAdditively
      && Object.values(state.tasks).some((task) => ["queued", "running", "waiting_user"].includes(task.status))) throw new Error("cannot change capabilities with unfinished state; use a new session or explicit migration");
    interruptedTasks = Object.values(state.tasks).filter((task) => task.status === "running");
    return [...interruptedTasks.map((task) => ({
      type: "task.interrupted", taskRunId: task.taskRunId, error: "owner stopped; inspect effects before resubmitting",
    })), { type: "runtime.opened", owner: { id: ownerId, pid: process.pid, profile: profile && profile.id || "custom", capabilities: selectedCapabilities } }];
  });
  if (interruptedTasks.length && typeof host.onTasksInterrupted === "function") {
    try { host.onTasksInterrupted(interruptedTasks); } catch {}
  }
  const record = async (event) => {
    const before = store.read();
    const task = before.tasks[event.taskRunId];
    event = { version: 1, projectId: host.projectId || "", agentId: host.agentId || "", sessionId: before.sessionId,
      requestId: task?.request.requestId || "", taskId: task?.request.taskId || event.taskRunId || "", attemptId: task?.attemptId || "",
      traceId: task?.request.traceId || task?.request.taskId || event.taskRunId || "",
      parentTaskRunId: task?.request.parentTaskRunId || "", parentSessionId: task?.request.parentSessionId || "", ...event };
    let sequence;
    const snapshot = store.transaction((state) => { sequence = state.sequence + 1; return [event]; });
    const committed = store.events({ after: sequence - 1 }).find((entry) => entry.sequence === sequence);
    notify();
    if (host.eventSink) {
      try { await host.eventSink(committed); }
      catch (error) { if (host.onObserverError) host.onObserverError(error); }
    }
    const proposals = await composition.handleEvent(committed);
    for (let index = 0; index < proposals.length; index += 1) {
      const command = proposals[index];
      if (!host.commandExecutor) throw new Error("host.commandExecutor is required for capability commands");
      if ((command.permissions || []).some((permission) => !(host.grantedPermissions || []).includes(permission))) throw new Error("capability command exceeds host permissions");
      const commandId = `event-${createHash("sha256").update(`${sequence}:${command.capabilityId}:${index}`).digest("hex").slice(0, 32)}`;
      await commandStore.execute({ commandId, kind: command.name, args: command.args }, () => host.commandExecutor(command));
    }
    return snapshot;
  };
  async function pump() {
    while (!closed) {
      const snapshot = store.read();
      const waitingUser = Object.values(snapshot.tasks).some(item => item.status === "waiting_user");
      const task = Object.values(snapshot.tasks).filter((item) => item.status === "queued" && (!item.request.runtimeEvent || !waitingUser))
        .sort((a, b) => Number(Boolean(a.request.runtimeEvent)) - Number(Boolean(b.request.runtimeEvent)) || a.sequence - b.sequence)[0];
      if (!task) return;
      activeTask = task.taskRunId;
      controller = new AbortController();
      const attemptId = `attempt_${randomUUID()}`;
      try {
        const execute = async (signal) => {
          await record({ type: "task.started", taskRunId: activeTask, attemptId });
          const prepared = task.answer !== undefined && task.result && host.resumeRequest
            ? await host.resumeRequest(task, task.answer)
            : host.prepareRequest ? await host.prepareRequest(task.request, task) : { prompt: task.request.text };
          return runtime.run({ ...prepared, requestId: task.request.requestId,
            requestKind: task.request.requestKind || prepared.requestKind,
            taskId: task.request.taskId || task.taskRunId, taskRunId: task.taskRunId, attemptId,
            traceId: task.request.traceId || task.request.taskId || task.taskRunId,
            parentTaskRunId: task.request.parentTaskRunId || "", parentSessionId: task.request.parentSessionId || "",
            signal, onEvent: record });
        };
        const result = host.taskScheduler
          ? await host.taskScheduler.schedule({ id: task.taskRunId, resourceKey: task.request.resourceKey || "", signal: controller.signal }, execute)
          : await execute(controller.signal);
        if (controller.signal.aborted) throw Object.assign(new Error("agent cancelled"), { code: "cancelled" });
        if (result.error || result.stopReason) throw Object.assign(new Error(result.error || `agent stopped: ${result.stopReason}`), { code: result.stopReason || "runtime_error", result });
        const terminal = result.waitingUserInteraction ? result : terminalResult(result);
        const slicedTurnMessages = Array.isArray(result.messages) && Number.isInteger(result.historyOffset)
          ? result.messages.filter((message) => message.role !== "system").slice(result.historyOffset)
          : (terminal.messages || []);
        if (typeof host.onTurnSettled === "function") {
          try {
            const settledEvent = await host.onTurnSettled({
              task,
              outcome: result.waitingUserInteraction ? "paused" : "completed",
              result,
              messages: slicedTurnMessages,
              historyOffset: Number.isInteger(result.historyOffset) ? result.historyOffset : 0,
            });
            if (settledEvent && settledEvent.type) await record(settledEvent);
          } catch {}
        }
        await record({ type: result.waitingUserInteraction ? "task.paused" : "task.completed", taskRunId: activeTask,
          result: terminal });
      } catch (error) {
        if (store.read().tasks[activeTask]?.status === "completed") {
          if (host.onError) host.onError(error);
          continue;
        }
        const cancelled = controller.signal.aborted || error.code === "cancelled";
        const errTerminal = error.result ? terminalResult(error.result) : null;
        if (typeof host.onTurnSettled === "function") {
          try {
            const settledEvent = await host.onTurnSettled({
              task,
              outcome: cancelled ? "cancelled" : "failed",
              error: error.message,
              code: error.code || "runtime_error",
              result: error.result || null,
              messages: errTerminal && Array.isArray(errTerminal.messages) ? errTerminal.messages : [],
              historyOffset: Number.isInteger(error.result?.historyOffset) ? error.result.historyOffset : 0,
            });
            if (settledEvent && settledEvent.type) await record(settledEvent);
          } catch {}
        }
        await record({ type: cancelled ? "task.cancelled" : "task.failed",
          taskRunId: activeTask, error: error.message, code: error.code || "runtime_error", ...(error.result ? { result: errTerminal } : {}) });
      } finally { activeTask = ""; controller = null; }
    }
  }
  function startPump() {
    if (pumpPromise || closed) return;
    pumpPromise = Promise.resolve().then(pump).catch((error) => {
      if (host.onError) host.onError(error);
    }).finally(() => {
      pumpPromise = null;
      notify();
      const tasks = Object.values(store.read().tasks);
      if (!closed && tasks.some(task => task.status === "queued" && (!task.request.runtimeEvent || !tasks.some(item => item.status === "waiting_user")))) startPump();
    });
  }
  const runtime = Object.freeze({
    tools: composition.tools,
    capabilities: composition.capabilities,
    buildContext: composition.buildContext,
    promptSections: composition.promptSections,
    get hooks() { return hooks; },
    async run(input = {}) {
      if (closed) throw Object.assign(new Error("agent runtime is closed"), { code: "runtime_closed" });
      if (running) throw Object.assign(new Error("agent runtime is already running"), { code: "runtime_busy" });
      running = true;
      runController = new AbortController();
      const externalSignal = input.signal || defaults.signal;
      const forwardAbort = () => runController && runController.abort(externalSignal.reason);
      if (externalSignal) {
        if (externalSignal.aborted) forwardAbort();
        else externalSignal.addEventListener("abort", forwardAbort, { once: true });
      }
      try {
        activeRun = runAgentLoop({
          ...defaults, ...input, transport,
          runtimeHooks: hooks,
          tools: composition.tools, policies: composition.policies,
          signal: runController.signal,
        });
        return await activeRun;
      } finally {
        if (runController.signal.aborted && runController.signal.reason !== "runtime_closed") {
          hooks?.cancelOwner(input.taskRunId);
          if (input.requestKind === "system_wake" && input.parentTaskRunId) hooks?.cancelOwner(input.parentTaskRunId);
        }
        running = false;
        activeRun = null;
        runController = null;
        if (externalSignal) externalSignal.removeEventListener("abort", forwardAbort);
      }
    },
    submit(input = {}) {
      requireStore();
      if (closed) throw new Error("agent runtime is closed");
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(input.requestId || "")) throw new Error("requestId is required and must be a safe identifier");
      if (typeof input.text !== "string" || !input.text.trim()) throw new Error("request text is required");
      const request = JSON.parse(JSON.stringify(input));
      if (Array.isArray(request.attachments) && !request.attachments.length) delete request.attachments;
      if (request.requestMeta && !Object.keys(request.requestMeta).length) delete request.requestMeta;
      const fingerprint = createHash("sha256").update(stableStringify(request)).digest("hex");
      let id;
      const state = store.transaction((current) => {
        id = Object.prototype.hasOwnProperty.call(current.requests, request.requestId) ? current.requests[request.requestId] : "";
        if (id) {
          if (current.tasks[id].request.fingerprint !== fingerprint) throw Object.assign(new Error("requestId reused with different content"), { code: "request_conflict" });
          return [];
        }
        if (Object.values(current.tasks).filter((task) => task.status === "queued").length >= (host.maxQueuedTasks || 128)) throw Object.assign(new Error("runtime queue is full"), { code: "queue_full" });
        id = `task_${randomUUID()}`;
        return [{ type: "request.accepted", taskRunId: id, request: { ...request, fingerprint } }];
      });
      startPump();
      return { accepted: true, requestId: request.requestId, taskRunId: id, status: state.tasks[id].status, sequence: state.sequence };
    },
    wake(event) {
      const original = store.read().tasks[event.ownerTaskRunId]?.request.text || "";
      return runtime.submit({ requestId: event.id, text: `${formatWakeEvent(event)}\nOriginal task (historical context; preserve its language): ${JSON.stringify(original)}`, runtimeEvent: event.id,
        parentTaskRunId: event.ownerTaskRunId, requestKind: "system_wake" });
    },
    async resume({ interactionId, answer } = {}) {
      requireStore();
      if (closed) throw new Error("agent runtime is closed");
      if (typeof host.resumeRequest !== "function") throw new Error("host.resumeRequest is required for interactions");
      const state = store.read();
      const task = Object.values(state.tasks).find((item) => item.status === "waiting_user" && item.interactionId === interactionId);
      if (!task) {
        const previous = Object.values(state.tasks).find((item) => item.answeredInteractionId === interactionId);
        if (previous && stableStringify(previous.answer) === stableStringify(answer)) return { accepted: true, taskRunId: previous.taskRunId, status: previous.status };
        throw new Error("interaction is not pending or its answer conflicts");
      }
      if (host.validateAnswer) await host.validateAnswer(task, answer);
      store.transaction((current) => {
        if (current.tasks[task.taskRunId].status !== "waiting_user") throw new Error("interaction already answered");
        return [{ type: "interaction.answered", taskRunId: task.taskRunId, interactionId, answer }];
      });
      startPump();
      return { accepted: true, taskRunId: task.taskRunId };
    },
    cancel({ taskRunId, reason = "user_cancel" } = {}) {
      requireStore();
      const task = store.read().tasks[taskRunId];
      if (!task) throw new Error("task not found");
      hooks?.cancelOwner(taskRunId);
      store.transaction(state => Object.values(state.tasks).filter(item => item.request.runtimeEvent && item.request.parentTaskRunId === taskRunId && item.status === "queued")
        .map(item => ({ type: "task.cancelled", taskRunId: item.taskRunId, error: reason })));
      if (controller && store.read().tasks[activeTask]?.request.runtimeEvent && store.read().tasks[activeTask]?.request.parentTaskRunId === taskRunId) controller.abort(reason);
      notify();
      if (terminal.has(task.status) && task.status !== "waiting_user") return { taskRunId, status: task.status };
      if (activeTask === taskRunId && controller) {
        store.append({ type: "task.cancel_requested", taskRunId, reason });
        controller.abort(reason);
      } else store.append({ type: "task.cancelled", taskRunId, error: reason });
      notify();
      return { taskRunId, status: activeTask === taskRunId ? "cancelling" : "cancelled" };
    },
    snapshot() { return store ? store.read() : { running, closed }; },
    events(input) { requireStore(); return store.events(input); },
    wait(taskRunId) {
      requireStore();
      const task = store.read().tasks[taskRunId];
      if (!task) return Promise.reject(new Error("task not found"));
      if (terminal.has(task.status)) return Promise.resolve(task);
      return new Promise((resolve) => { const listeners = waiters.get(taskRunId) || []; listeners.push(resolve); waiters.set(taskRunId, listeners); });
    },
    async close() {
      if (closePromise) return closePromise;
      closed = true;
      if (ownsHooks) hooks?.close();
      if (controller) controller.abort("runtime_closed");
      if (runController) runController.abort("runtime_closed");
      closePromise = (async () => {
        if (activeRun) await activeRun.catch(() => {});
        if (pumpPromise) await pumpPromise;
        let disposalError;
        for (const capability of composition.capabilities.slice().reverse()) if (capability.dispose) {
          try { await capability.dispose(); } catch (error) { disposalError = disposalError || error; }
        }
        if (typeof host.onClose === "function") {
          try { await host.onClose(); } catch (error) { disposalError = disposalError || error; }
        }
        if (store) store.transaction((state) => state.owner && state.owner.id === ownerId ? [{ type: "runtime.closed" }] : []);
        notify();
        if (disposalError) throw disposalError;
      })();
      return closePromise;
    },
  });
  if (ownsHooks) {
    hooks = createRuntimeHooks({ store, sources: host.hookSources, deliver: event => runtime.wake(event),
      canDeliver: () => !closed && !running && !Object.values(store.read().tasks).some(task => ["running", "queued", "waiting_user"].includes(task.status)),
      onError: error => host.onError?.(error) });
    hooks.start();
  }
  if (store) startPump();
  return runtime;
}

module.exports = { createAgentRuntime };

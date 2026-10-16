/**
 * 注入侧翻译层：codex app-server **通知** → tt 壳可直接 fire 的 `chat/*` action。
 *
 * ★ 依据（2026-10-10 22:20 对 bundle 的源码实证）：
 *   - tt 里 `onDidSessionProgress: this._onDidChatProgress`  ⇒ 二者是**同一个 emitter**。
 *   - provider 通过 `_onDidSessionProgress.fire({kind:"action", resource, action, parentToolCallId})`
 *     向外发布；service 层 `_wireEntry` 订阅后转发到 `_onDidChatProgress`。
 *   - `resource` 必须是 **该 chat 的 chatChannelUri**（sendMessage 的第 1 参就是它）。
 *   - action 的 type 取值（实测全集，节选与文本流相关的）：
 *       chat/turnStarted      {type, turnId, startedAt, message:{text, origin:{kind:"user"}}}
 *       chat/responsePart     {type, turnId, part:{kind:"markdown"|"reasoning", id, content}}
 *       chat/delta            {type, turnId, partId, content}
 *       chat/reasoning        {type, turnId, partId, content}
 *       chat/turnComplete     {type, turnId, duration}
 *       chat/error            {type, turnId, duration, part}
 *   - 出参外层统一：{kind:"action", resource:<chatChannelUri>, action:<上述>, parentToolCallId?}
 *
 * 本文件是**纯函数层**，不依赖 bundle 符号，可离线单测（test/e2e-reflow.mjs）。
 * 注入片段把本文件的 `makeReflowTranslator()` 内联进去使用。
 */

let _seq = 0;
const nextId = () => `p${(++_seq).toString(36)}${Date.now().toString(36)}`;

/**
 * 创建「某个 chat 的」回流翻译器。
 *
 * 用法（注入片段里）：
 *   const reflow = makeReflowTranslator({ fire: obj => base._onDidChatProgress.fire(obj) });
 *   reflow.beginChat(chatChannelUri);            // 在 sendMessage 里登记 resource
 *   ...
 *   reflow.onNotify("item/agentMessage/delta", p); // 收到桥通知时喂进来
 *
 * @param {{fire:(obj:any)=>void}} opts
 */
export function makeReflowTranslator(opts) {
  const fire = opts.fire;
  /** threadId/sessionId → { resource, turnId, hostTurnId, markdownPartId, reasoningPartId, toolCalls } */
  const chats = new Map();

  function ensure(threadId) {
    let c = chats.get(threadId);
    if (!c) {
      c = { resource: null, turnId: null, hostTurnId: null, markdownPartId: null, reasoningPartId: null,
            markdownStarted: false, reasoningStarted: false, toolCalls: new Map() };
      chats.set(threadId, c);
    }
    return c;
  }

  /** 登记该 thread 对应的 chatChannelUri（sendMessage 第 1 参） */
  function beginChat(chatChannelUri, threadId) {
    const c = ensure(threadId ?? "__default__");
    c.resource = chatChannelUri;
    return c;
  }

  function emit(threadId, action, parentToolCallId) {
    const c = ensure(threadId);
    if (!c.resource) return false; // 无 resource 时上游 drop（与 bundle 行为一致）
    fire({ kind: "action", resource: c.resource, action, ...(parentToolCallId ? { parentToolCallId } : {}) });
    return true;
  }

  /**
   * 开启一轮（桥的 turn/started 或首个 delta 前自动开）。
   * ★ T2：hostTurnId = 桥 turn/started 的 turn.id（轮次单一真源）。
   */
  function startTurn(threadId, userText, hostTurnId) {
    const c = ensure(threadId);
    if (c.turnId) {
      if (hostTurnId && hostTurnId !== c.hostTurnId) { c.hostTurnId = hostTurnId; c.turnId = hostTurnId; }
      return c.turnId;
    }
    c.hostTurnId = hostTurnId ?? null;
    c.turnId = hostTurnId || nextId();
    c.markdownPartId = null; c.reasoningPartId = null;
    c.markdownStarted = false; c.reasoningStarted = false;
    c.toolCalls.clear();
    emit(threadId, {
      type: "chat/turnStarted", turnId: c.turnId,
      startedAt: new Date().toISOString(),
      message: { text: userText ?? "", origin: { kind: "user" } },
    });
    return c.turnId;
  }

  function finishTurn(threadId, durationMs) {
    const c = ensure(threadId);
    if (!c.turnId) return;
    emit(threadId, { type: "chat/turnComplete", turnId: c.turnId, duration: Math.max(0, durationMs | 0) });
    c.turnId = null; c.hostTurnId = null; c.toolCalls.clear();
  }

  // ★★★ 血案 V2（2026-10-11 07:40）：本函数原用 `part:{kind:"systemNotification",…}` 旧形态，
  //   ① kind 不在 VS Code 前端识别的集合内 ⇒ 错误块不渲染；
  //   ② part 内**无 error.errorType / error.message** ⇒ agentHost.turnError 模板取不到字段 ⇒ `(undefined) undefined`；
  //   ③ 且 emit 消息经 rpc.mjs `JSON.stringify` 出网，Error 实例的 message 会被吞掉。
  //   修正（与 inject-snippet.mjs 对齐）：part 用标准 `{kind:"error", error:{message, errorType}}` 普通对象。
  function failTurn(threadId, message, code) {
    const c = ensure(threadId);
    if (!c.turnId) return;
    emit(threadId, {
      type: "chat/error", turnId: c.turnId, duration: 0,
      part: {
        kind: "error",
        error: {
          message: String(message == null ? "error" : (message.message || message)),
          errorType: code != null ? String(code) : "TURN_FAILED",
        },
      },
    });
    c.turnId = null; c.hostTurnId = null; c.toolCalls.clear();
  }

  /** 文本增量：首块发 responsePart 建 part，之后发 delta（复刻 bundle 的 markdown 语义） */
  function markdownDelta(threadId, text) {
    const c = ensure(threadId);
    if (!text) return;
    if (!c.turnId) startTurn(threadId);
    if (!c.markdownStarted) {
      c.markdownPartId = nextId();
      c.markdownStarted = true;
      emit(threadId, { type: "chat/responsePart", turnId: c.turnId,
        part: { kind: "markdown", id: c.markdownPartId, content: text } });
    } else {
      emit(threadId, { type: "chat/delta", turnId: c.turnId, partId: c.markdownPartId, content: text });
    }
  }

  /** 思考增量（reasoning） */
  function reasoningDelta(threadId, text) {
    const c = ensure(threadId);
    if (!text) return;
    if (!c.turnId) startTurn(threadId);
    if (!c.reasoningStarted) {
      c.reasoningPartId = nextId();
      c.reasoningStarted = true;
      emit(threadId, { type: "chat/responsePart", turnId: c.turnId,
        part: { kind: "reasoning", id: c.reasoningPartId, content: text } });
    } else {
      emit(threadId, { type: "chat/reasoning", turnId: c.turnId, partId: c.reasoningPartId, content: text });
    }
  }

  // ---------------------------------------------------------------- ★ T1 工具调用结构化
  //  renderer 契约（sessions.desktop.main.js 实证）：
  //    toolCallStart{turnId,toolCallId,toolName,displayName}      → status:"streaming"
  //    toolCallDelta{turnId,toolCallId,content}                    → partialInput += content
  //    toolCallReady{turnId,toolCallId,toolInput?,confirmed?}      → status→"running"
  //    toolCallContentChanged{turnId,toolCallId,content:[{text}]}  → 仅 running 生效
  //    toolCallComplete{turnId,toolCallId,result:{success}}        → 完成
  const safeJson = (v) => { try { return typeof v === "string" ? v : JSON.stringify(v); } catch (_) { return String(v); } };

  function toolCallStart(threadId, it) {
    const c = ensure(threadId);
    if (!c.turnId) startTurn(threadId);
    const id = it.toolCallId || nextId();
    if (c.toolCalls.has(id)) return id;
    const name = it.toolName || it.title || "tool";
    c.toolCalls.set(id, { status: "streaming" });
    emit(threadId, {
      type: "chat/toolCallStart", turnId: c.turnId, toolCallId: id,
      toolName: name, displayName: it.displayName || it.title || name,
      ...(it.intention ? { intention: it.intention } : {}),
    });
    const inputStr = it.rawInput !== undefined ? safeJson(it.rawInput) : "";
    if (inputStr) emit(threadId, { type: "chat/toolCallDelta", turnId: c.turnId, toolCallId: id, content: inputStr });
    return id;
  }

  function toolCallReady(threadId, id, it) {
    const c = ensure(threadId);
    if (!c.turnId) return;
    const st = c.toolCalls.get(id); if (!st) return;
    const inputStr = it && it.rawInput !== undefined ? safeJson(it.rawInput) : undefined;
    emit(threadId, { type: "chat/toolCallReady", turnId: c.turnId, toolCallId: id, ...(inputStr ? { toolInput: inputStr } : {}), confirmed: true });
    st.status = "running";
  }

  function toolCallContent(threadId, id, text) {
    const c = ensure(threadId);
    if (!c.turnId || !text) return;
    const st = c.toolCalls.get(id); if (!st || st.status !== "running") return;
    emit(threadId, { type: "chat/toolCallContentChanged", turnId: c.turnId, toolCallId: id, content: [{ type: "text", text: String(text).slice(0, 4000) }] });
  }

  function toolCallComplete(threadId, id, ok) {
    const c = ensure(threadId);
    if (!c.turnId) return;
    const st = c.toolCalls.get(id); if (!st) return;
    emit(threadId, { type: "chat/toolCallComplete", turnId: c.turnId, toolCallId: id, result: { success: ok !== false } });
    c.toolCalls.delete(id);
  }

  /**
   * 桥发来的一条 **codex 通知** → 0..N 条 chat action。
   * @param {string} method 如 "item/agentMessage/delta"
   * @param {any} params
   */
  function onNotify(method, params) {
    const threadId = params?.threadId ?? params?.sessionId ?? "__default__";
    switch (method) {
      case "turn/started": {
        const hostId = params?.turn?.id ?? params?.turnId;
        startTurn(threadId, params?.message?.text, hostId);
        return;
      }
      case "item/agentMessage/delta": {
        markdownDelta(threadId, params?.delta ?? params?.content ?? "");
        return;
      }
      // ★ T3：reasoning 专用通道
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/delta":
      case "item/agentThought/delta": {
        reasoningDelta(threadId, params?.delta ?? params?.content ?? "");
        return;
      }
      case "item/completed": {
        const it = params?.item;
        if (it?.type === "agentMessage" && typeof it.text === "string") { markdownDelta(threadId, it.text); return; }
        // ★ T1：工具完成 → Ready → ContentChanged → Complete
        if (it?.type === "toolCall") {
          const c = ensure(threadId);
          const id = it.toolCallId || (c.toolCalls.size ? [...c.toolCalls.keys()][0] : null);
          if (!id) return;
          if ((it.status || "completed") !== "completed") { toolCallReady(threadId, id, it); return; }
          toolCallReady(threadId, id, it);
          const out = Array.isArray(it.content)
            ? it.content.map((cc) => (cc && cc.content && cc.content.text) || (cc && cc.text) || "").join("")
            : (it.rawOutput ? safeJson(it.rawOutput) : "");
          if (out) toolCallContent(threadId, id, out);
          toolCallComplete(threadId, id, it.status === "completed");
          return;
        }
        return;
      }
      case "item/started": {
        const it = params?.item;
        if (it?.type === "reasoning" && typeof it.text === "string") { reasoningDelta(threadId, it.text); return; }
        // ★ T1：工具调用 → 结构化
        if (it?.type === "toolCall") {
          const id = toolCallStart(threadId, it);
          if ((it.status || "in_progress") !== "in_progress") toolCallReady(threadId, id, it);
          return;
        }
        return;
      }
      // ★ T4：token 用量 → chat/usage；MCP 启动态静默
      case "thread/tokenUsage/updated": {
        const c = ensure(threadId);
        if (!c.turnId) return;
        emit(threadId, { type: "chat/usage", turnId: c.turnId, usage: params?.tokenUsage });
        return;
      }
      case "mcpServer/startupStatus/updated":
        return;
      case "turn/completed": {
        if (params?.error) {
          // ★ 透传真实错误码（若有）：params.error.code 作 errorType
          failTurn(threadId, params.error.message || params.error, params.error.code);
          return;
        }
        finishTurn(threadId, params?.duration ?? 0);
        return;
      }
      case "turn/error":
      case "error": {
        failTurn(
          threadId,
          params?.message ?? params?.error?.message ?? "unknown error",
          params?.code ?? params?.error?.code,
        );
        return;
      }
      default:
        // 未映射的通知不产生 UI 噪声
        return;
    }
  }

  return { beginChat, startTurn, finishTurn, failTurn, markdownDelta, reasoningDelta,
           toolCallStart, toolCallReady, toolCallContent, toolCallComplete, onNotify,
           _chats: chats };
}

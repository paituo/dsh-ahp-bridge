/**
 * DSH provider 注入片段（C 路：改 bundle 向本地 agent host 注入 provider）。
 *
 * ★ 本文件的方法名/结构**全部来自对 bundle 的源码提取**（2026-10-10 21:50 实证），
 *   不是凭印象写的。见 docs/真注入前置评估-provider接口面实证与三路径决策.md。
 *
 * 已实证的事实（provider 接口面）：
 *   - registerProvider(e) 约束：e.id 必须唯一；注册时会对 e 跑 `_providerInitializers`，
 *     并 `authenticationController.replay(e)` ⇒ e 必须有可用的 authenticate。
 *   - copilotcli provider 类 = `tt`（类体 118KB），实例字段：
 *       this.id = sO（常量）
 *       this.chats = { prepareTurn, createChat, disposeChat, canReleaseChat,
 *                      releaseChat, sendMessage, abort, getModel, changeModel,
 *                      resumeTurn, changeAgent, ... }        ← ★ 实例字段，可替换
 *       this._models = li(this, [])                         ← observable
 *       getDescriptor() → { provider: this.id, displayName, description,
 *                           capabilities: { multipleChats: { fork, sideChat } } }
 *       agentHostCapabilities = { workspaceConversion: true }
 *       getProtectedResources()、async authenticate()
 *   - codex provider 类 = `By`，chats 键：
 *       prepareChat / createChat / disposeChat / releaseChat / sendMessage /
 *       abort / getModel / changeModel / changeAgent / getMessages
 *
 * ★ 本片段采用 P3 路径（tt 壳 + 定向改道），已在 test/sim-p3-reroute.mjs 离线验证 14/14：
 *   用 tt 实例兜住 registration/initializer/authenticate 等全部框架要求，
 *   只把 id / descriptor / chats.sendMessage / models 四项改道到 DSH 桥。
 *
 * ★ 事件回流（2026-10-10 22:20 补）：见 src/inject-translate.mjs 与 test/e2e-reflow.mjs（20/20）。
 *   依据 bundle 实证：
 *     - tt 里 `onDidSessionProgress: this._onDidChatProgress` ⇒ 二者同一个 emitter；
 *     - fire 形态：{kind:"action", resource:<chatChannelUri>, action:{type:"chat/..."}}；
 *     - resource 必须是 chatChannelUri（sendMessage 第 1 参），否则上游 drop；
 *     - `chats.sendMessage(chatUri, turnId, content, ...)` 第 1 参即 chatUri。
 *   ⇒ 注入片段在 sendMessage 里登记 resource，并捕获桥的 codex 通知，翻译成 chat/* action 后 fire。
 */

/**
 * ★ 单一真源：把 VS Code 传入 sendMessage 的「消息文本」参数解析成字符串。
 *
 * 真实调用签名（bundle 实证 @2612774）：
 *   t.chats.sendMessage(chatContext, messageText, turnId, attachments, ...)
 * 第 2 参 `messageText` 就是 `message.text`——**纯字符串**。
 *
 * 第 3 版曾误以为第 2 参是 turnId、第 3 参是 input 数组，导致取到空串，
 * 桥报 `Invalid params: empty prompt`（真机日志实证）。
 *
 * 本函数以「字符串优先」为铁律，兼容极少数可能出现的数组/对象形态。
 */
export const readMessageText = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => (x && (x.text != null ? x.text : x.content)) || "").join("");
  if (typeof v === "object") {
    const t = v.text != null ? v.text : v.content;
    return t == null ? "" : (typeof t === "string" ? t : String(t));
  }
  return String(v);
};

/**
 * ★★★ 会话工作目录解析（2026-10-11，遗留项 4：把 worktree URI 透传到 thread/start）
 *
 * ### 为什么要做
 * VS Code 的 `isolation=worktree` 会话，其**工作目录就是 worktree 路径**：
 *   `sessions.desktop.main.js` 里
 *     `g = await b.createDetachedWorktree(backendUri, prompt);`
 *     `h = this.mapProjectUri(g.worktree);`              // ← worktree URI 成为会话工作目录
 *     `await this._workspaceTrustManagementService.setUrisTrust([h], true);`
 *     `f = await a.service.connect(h, t);`                // ← 用 worktree URI 连接后端
 *     `b.createNewSession(f.workspaceUri, S.id, {...})`   // ← 会话 workspaceUri = worktree
 *   而内置 host 侧的工作目录由**它自己**从会话配置解析：
 *     `_resolveWorkingDirectoryBeforeSend` → `configurationService.getEffectiveWorkingDirectories(chat)`
 *     `getEffectiveWorkingDirectories(e) { return oo(this._stateManager, e) }`
 *     `oo(o,i) { return o.getSessionState(i)?.workingDirectories ?? (…父会话…) }`
 *   ⇒ 即 **stateManager.getSessionState(<sessionUri>).workingDirectories**。
 *
 * ### 注入层能拿到什么
 * 注入片段锚点 `D.registerProvider(m.createInstance(tt)),` 与外层 bootstrap 同一作用域，
 * 该作用域内已实证存在（见 bundle `M0e()`）：
 *   - `y` = stateManager（`W.stateManager`）  → `y.getSessionState(uri)?.workingDirectories`
 *   - `j` = configurationService（`W.configurationService`）→ `j.getEffectiveWorkingDirectories(uri)`
 *   - `p` = agentService（含 `_worktree`）
 * 而 `sendMessage` 第 1 参 chatContext 由 `Lu(stateManager, session, chat)` 构造：
 *   `{ resource, configurationResource, origin?, customizations? }`
 *   - `configurationResource` = **session URI**（`pee(session)`）★ 这是查工作目录的 key
 *   - `resource` = chat channel URI
 *   ⇒ 所以「chatContext → 会话工作目录」这条链是**通的**。
 *
 * ### 本函数契约
 * 纯函数式：把「取 stateManager 的能力」以 `getSessionState` 形式注入，便于**离线单测**
 * （无需真机）。返回**本机路径字符串**或 `undefined`。
 *
 * @param {object} ctx  { configurationResource?, resource?, session? } —— chatContext 形
 * @param {(uri:string)=>any} getSessionState  形如 `(uri)=>stateManager.getSessionState(uri)`
 * @returns {string|undefined} 会话工作目录（本机路径，非 URI）
 */
export const resolveSessionWorkingDir = (ctx, getSessionState) => {
  try {
    if (!ctx || typeof getSessionState !== "function") return undefined;
    // session URI 的优先序：configurationResource（Lu 里 = pee(session)）→ session → resource
    const keys = [ctx.configurationResource, ctx.session, ctx.resource];
    for (const k of keys) {
      if (k == null) continue;
      const uri = typeof k === "string" ? k : (typeof k.toString === "function" ? k.toString() : null);
      if (!uri) continue;
      // ★★★ 血案修复（2026-10-11，CDP 真机实证）：configurationResource 的真实形态是
      //   `ahp-chat://default/<base64(dsh:/<uuid>)>`，而 stateManager 按 `dsh:/<uuid>` 索引
      //   ⇒ key 不匹配 ⇒ 两级探测全未命中 ⇒ 回落 cfg.cwd（遗留项4 透传失效）。
      //   修：对 ahp-chat:// 变体做 base64url 解码，得到内层 `dsh:/<uuid>` 再查。
      //   （解码是纯函数，失败不影响原 URI 的直查。）
      const variants = [uri, ...expandChatUriVariants(uri)];
      for (const v of variants) {
        const st = getSessionState(v);
        const wds = st && st.workingDirectories;
        if (Array.isArray(wds) && wds.length) {
          // workingDirectories 元素可能是 URI 对象或字符串；取第一个可解析者
          for (const w of wds) {
            const p = uriLikeToFsPath(w);
            if (p) return p;
          }
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * 把 VS Code 的 chat/session URI 展开成「可能被 stateManager 索引的等价形态」。
 *
 * 实证形态（2026-10-11 CDP 真机）：
 *   `ahp-chat://default/<base64url("dsh:/<uuid>")>`
 *   ⇒ 解码后为 `dsh:/<uuid>`（即 VS Code 侧会话 URI）。
 * 其它可能包装：`ahp-chat://<inner>`、`ahp-session://...`。
 *
 * 纯字符串变换；任何异常都吞掉（返回空数组，不影响调用方直查原 URI）。
 *
 * @param {string} uri
 * @returns {string[]} 候选等价 URI（去重、不含原串）
 */
export const expandChatUriVariants = (uri) => {
  const out = [];
  try {
    const s = String(uri ?? "");
    if (!s) return out;
    const push = (v) => { if (v && v !== s && !out.includes(v)) out.push(v); };
    // 匹配 `<scheme>://<authority>/<payload>`；payload 可能带查询/片段，先剥掉
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)\/([^?#]+)/.exec(s);
    if (m) {
      const payload = m[3];
      const inner = decodeBase64UrlUtf8(payload);
      if (inner) {
        push(inner);
        // 内层可能还有一层包装（少见）：再展开一次（深度 1 足够，防环）
        for (const v of expandInnerOnce(inner)) push(v);
      }
    }
    // `ahp-chat://<inner>`（无 authority 分隔的变体）
    const m2 = /^ahp-chat:\/\/(.+)$/.exec(s);
    if (m2 && !m2[1].includes("/")) {
      const inner = decodeBase64UrlUtf8(m2[1]);
      if (inner) push(inner);
    }
  } catch { /* ignore */ }
  return out;
};

/** 单层：尝试 base64url 解码；失败返回 null（不抛） */
const decodeBase64UrlUtf8 = (payload) => {
  try {
    let b = String(payload).replace(/-/g, "+").replace(/_/g, "/");
    if (!/^[A-Za-z0-9+/=]+$/.test(b)) return null;
    b += "=".repeat((4 - (b.length % 4)) % 4);
    // 注入片段不能 import Buffer？—— 浏览器/VS Code renderer 里有 atob。
    let raw;
    if (typeof atob === "function") raw = atob(b);
    else if (typeof Buffer !== "undefined") raw = Buffer.from(b, "base64").toString("binary");
    else return null;
    // atob 给的是 latin1；按 UTF-8 还原
    let text;
    if (typeof TextDecoder === "function") {
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 0xff;
      text = new TextDecoder("utf-8").decode(bytes);
    } else { text = decodeURIComponent(escape(raw)); }
    // 只接受「看起来像 URI」的结果（避免把随机串当 URI 去查）
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text) ? text : null;
  } catch { return null; }
};

/** 内层再展开（深度 1）：`<scheme>://<auth>/<b64>` */
const expandInnerOnce = (inner) => {
  const out = [];
  try {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)\/([^?#]+)/.exec(inner);
    if (m) {
      const d = decodeBase64UrlUtf8(m[3]);
      if (d) out.push(d);
    }
  } catch { /* ignore */ }
  return out;
};

/**
 * URI-ish（VS Code URI 对象 / file:// 串 / 裸路径）→ 本机路径。
 * 与 bridge 侧 `worktree.mjs#uriToPath` 语义一致（此处独立实现，因注入片段不能 import）。
 * - VS Code URI 对象：有 `.fsPath` 直接用（最准，无需再解码）
 * - 字符串：剥 `file://` / 其它 scheme，去盘符前导斜杠，`%XX` 解码
 */
export const uriLikeToFsPath = (u) => {
  try {
    if (u == null) return undefined;
    if (typeof u === "object") {
      if (typeof u.fsPath === "string" && u.fsPath) return u.fsPath;
      if (typeof u.path === "string" && u.path) return uriLikeToFsPath(u.path);
      if (typeof u.toString === "function") return uriLikeToFsPath(u.toString());
      return undefined;
    }
    let s = String(u).trim();
    if (!s) return undefined;
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]*)(\/.*)?$/.exec(s);
    if (m) {
      let p = decodeURIComponent(m[3] ?? "");
      if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);   // 去 Windows 盘符前导斜杠
      return p || undefined;
    }
    return s;
  } catch {
    return undefined;
  }
};

/**
 * P3 注入：复用 copilotcli（tt）实例做壳，定向改道到 DSH 桥。
 *
 * 注入位置：bootstrapStart 里 `D.registerProvider(m.createInstance(tt)),` 之后，
 *           且必须在**任何 registerProvider 之前**先 registerProviderInitializer（若有需要）。
 *           本片段只追加注册，不改动已有 provider。
 *
 * 占位符（apply 时替换）：
 *   __BRIDGE__   bridge.mjs 绝对路径（正斜杠）
 *   __DSH_BIN__  dsh 的 lib/bin.js 绝对路径（正斜杠）
 *   __NODE__     node.exe 绝对路径（正斜杠）
 *   __CWD__      默认工作目录（正斜杠）
 *   __SPAWN_NS__ bundle 内已存在的 spawn 模块命名空间（如 taskkill 用的那个）
 */
export const P3_TT_SHELL_REROUTE_SNIPPET = `
/* >>> BOWEI-DSH-P3-BEGIN >>> */
(cfg => {
  // ★★★ 铁探针（2026-10-16 排障用）：零依赖、无 try 包裹、同步三路留痕。
  //   目的：二分化「片段到底有没有被执行」——不依赖任何符号探测（_FS_NS/_LOG_SVC 可能为 null）。
  //   ① process.stderr.write  → 被 [AgentHost:stderr] 转发进 main.log
  //   ② process.getBuiltinModule("fs") 直写文件（Node 22 原生，不经 bundle 命名空间）
  //   ③ console.log            → 兜底
  //   ★ 排障完成后整段删除（是探针，不是产品功能）。
  try {
    var _IRONBOOT = "[dsh-ironboot] snippet ENTERED " + new Date().toISOString() +
      " pid=" + process.pid + " node=" + process.version;
    try { process.stderr.write(_IRONBOOT + String.fromCharCode(10)); } catch (_) {}
    try { console.log(_IRONBOOT); } catch (_) {}
    try {
      var _bfs = process.getBuiltinModule && process.getBuiltinModule("fs");
      if (_bfs && _bfs.appendFileSync) {
        _bfs.appendFileSync(cfg.bridge.replace(/[^/\\\\]+$/, "") + "../temp/ironboot.log",
          _IRONBOOT + String.fromCharCode(10));
      }
    } catch (_) {}
  } catch (_) {}
  // ★★★ provider id = "dsh"（裸名）—— 2026-10-12 **第六版**源码实证定案（推翻第五版"必须 agenthost-"）。
  //
  //   【为什么必须用裸名 "dsh"】三重硬约束，三者必须恒等：
  //
  //   ① 主进程 registry key = provider.id
  //      agentHostMain.js：this._providers.set(e.id, e)；
  //      查表：resolveProvider(e){ return e ? this._providers.get(e) : ... }   ← 纯字符串查表
  //      ⇒ 查表用的 key 必须与注册 key **逐字相等**，否则
  //        throw new Error("No agent provider registered for: " + providerName)
  //        （★ 用户 2026-10-12 实测报错 "No agent provider registered for: dsh" 即此条击穿）
  //
  //   ② 回传的 provider 名 = descriptor.provider
  //      agentHostMain.js _publishAgentInfos：{ provider: r.getDescriptor().provider, ... }
  //        → dispatchServerAction("root/agentsChanged", { agents })
  //      renderer _syncSessionTypesFromRootState：sessionType.id = a.provider
  //        → scheme = resourceSchemeForProvider(sessionType.id) = "agent-host-" + id
  //        → 建会话时把 provider 名回传主进程 → 回到 ① 的查表
  //      ⇒ descriptor.provider **必须** = provider.id（= registry key）。三者是一根链。
  //
  //   ③ 桥侧 / catalog 权威形态是裸名
  //      bridge.mjs（上一轮实证）：agent-host.db 的 sessions_v2.session_uri = "dsh:/<uuid>"
  //      ⇒ 裸名 = "dsh"；HOST_PREFIX="agent-host-dsh" 仅是渲染层 scheme
  //
  //   【"必须 agenthost-" 是怎么来的、为何是错的】
  //     出处：SKILL §29 / docs 根因定案3。当时的推断前提是
  //       「我们注册的 provider 会进入 renderer 的 sessionsProvidersService，从而被 vr() 检查」。
  //     该前提**已被实测推翻**：
  //       · renderer 的 sessionsProvidersService 里**只注册了一个 provider：zye**
  //         （localAgentHostContribution：a.add(e.createInstance(zye)) → t.registerProvider(c)）
  //       · zye 的 id 恒为 Bb="local-agent-host"（构造器写死），它经 KSe 协议桥**代理主进程全部 provider**
  //       · CDP 探针 window.__GP 实测（11 次调用）：{pid:"local-agent-host", vid:"local-agent-host", vr:true}
  //         ⇒ vr() 的入参**永远**是 zye，与我们的 provider.id **无关**
  //     全 bundle 枚举 lRt="agenthost-" 的 4 处使用点，逐一核对**均与我们无关**：
  //       1) vr/bI 定义            —— 入参是 zye
  //       2) @7772716 遥测归类      —— remote-agent-host/other
  //       3) @18187939 (lRt + authority) —— 远程 host 自生成 id（生产方）
  //       4) @18459598 A.regex(Mv.key, ygi) —— 菜单可见性；Mv 值 = session.providerId = "local-agent-host"
  //          ⇒ A.or(equals(Mv.key,Bb), regex(Mv.key,ygi)) 第一项即为真，第二项是备选分支
  //
  //   【真正的准入闸门在别处 —— 且对本 provider 恒放行】
  //     zye._shouldAdvertiseAgent(e){ return QCt(e, cfg, isSessionsWindow) }
  //     全 bundle 只有 2 处 _shouldAdvertiseAgent（基类恒 true；zye 覆写）+ 1 处 _shouldRegisterAgent。
  //     QCt 定义（sessions.desktop.main.js @4638341，逐字）：
  //       var lee="claude", sR="codex", Hio="copilotcli";
  //       function QCt(s,o,e){ switch(s){
  //         case lee: return o.getValue("chat.agentHost.claudeAgent.enabled")!==!1;
  //         case sR : return o.getValue(e?"chat.agentHost.codexAgent.enabled":"chat.editor.codex.preferAgentHost")===!0;
  //         default : return !0;          // ★ 其余一律放行
  //       }}
  //     ⇒ "dsh" 走 default ⇒ **恒放行**。连官方内置 copilotcli 的 id 都是裸名（Hio="copilotcli"，无前缀）。
  //
  //   【曾用 "agenthost-dsh" 的后果（本版修复的直接动因）】
  //     ID="agenthost-dsh" 但 descriptor.provider="dsh" ⇒ 两者不等 ⇒ 链路 ②→① 断裂
  //     ⇒ 建会话时主进程 resolveProvider("dsh") 查不到 "agenthost-dsh" ⇒ 抛
  //       "No agent provider registered for: dsh"（且会话已在 renderer 侧创建 ⇒ UI 状态卡在"正在工作"）
  //
  //   【结论】ID ← "dsh"；SESSION_TYPE_ID ← "dsh"；descriptor.provider ← "dsh"；三者恒等。
  //     scheme 仍由 renderer 拼成 "agent-host-dsh"（= 桥侧 HOST_PREFIX），完全一致。
  const ID = "dsh";                                   // ★ registry key = 裸名（= descriptor.provider = catalog 裸名）
  const SESSION_TYPE_ID = "dsh";                      // ★ 与 ID 恒等（sessionType.id → scheme = "agent-host-" + 本值）
  const AGENT_PROVIDER_PREFIX = "agent-host-";       // 仅用于日志/展示，不参与 registry key
  const PREFIX = "agent-host-" + SESSION_TYPE_ID;     // = "agent-host-dsh"（session scheme 前缀，供日志）
  try {
    // ★★★ 铁探针（2026-10-16）：零依赖标记「已进入主 try 体」+ 即将 createInstance
    try {
      var _ib2 = "[dsh-ironboot] entering main try; DI=" + (typeof __DI__) + " SHELL=" + (typeof __SHELL_CLS__) +
        " SVC=" + (typeof __PROVIDER_SVC__) + " FSNS=" + (typeof __FS_NS__) + " LOGSVC=" + (typeof __LOG_SVC__) +
        " STATE=" + (typeof __STATE_MGR__);
      try { process.stderr.write(_ib2 + String.fromCharCode(10)); } catch (_) {}
      try {
        var _bfs3 = process.getBuiltinModule && process.getBuiltinModule("fs");
        if (_bfs3 && _bfs3.appendFileSync) _bfs3.appendFileSync(cfg.bridge.replace(/[^/\\\\]+$/, "") + "../temp/ironboot.log", new Date().toISOString() + " " + _ib2 + String.fromCharCode(10));
      } catch (_) {}
    } catch (_) {}
    // 1) 拿一个「功能完整、已通过所有框架初始化器」的 provider 实例作壳
    //    ★ 2026-10-16 修复：1.142 的壳类（copilotcli）构造器内部会 registerProvider("copilot-builtin")，
    //    上游这一行已注册过一次；片段若再 createInstance 同一个壳类必然抛 "already registered"。
    //    因此改为**复用上游刚创建的那个实例**（apply-p3 已把锚点改写成 _p3base=h.createInstance(壳),）。
    //    仅在 _p3base 不可用时（旧锚点/其它形态）才回退到自行 createInstance。
    var base = (typeof _p3base !== "undefined" && _p3base) ? _p3base : __DI__.createInstance(__SHELL_CLS__);
    try {
      var _ib3 = "[dsh-ironboot] base OK; reusedUpstream=" + (typeof _p3base !== "undefined" && !!_p3base) + " ctor=" + (base && base.constructor && base.constructor.name) + " hasChats=" + !!(base && base.chats);
      try { process.stderr.write(_ib3 + String.fromCharCode(10)); } catch (_) {}
      try {
        var _bfs4 = process.getBuiltinModule && process.getBuiltinModule("fs");
        if (_bfs4 && _bfs4.appendFileSync) _bfs4.appendFileSync(cfg.bridge.replace(/[^/\\\\]+$/, "") + "../temp/ironboot.log", new Date().toISOString() + " " + _ib3 + String.fromCharCode(10));
      } catch (_) {}
    } catch (_) {}

    // 2) 身份改道：id + descriptor（descriptor.provider 才是下拉显示依据）
    base.id = ID;
    base.getDescriptor = () => ({
      provider: SESSION_TYPE_ID,
      displayName: "DSH",
      description: "DeepSeek Harness via ACP \\u21c4 codex-app-server bridge",
      capabilities: { multipleChats: { fork: false, sideChat: false } },
    });

    // 2a) sessionTypes —— 见下方 2c-2（**必须在 log 定义之后**，否则 log 处于 TDZ 会抛错）。

    // 2b) logger —— 提前定义（原在 step 3），供后续步骤与下面的生命周期日志使用。
    //   bundle 里真正的 logService 是外层变量 c（bootstrapStart 里 c.info(...)）；
    //   第 1 版误用 n.value（那是 telemetry service SR 的实例，没有 info）⇒ 日志全静默。
    //   ★★★ 文件旁路（2026-10-11 23:xx）：注入片段的 log 只进 VS Code logService（不可读），
    //     真机排障时无法取证。这里用 bundle 模块级已有的 gm（即 import * as gm from fs）
    //     直接 append（实证：agentHostMain.js 顶部有 import*as gm from fs 语句，
    //     且注入锚点 D.registerProvider(m.createInstance(tt)), 与它同一个模块作用域 ⇒ 可见）。
    //     这是「探针」不是产品功能，取证完成后可整段删除。
    const _FILELOG = "C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30/temp/dsh-ahp-bridge/bridge/temp/inject-bridge.log";
    // ★ 抗更新：fs 命名空间与 logService 的**压缩变量名**由 apply-p3 自动探测后经占位符注入
    //   （1.141.x 是 gm/c；1.142.0 是 df/u —— 批量改名，硬编码必炸）。
    //   这里先做「安全解引用」：若运行时该名字不存在，降级为 null 而不是 ReferenceError
    //   （片段是 try 包裹的，但 ReferenceError 会中断后续注入步骤，故显式兜底）。
    const _FS_NS = (() => { try { return typeof __FS_NS__ !== "undefined" ? __FS_NS__ : null; } catch (_) { return null; } })();
    const _LOG_SVC = (() => { try { return typeof __LOG_SVC__ !== "undefined" ? __LOG_SVC__ : null; } catch (_) { return null; } })();
    const _STATE_MGR = (() => { try { return typeof __STATE_MGR__ !== "undefined" ? __STATE_MGR__ : null; } catch (_) { return null; } })();
    const _APPEND = (() => {
      try {
        if (!_FS_NS || typeof _FS_NS.appendFileSync !== "function") return null;
        // ★ 换行用 fromCharCode(10) —— 不能用反斜杠 n 字面量：
        //   注入片段本身是**模板字符串**，apply-p3 用 .replace() 写入时反斜杠 n 会先被模板
        //   解析成真换行 ⇒ 落进 bundle 后成为**未闭合的字符串**（真机报 SyntaxError 实证）。
        const NL = String.fromCharCode(10);
        const boot = NL + "===== [dsh-bridge] snippet boot " + new Date().toISOString() + " pid=" + (typeof process !== "undefined" ? process.pid : "?") + " =====" + NL;
        // ★ 目录取「最后一个斜杠之前」用字符串截取，不用正则；分隔符用 fromCharCode(92) 表示反斜杠
        //   —— 避开「模板字符串 + 正则」的双重转义层（这两层已各坑一次）。
        const _BS = String.fromCharCode(92);
        const _dir = (() => {
          const i = Math.max(_FILELOG.lastIndexOf("/"), _FILELOG.lastIndexOf(_BS));
          return i > 0 ? _FILELOG.slice(0, i) : _FILELOG;
        })();
        if (typeof _FS_NS.mkdirSync === "function") {
          try { _FS_NS.mkdirSync(_dir, { recursive: true }); } catch (_) {}
        }
        _FS_NS.appendFileSync(_FILELOG, boot);
        return (line) => { try { _FS_NS.appendFileSync(_FILELOG, line + NL); } catch (_) {} };
      } catch (_) { return null; }
    })();
    const log = (lv, msg) => {
      const line = "[dsh-bridge] " + msg;
      try { _LOG_SVC && typeof _LOG_SVC[lv] === "function" ? _LOG_SVC[lv](line) : (_LOG_SVC && _LOG_SVC.info && _LOG_SVC.info(line)); } catch (_) {}
      try { n && n.value && typeof n.value[lv] === "function" && n.value[lv](line); } catch (_) {}
      if (_APPEND) _APPEND(line);
    };
    log("info", "logger ready (filelog=" + (_APPEND ? "on" : "off") + ")");

    // 2c-1) ★★★ sessionTypes —— agent picker 显示 preset 的**必需条件**（2026-10-11 根因）
    //
    //   VS Code 渲染 agent picker 的真实链路（sessions.desktop.main.js 逐环实证）：
    //     ① _collectSessionTypes(){ for (p of sessionsProvidersService.getProviders())
    //                                  for (n of p.sessionTypes) 收集 }   ← 需要 provider 暴露本字段！
    //     ② 为每个 n.id 注册 scheme resolver：'agent-host-' 拼接 n.id
    //     ③ picker 项 = agentHost harness.itemProvider.provideCustomAgents(o,e)
    //          = (await promptsService.getCustomAgents(e)).filter(n => rw(n.sessionTypes, Li(o)))
    //        · Li(o) = 会话 resource 的 scheme（= 本 provider 的 id，形如 agenthost-dsh）
    //        · rw(s,o) = s===undefined || o===undefined || s.includes(o)
    //     ④ ⇒ 只有「agent 文件声明了本 sessionType」或「未声明 sessionTypes（undefined 放行）」的
    //        agent 才会出现在 picker 里。
    //   ★ 旧版注入从未设置本字段 ⇒ ① 收不到 ⇒ picker 恒空（只剩内置 "Agent" 兜底）。
    //   契约（bundle 内 oY/jSe 实证）：{ id, label, icon?, authRequirement? }
    //   ★ 注意：本段必须位于 log 定义之后（否则 log 处 TDZ，异常被 catch 吞，静默失效）。
    try {
      // ★ 恒等（2026-10-12 第六版）：provider.id == descriptor.provider == sessionType.id == "dsh"。
      //   三者是一根链（见文件顶部 P3 的大段注释）：registry key ← descriptor.provider ← sessionType.id。
      //   任何一处不等 ⇒ 主进程 resolveProvider 查表失败 ⇒ "No agent provider registered for: X"。
      //   session.scheme 由 renderer 拼 = resourceSchemeForProvider("dsh") = "agent-host-dsh"，
      //   与桥侧 HOST_PREFIX / catalog session_uri 形态一致，**不会**再叠成 "agent-host-agenthost-dsh"。
      //   agent 文件的 sessionTypes 过滤（rw(n.sessionTypes, Li(o))）用 sessionType.id（"dsh"）
      //   ⇒ 本段 sessionTypes 元素填 "dsh"（与 agent 文件里 sessionTypes:[dsh] 对齐）。
      const _st = [{ id: SESSION_TYPE_ID, label: "DSH", sessionTypes: [SESSION_TYPE_ID] }];
      Object.defineProperty(base, "sessionTypes", {
        configurable: true, enumerable: true,
        get: () => _st,
      });
      Object.defineProperty(base, "onDidChangeSessionTypes", {
        configurable: true, enumerable: true,
        value: () => ({ dispose() {} }),
      });
      log("info", "sessionTypes exposed: providerId=" + ID + " sessionTypeId=" + SESSION_TYPE_ID + " n=" + _st.length);
    } catch (e) { try { log("error", "sessionTypes expose failed: " + (e && e.message)); } catch (_) {} }

    // 2c-0) ★★★ 禁用 Copilot 认证（v6 · 2026-10-15）—— 修「登录即可使用 GitHub Copilot」弹窗
    //   壳 tt 是 copilotcli provider 类，自带整套 GitHub Copilot 认证逻辑。DSH provider
    //   **不需要 GitHub 凭据**，但这套逻辑照跑，token 为空时弹登录框 + 抛「需要身份验证才能启动会话」。
    //
    //   真机证据链（agenthost.log 19:09~19:11 无 401 + bundle 代码实证）：
    //     · _applyGitHubToken(e,t)（agentHostMain.js:1416759）末段：
    //         if(!e){ this._authenticationRequired.set({reason:"expired"}, void 0);
    //                 await this._requestClientRestart("GitHub authentication cleared"); ... }
    //       —— token 为空（未登录 GitHub）即设 authenticationRequired。
    //     · AgentSideEffects.registerProgressListener(e)（:2579063）：
    //         e.authenticationRequired && t.add(Ti(n => { let r=e.authenticationRequired.read(n);
    //                                                   r && this._stateManager.emitAuthRequired(r) }))
    //       —— 一旦 read 到非空 ⇒ emitAuthRequired ⇒ renderer 弹登录框。
    //     · 壳的 authenticationRequired 是 observable（:1389861）：
    //         this._authenticationRequired = yd({owner:this,equalsFn:Xt}, void 0);
    //         this.authenticationRequired  = this._authenticationRequired;   ← 别名（同对象）
    //
    //   ★ 修法：钉成「永远 read 到 undefined」的桩，并静音 _handleCopilotSessionAuthRequired。
    //     保持 observable 形态（仍可被订阅 read）以免其它路径抛错。
    //     DSH 会话不依赖它（真机已证 turnComplete 正常）。
    try {
      const _noAuth = {
        read: () => undefined,
        get: () => undefined,
        set: () => {},
        onDidChange: () => ({ dispose: () => {} }),
      };
      base._authenticationRequired = _noAuth;
      base.authenticationRequired = _noAuth;
      base._handleCopilotSessionAuthRequired = () => {};
      try { base._githubCredentialInvalid = false; } catch (_) {}
      log("info", "copilot auth disabled: authenticationRequired pinned to undefined");
    } catch (e) { try { log("error", "copilot auth disable failed: " + (e && e.message)); } catch (_) {} }

    // 2b-2) ★★★ v7（2026-10-15）：切断「需要身份验证才能启动会话。请登录并重试。」弹窗
    //
    //   v6 只压了 authenticationRequired 这条路，**真机证明弹窗仍在**（19:21 renderer.log）。
    //   真根因（sessions.desktop.main.js 双证，与 agenthost 认证完全无关）：
    //     · 报错栈：Error while handling chat request: 需要身份验证才能启动会话。请登录并重试。
    //         at Zq._ensureRequiredAuthentication (sessions.desktop.main.js:5229:33734)
    //         at async Zq._createAndSubscribe     (sessions.desktop.main.js:5229:34055)
    //     · _ensureRequiredAuthentication(e)（@20966136）：
    //         let t = this._getRootState()?.agents.find(r => r.provider === this._config.provider),
    //             i = t?.protectedResources ?? [],
    //             n = this._configurationService.getValue("chat.agentHost.allowSignedOutWhenUsable") === true;
    //         if (UIn(t, e, n) && this._config.resolveAuthentication && !await this._config.resolveAuthentication(i))
    //           throw new Error(d(11007, null));   // ← 就是这句弹窗
    //     · UIn(s,o,e)（@7700252）：
    //         if (!s?.protectedResources?.length) return false;   // ★ protectedResources 为空即放行
    //         let t = s.protectedResources.some(n => n.required !== false); ...
    //     · protectedResources 的来源（agentHostMain.js _publishAgentInfos）：
    //         a = r.getProtectedResources(),  ...  protectedResources: a.length>0 ? a : void 0
    //     · 壳 tt 的 getProtectedResources()（@1405331）返回**两条 GitHub 资源**：
    //         [{...getCopilotResource(), required:…}, getRepoResource()]
    //       ⇒ 发布出去后 UIn 返回真 ⇒ resolveAuthentication(GitHub) 失败 ⇒ 抛错弹窗。
    //
    //   ★ 修法（最小且确定）：把壳的 getProtectedResources 覆盖为返回空数组
    //     ⇒ 发布值变 undefined ⇒ UIn 首行短路 return false ⇒ 认证判定整体放行。
    //     DSH 不依赖 GitHub 凭据，此改动对 DSH 功能零影响（真机已证会话本身可 turnComplete）。
    try {
      base.getProtectedResources = () => [];
      log("info", "v7: getProtectedResources overridden to [] (auth gate disabled)");
    } catch (e) { try { log("error", "v7 getProtectedResources override failed: " + (e && e.message)); } catch (_) {} }
    //
    // 2d) ★★★ 会话元数据覆写（v8 · 2026-10-16）—— 修 ④「左栏会话列表无 DSH 会话/分组」治本落点
    //
    //   【推翻 2026-10-11 的旧结论】旧注释断言：
    //     ① "曾覆写 getChatMetadata 是死代码、从未被调用"；
    //     ② "catalog 里的 dsh 行是磁盘不存在的孤儿"。
    //   **两者均被本轮 bundle 逐行实证 + 真机数据证伪**：
    //     ① 调用链真实存在（agentHostMain.js）：
    //          _resolveCatalogReconciliationSource(agent)
    //            → _getCatalogReconciliationMetadata(provider, agent)
    //              → _registeredSessionMetadata(provider, session, ...)
    //                → **provider.getChatMetadata(chatUri, chatContext, providerData, registryFallback)**
    //          返回值直接决定 {status:"available"} 还是 {status:"sourceUnresolvable"}：
    //            let r = await this._getCatalogReconciliationMetadata(n, e, ...);
    //            if (!r) return this._readableProviderCatalogs.has(e.provider)
    //                       ? { status: "sourceUnresolvable" } : { status: "providerUnavailable" };
    //          ⇒ 返回 undefined = sourceUnresolvable（就是我们的现象）。
    //     ② catalog 的 dsh 会话**真实存在**，位置是
    //          %APPDATA%/Code/agentSessionData/<uuid>/session.db
    //        （不是 ~/.dsh/sessions/ —— 旧判断扫错了目录，故误得"孤儿"）。
    //        且 agentSessionData/<uuid>/session.db 内 catalog_sync_snapshot 的
    //          acknowledged_hash 非空、pending_hash/pending_payload 均为 None
    //        ⇒ 会话本身同步是完整的；**卡点在 provider 查不到 SDK 侧会话**。
    //
    //   【真因 = 双层 id 体系未对齐】实测（读 session_metadata.defaultChatProviderData）：
    //     dir / catalog uuid A = 08eaf260-...        （VS Code 用）
    //     providerData.sdkSessionId B = 1e7d1736-... （provider 用，**另一个 uuid**）
    //     而 VS Code 调 getChatMetadata 时传进来的 chatUri = dsh:/<A>。
    //     provider 原生实现（tt←copilotcli 父类）拿 providerData.sdkSessionId(B) 去
    //     SDK 侧查会话 —— DSH 侧既无 B、也无 A（DSH session/list 返回的是
    //     session-<uuid-C>（带 session- 前缀），第三套 id）⇒ 查不到 ⇒ 返回 undefined ⇒ sourceUnresolvable。
    //
    //   【本覆写策略】不追求"精确还原 SDK 侧会话"，而是**只要 catalog 里有这条会话，
    //     就回一份合法最小元数据**，让 reconciliation 拿到 available、会话正常出现在列表：
    //     · 从 chatUri 解析出 uuid，查 catalog 落盘目录 agentSessionData/<uuid>/session.db；
    //     · 读 session_metadata（isRead/isArchived/configValues…）+ fs.stat 取时间戳；
    //     · 回 { chat, startTime, modifiedTime, project, workingDirectories, summary?, status? }。
    //     · 拿不到任何信息时兜底回 { chat, startTime: now, modifiedTime: now, workingDirectories: [] }
    //       —— 也**必须**是对象（返回 undefined 就会退回 sourceUnresolvable）。
    //
    //   【与 ui 分组的联动】_syncSessionTypesFromRootState 用 agent.provider 造 sessionType
    //     （id=provider）；rootState 里已有 "dsh" ⇒ 会话类型存在，列表分组缺的是"每会话的元数据"，
    //     正是本覆写补上的那一环。
    //
    try {
      // ★ 注意：本片段注入到 **ESM bundle**（实测 agentHostMain.js：import.meta ×5、裸 require( = 0）
      //   ⇒ **绝对不能写 require(...)**（会 ReferenceError 被本段 catch 吞掉、静默失效）。
      //   这里用「纯字符串拼路径 + 动态 import()」：import() 在 ESM 里合法，且 node: 前缀内置模块必可解析。
      const _isWin = (() => { try { return process.platform === "win32"; } catch (_) { return true; } })();
      /** 纯字符串路径拼接（避免引 path 模块的异步初始化问题）。 */
      const _join = (...parts) => {
        const segs = parts.filter((x) => x !== undefined && x !== null && x !== "").map(String);
        if (segs.length === 0) return "";
        const RE_LEAD = new RegExp("^[" + String.fromCharCode(92) + String.fromCharCode(92) + "/]+");
        const RE_TRAIL = new RegExp("[" + String.fromCharCode(92) + String.fromCharCode(92) + "/]+$");
        let p = segs[0];
        for (let i = 1; i < segs.length; i++) {
          const s = segs[i].replace(RE_LEAD, "").replace(RE_TRAIL, "");
          if (!s) continue;
          p = p.replace(RE_TRAIL, "") + (_isWin ? String.fromCharCode(92) : "/") + s;
        }
        return p;
      };
      const _homeDir = (() => {
        try { return process.env.USERPROFILE || process.env.HOME || ""; } catch (_) { return ""; }
      })();
      // agentSessionData 根：%APPDATA%/Code/agentSessionData（Sessions 窗口 catalog 的落盘目录）
      const _sessionDataRoot = (() => {
        try {
          const appData = process.env.APPDATA
            || (_homeDir ? _join(_homeDir, "AppData", "Roaming") : "");
          return appData ? _join(appData, "Code", "agentSessionData") : "";
        } catch (_) { return ""; }
      })();
      // 惰性加载 node:fs（异步 import 一次，缓存 Promise）
      let _fsPromise = null;
      const _getFs = () => {
        if (!_fsPromise) {
          try {
            _fsPromise = import("node:fs").then((m) => {
              try { _fsSync = m && (m.default || m); } catch (_) {}
              return _fsSync;
            }).catch(() => null);
          } catch (_) { _fsPromise = Promise.resolve(null); }
        }
        return _fsPromise;
      };
      // 同步缓存的 fs 模块（由 _getFs 的 then 填充；getChatMetadata 内会 await _getFs() 再读）
      let _fsSync = null;

      /**
       * 从 chatUri 里抠出「会话 id（uuid）」。
       *
       * ★★★ 关键实证（2026-10-15，决定成败的一环）：
       *   上游 _registeredSessionMetadata 传进来的不是 "dsh:/<uuid>"，而是
       *   S.parse(ue(t))，其中 ue(o) = jr(o, "default")：
       *       function jr(o,i){ e=String(o); t=base64url(inner); return ("ahp-chat://" + i + "/" + t) }
       *   即真实入参形态是 **ahp-chat://default/<base64url("dsh:/<uuid>")>**！
       *   （实证：agentSessionData/f676a5f8-.../session.db 的
       *     chat_drafts.chat_uri = "ahp-chat://default/ZHNoOi9mNjc2…"，
       *     解码后 = "dsh:/f676a5f8-e0e2-4c2e-96d8-84fd844ff29f"。）
       *
       *   ⇒ 若只做正则抠 uuid，**base64 形态永远抠不到**（base64 里没有可读 uuid）。
       *     必须：① 先尝试正则（覆盖 dsh:/<uuid> / agent-host-dsh:/<uuid> 直给形态）；
       *           ② 再做 base64url 解码后正则（覆盖 ahp-chat://default/<b64> 真身形态）。
       *
       *   解 base64：优先 Buffer（VS Code 主进程 ESM 里恒为 Node 全局），
       *     回落 atob（Web 全局）；两者都无则放弃（仍会返回合法对象，只是 project 缺省）。
       */
      const _b64Decode = (b64) => {
        try {
          const norm = String(b64).replace(/-/g, "+").replace(/_/g, "/");
          try {
            if (typeof Buffer !== "undefined" && Buffer && typeof Buffer.from === "function") {
              return Buffer.from(norm, "base64").toString("utf8");
            }
          } catch (_) {}
          try { if (typeof atob === "function") return decodeURIComponent(escape(atob(norm))); } catch (_) {}
          try { if (typeof atob === "function") return atob(norm); } catch (_) {}
        } catch (_) {}
        return null;
      };
      const _UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
      const _uuidFromUri = (s) => {
        const t = String(s ?? "");
        // ① 直给形态：dsh:/<uuid>、agent-host-dsh:/<uuid>、session-<uuid> …
        const m = t.match(_UUID_RE);
        if (m) return m[1];
        // ② 真身形态：ahp-chat://default/<base64url("dsh:/<uuid>")>
        const slash = t.indexOf("/", t.indexOf("://") + 3);
        if (slash >= 0) {
          const payload = t.slice(slash + 1);
          if (payload) {
            const dec = _b64Decode(payload);
            if (dec) { const m2 = dec.match(_UUID_RE); if (m2) return m2[1]; }
            // base64url 字符集（补 pad 再试一次，防个别实现去 pad）
            if (/^[A-Za-z0-9_\-]+$/.test(payload)) {
              const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
              const dec2 = _b64Decode(padded);
              if (dec2) { const m3 = dec2.match(_UUID_RE); if (m3) return m3[1]; }
            }
          }
        }
        return null;
      };

      /**
       * 探测 agentSessionData/<uuid>/ 是否存在并取时间戳（只读，尽力而为）。
       * ★ 用 _fsSync（node:fs 预热的同步 API）；未预热成功则返回 exists=null，由调用方走异步补齐。
       */
      const _probeSessionDir = (uuid) => {
        const out = { exists: null, mtime: 0, dir: "" };
        try {
          if (!uuid || !_sessionDataRoot) return out;
          const dir = _join(_sessionDataRoot, uuid);
          out.dir = dir;
          if (!_fsSync) return out;                      // 未预热：exists=null（未知）
          try { out.exists = !!_fsSync.existsSync(dir); } catch (_) { out.exists = null; }
          if (out.exists) {
            try { out.mtime = _fsSync.statSync(dir).mtimeMs || 0; } catch (_) {}
            // 时间戳优先取 session.db 的 mtime（会话最后活动时间最接近它）
            try {
              const dbPath = _join(dir, "session.db");
              if (_fsSync.existsSync(dbPath)) {
                const st = _fsSync.statSync(dbPath);
                if (st && st.mtimeMs) out.mtime = st.mtimeMs;
              }
            } catch (_) {}
          }
        } catch (_) {}
        return out;
      };

      /**
       * 构造符合 provider 契约的元数据对象（★ 永远返回对象，绝不 undefined）。
       *
       * ★ 契约要点（来自 main bundle AgentService._registeredSessionMetadata /
       *   _toSessionMetadata / Oe）：
       *   · 返回体的 chat 必须能被 Oe() 解出 .session（否则 re() 抛
       *     "Malformed AHP chat URI" ⇒ 整条会话被丢弃）。
       *     入参 chatUri 本体就是 S.parse(ue(t))（ahp-chat://default/<b64>）⇒ 直接沿用它最稳。
       *   · _toSessionMetadata 会做 {chat, changesets, ...rest} 展开，
       *     startTime/modifiedTime/workingDirectories/summary/project 均在 rest 里被消费。
       *   · workingDirectories 优先用调用方传入的 chatContext（stateManager 里的真值），
       *     比我们空数组更准。
       */
      const _mkMetadata = (chatUri, chatContext, registryFallback) => {
        const uuid = _uuidFromUri(chatUri);
        const probe = _probeSessionDir(uuid);
        const now = Date.now();
        // 时间戳优先级：真实 session.db mtime > registryFallback > now
        const fbStart = registryFallback && typeof registryFallback.startTime === "number" ? registryFallback.startTime : 0;
        const fbMod = registryFallback && typeof registryFallback.modifiedTime === "number" ? registryFallback.modifiedTime : 0;
        const mt = probe.mtime || fbMod || fbStart || now;
        const st = probe.mtime || fbStart || mt;
        // ★ chat 必须是「可被 Oe 解码」的 uri：直接沿用入参（对象→字符串）
        const chatStr = (chatUri && typeof chatUri.toString === "function") ? chatUri.toString() : String(chatUri ?? "");
        const wd = (chatContext && Array.isArray(chatContext.workingDirectories) && chatContext.workingDirectories.length)
          ? chatContext.workingDirectories
          : [];
        const md = {
          chat: chatStr,
          startTime: st,
          modifiedTime: mt,
          workingDirectories: wd,
        };
        if (probe.dir && uuid) {
          md.project = { uri: "file:///" + String(probe.dir).split(String.fromCharCode(92)).join("/"), displayName: uuid };
        }
        return md;
      };

      const _origGetChatMetadata = base.getChatMetadata;
      // ★ 必须 async：原生三个 provider 的 getChatMetadata 都是 async（实测 "async getChatMetadata" ×3），
      //   调用方 _registeredSessionMetadata 用 await provider.getChatMetadata(...)。
      //   若覆写成同步返回对象，await 仍可工作，但为与原生形态一致、并避免 .then 误判，统一用 async。
      base.getChatMetadata = async function (chatUri, chatContext, providerData, registryFallback) {
        // ① 原生优先（copilotcli 真会话能给出更完整信息）
        let raw;
        try {
          if (typeof _origGetChatMetadata === "function")
            raw = await _origGetChatMetadata.call(this, chatUri, chatContext, providerData, registryFallback);
        } catch (_) { raw = undefined; }
        if (raw) return raw;   // 原生有值 → 直接用

        // ② ★ 原生为空（= sourceUnresolvable 的触发条件）→ 等 fs 预热完成后补对象
        try { await _getFs(); _fsSync = _fsSync || null; } catch (_) {}
        try {
          const md = _mkMetadata(chatUri, chatContext, registryFallback);
          log("info", "v8 getChatMetadata fallback: " + String(chatUri) + " → uuid=" + _uuidFromUri(chatUri) + " mt=" + md.modifiedTime);
          return md;
        } catch (e) {
          try { log("error", "v8 getChatMetadata fallback failed: " + (e && e.message)); } catch (_) {}
          // ★ 绝不返回 undefined（那等于 sourceUnresolvable）；chat 仍用入参保命
          const fallbackChat = (chatUri && typeof chatUri.toString === "function") ? chatUri.toString() : String(chatUri ?? "");
          return { chat: fallbackChat, startTime: Date.now(), modifiedTime: Date.now(), workingDirectories: [] };
        }
      };
      log("info", "v8: getChatMetadata overridden (sessionDataRoot=" + _sessionDataRoot + " fsSync=" + !!_fsSync + ")");
    } catch (e) { try { log("error", "v8 getChatMetadata override failed: " + (e && e.message)); } catch (_) {} }

    // 3) 起一座独立桥进程（stdio JSON-RPC，扮演 codex app-server）
    const spawnBridge = __SPAWN_NS__ && __SPAWN_NS__.spawn;
    let child = null, buf = "", nextId = 1;
    const pending = new Map();
    //   （logger log 已提前到 step 2b 定义，见上。）

    // 3b) 事件回流：codex 通知 → chat/* action（复刻 bundle 实证的 _onDidSessionProgress 形态）
    let _sq = 0;
    const _nid = () => "p" + (_sq++).toString(36) + Date.now().toString(36);
    const chats = new Map();           // key = chatUri（VS Code 侧）→ 状态
    // ★ T1：新增 toolCalls（toolCallId → {partId,status}），用于结构化工具调用通道。
    // ★ T2：新增 hostTurnId（桥下发的 turn.id），作为**轮次单一真源**（与桥通知一致）。
    // ★★★ 血案（2026-10-11 02:35 真机卡死根治）：**chats 的 key 必须一律字符串归一**。
    //   现象：真机发一条消息 → UI 出现「两条相同用户消息」→ 之后永久卡住（无回复无报错）。
    //   根因：sendMessage 里 key = String(chatUri) 用**字符串**作 cget 的 key；
    //         而 ensureThread 里 chatUriBySession.set(sid, chatUri) 存的是**原始 chatUri（对象）**。
    //         于是 cgetByThread(sid) → chatUriBySession.get(sid) 得到**对象** → cget(对象)
    //         ＝ **另一个全新的空 c**（resource=null, turnId=null）——
    //         桥的所有通知（turn/started / turn/completed / item/*）都被 emit 首行的
    //         「if (!c.resource) return;」**静默丢弃** ⇒ 无 chat/error、不 settle ⇒ UI 永久卡死；
    //         而 ready.then(startTurn(key,...)) 用字符串 key ⇒ 正常发出一条 chat/turnStarted
    //         （这解释了「只有 1 条 emit、有用户气泡、却再无下文」的真机日志）。
    //   修：cget 内部对 key 做 String(s) 归一，并把 c.resource 也存成字符串，
    //       让「字符串 key」与「对象 key」落到**同一个** Map 项。
    const _K = (t) => (t == null ? t : String(t));
    const cget = t => { const kk = _K(t); let c = chats.get(kk); if (!c) { c = { resource: null, turnId: null, hostTurnId: null, mdId: null, rzId: null, md: !1, rz: !1, toolCalls: new Map(), _done: null }; chats.set(kk, c); } return c; };
    // ★ chatUri ⇄ dshSessionId 双向映射：桥的通知里 threadId 是 dshSessionId，
    //   而 fire 事件需要 chatUri 作 resource ⇒ 必须能把 sessionId 翻回 chatUri。
    //   ★ 两侧 key/value 一律 String 归一（血案见上）。
    const chatUriBySession = new Map();  // dshSessionId(String) → chatUri(String)
    const sessionByChatUri = new Map();  // chatUri(String) → dshSessionId(String)
    const cgetByThread = t => {           // t 可能是 chatUri 或 dshSessionId，统一归到 chatUri
      const uri = chatUriBySession.get(_K(t)) || _K(t);
      return cget(uri);
    };
    // ★★ 探针（2026-10-10 23:05）：真机出现「fire 了但 UI 无反应」，必须先确定
    //   到底是谁在订阅 provider 的 onDidChatProgress —— 即 base._onDidChatProgress
    //   里有没有 listener。VS Code 侧订阅点（bundle 实证）：
    //     AgentService._initializeProvider: t.add(e.onDidChatProgress(...))
    //     SideEffectsService.registerProgressListener: e.onDidChatProgress(...)
    //   二者都订阅 provider 实例上的「公开属性 onDidChatProgress」。
    //   这里在首次 fire 前打印 listener 计数与可疑字段，用真机日志一锤定音。
    let _probed = false;
    const _probe = () => {
      if (_probed) return; _probed = true;
      try {
        const E = base && base._onDidChatProgress;
        const pub = base && base.onDidChatProgress;
        const cnt = E && typeof E.hasListeners === "function" ? E.hasListeners() : "n/a";
        log("info", "probe: _onDidChatProgress=" + (E ? "obj" : "null")
          + " hasListeners=" + cnt
          + " publicEvent=" + (pub ? (pub === (E && E.event) ? "same" : "diff") : "null"));
        // ★ stateManager 直连可用性（本版新通道）
        try {
          const sm = _STATE_MGR;
          log("info", "probe stateManager: visible=" + (sm ? "yes" : "no")
            + " dispatchServerAction=" + (sm && typeof sm.dispatchServerAction === "function" ? "fn" : "missing"));
        } catch (e) { log("error", "probe sm failed: " + e.message); }
        // 深入 Emitter 内部：VS Code 的 Emitter 把监听器放在 _listeners / _size 等字段
        try {
          const inner = [];
          for (const k of ["_listeners", "_size", "_event", "listeners"]) {
            if (E && k in E) { const v = E[k]; inner.push(k + ":" + (Array.isArray(v) ? "arr[" + v.length + "]" : typeof v + "=" + String(v).slice(0, 20))); }
          }
          const ev = E && E.event;
          if (ev) for (const k of ["_listeners", "_size"]) { if (k in ev) inner.push("event." + k + ":" + (Array.isArray(ev[k]) ? "arr[" + ev[k].length + "]" : String(ev[k]))); }
          log("info", "probe emitter-internal: " + (inner.length ? inner.join(", ") : "(none)"));
        } catch (_) {}
        // 枚举 base 自有属性里与 progress/chat/session 相关的字段，供一锤定音
        try {
          const ks = [];
          let o = base;
          while (o && o !== Object.prototype) {
            for (const k of Object.getOwnPropertyNames(o)) {
              if (/progress|Chat|Session|signal/i.test(k) && !/^_onDid.*[A-Z].*Changed$/.test(k)) {
                let v; try { v = base[k]; } catch (_) { v = "<throw>"; }
                const hv = v && typeof v.hasListeners === "function" ? v.hasListeners() : (typeof v === "function" ? "fn" : typeof v);
                ks.push(k + "=" + hv);
              }
            }
            o = Object.getPrototypeOf(o);
          }
          log("info", "probe fields: " + ks.join(", "));
        } catch (_) {}
      } catch (e) { log("error", "probe failed: " + e.message); }
    };
    // ★★★ 血案（2026-10-10 23:10）：fire provider.onDidChatProgress 全部落空（真机 UI 无任何反应）。
    //   关键上下文（bundle 实证，注入锚点所在函数 M0e 的作用域）：
    //     p = await toe({...});  g = p.agentService;  m = p.instantiationService;
    //     W = m.invokeFunction(U => ({ ..., stateManager: U.get(pe), ... }));  y = W.stateManager;
    //   ⇒ 注入代码与它们同处一个函数作用域，**可直接闭包捕获 y（StateManager）**！
    //   而 AgentService 内部消费 provider 事件后，最终也只是：
    //     _handleAgentSignal: n = t.resource.toString(); ... stateManager.dispatchServerAction(n, t.action)
    //   所以「直连 stateManager.dispatchServerAction(chatUri, action)」与正统链路**等价**，
    //   且**不依赖** provider.onDidChatProgress 是否被 subscribe（这正是我们踩的坑）。
    //   决定：优先直连 stateManager（同步、确定）；emitter 作为兜底与对照。
    const _win = (typeof globalThis !== "undefined") ? globalThis : null;
    void _win;
    let _smWarned = false;
    const emit = (t, a) => {
      const c = cgetByThread(t); if (!c.resource) return;
      _probe();
      const channel = String(c.resource);
      let used = "none";
      // 1) 直连 StateManager（首选）
      try {
        const sm = _STATE_MGR;
        if (sm && typeof sm.dispatchServerAction === "function") {
          sm.dispatchServerAction(channel, a); used = "stateManager";
        }
      } catch (e) { log("error", "stateManager dispatch failed: " + e.message); }
      // 2) 兜底：provider emitter（若 1 失败）
      if (used === "none") {
        try {
          const E = base._onDidChatProgress;
          if (E && typeof E.fire === "function") { E.fire({ kind: "action", resource: c.resource, action: a }); used = "emitter"; }
        } catch (e) { log("error", "fire failed: " + e.message); }
      }
      if (used === "none" && !_smWarned) { _smWarned = true; log("error", "no action channel available (stateManager & emitter both unusable)"); }
      try { log("info", "emit action=" + a.type + " via=" + used + " resource=" + channel.slice(-24)); } catch (_) {}
    };
    // turn 收尾时唤醒 sendMessage 的等待者（让 UI 的 turn 真正结束）
    const settleTurn = (t) => { const c = cgetByThread(t); if (c._done) { const f = c._done; c._done = null; try { f(); } catch (_) {} } };
    // ★★ T2（turnId 贯通，2026-10-11）：**轮次单一真源 = 桥下发的 turn.id**。
    //   血案：旧版这里自造 turnId（c.turnId = _nid()），而桥发的 item 通知各自独立，
    //   renderer 的 activeTurn.id 与通知携带的 turnId 永不对齐 ⇒ 所有 item 静默丢弃。
    //   修：startTurn 接受**外部传入的 turnId**（来自桥 turn/started 的 turn.id）；
    //       仅在桥未下发时才自造（兜底，保证不空转）。
    //
    // ★★★ 血案修复（2026-10-15）：「发对话显示两条用户消息」的**真根因就在这里**。
    //
    //   双源实测（两条都被渲染）：
    //     源 (1)（本片段）：sendMessage 的 ready.then(() => startTurn(key, text))
    //        —— prompt 下发成功后**主动 emit 一条 chat/turnStarted 且带 message.text = 用户输入**。
    //     源 (2)（renderer，workbench.desktop.main.js）：用户按发送时**乐观插入**一条
    //        {type:"chat/turnStarted",...,message:iXt({...uCo(t.message)})} → _pendingActions.push
    //        → _recomputeOptimistic，带的是**renderer 自己的本机 message**。
    //   ⇒ 两条都渲染 ⇒ 用户看到两条相同消息（截图症状）。
    //
    //   ★ 修法：**本片段不再带 message**（源 (1) 让位给 renderer 的本机消息）。
    //     · turnId / startedAt **必须照常发**（renderer 的 PIo 要求 activeTurn.id === turnId，
    //       否则后续所有 item/completed、chat/delta 全部静默丢弃 —— 这是 T2 血案，勿回退）。
    //     · 保留 ut 形参只为日志/兼容，实际**不写入通知**。
    //   ⚠ 注意：本注释位于模板字面量内，**禁止出现反引号**（会提前闭合模板串 ⇒ SyntaxError）。
    const startTurn = (t, ut, hostTurnId) => {
      const c = cgetByThread(t);
      if (c.turnId) {
        // 若已有 turn 但桥下发了不同的 hostTurnId ⇒ 以桥为准（重对齐）
        if (hostTurnId && hostTurnId !== c.hostTurnId) { c.hostTurnId = hostTurnId; c.turnId = hostTurnId; }
        return c.turnId;
      }
      c.hostTurnId = hostTurnId || null;
      c.turnId = hostTurnId || _nid();
      c.mdId = null; c.rzId = null; c.md = !1; c.rz = !1; c.toolCalls.clear();
      // ★★★ 血案（2026-10-16，对话永久空白 / notDispatched）——**必须带 message 对象**。
      //   renderer 处理 chat/turnStarted 时会判定该 turn 是否由客户端派发：
      //     if (this._clientDispatchedTurnIds.has(O.id)) {...return}
      //     ... else this._logService.info("[AgentHost] Server-initiated turn detected: "+O.id)
      //            V.startServerRequest(O.id, O.message.text, wMe(O.message,...),
      //              { isSystemInitiated: O.message.origin.kind === "systemNotification", ... })
      //   ⇒ 只要 renderer 认为这是「服务端主动发起的 turn」，就**强制读 O.message.text**；
      //     上一版为「消双条」把 message 整个删掉 ⇒ TypeError: Cannot read properties of
      //     undefined (reading 'text') ⇒ 帧处理链中断 ⇒ _acceptInput 返回 falsy
      //     ⇒ outcome=notDispatched ⇒ 请求被 cancel ⇒ 助手气泡永久空白。
      //   ★ 修法：message 必须存在且结构完整（text: string + origin.kind: string）。
      //     用空 text + kind="systemNotification" ⇒ renderer 视其为系统发起，
      //     isSystemInitiated=true，不会渲染成「第二条用户消息」。
      //   ⚠ 本注释位于模板字符串内，禁止出现反引号或美元花括号插值。
      emit(t, { type: "chat/turnStarted", turnId: c.turnId, startedAt: new Date().toISOString(),
               message: { text: "", origin: { kind: "systemNotification" } } });
      return c.turnId;
    };
    const finishTurn = (t, d) => { const c = cgetByThread(t); if (!c.turnId) { settleTurn(t); return; } emit(t, { type: "chat/turnComplete", turnId: c.turnId, duration: Math.max(0, d | 0) }); c.turnId = null; c.hostTurnId = null; c.toolCalls.clear(); settleTurn(t); };
    // ★★ 血案（错误反馈体系，2026-10-10 22:50）：
    //   VS Code 的标准错误通道（bundle 实证 @2612774）是：
    //     sendMessage 抛出 → catch → dispatchServerAction(chat/error, part: {kind:"error", error})
    //   前端 reducer（sessions.desktop.main.js @10509322）：
    //     case "chat/error": PIo(state, turnId, "error", duration, 2, action.part) ⇒ part 直接进 responseParts 渲染。
    //   且 chat/responsePart 的内部校验 R3r(part) 明确**拒绝** kind==="error" —— 错误只能走 chat/error。
    //
    //   第 3 版的错法：failTurn 自己 fire 了一个 part:{kind:"systemNotification",...}，
    //   kind 不在前端识别的集合内 ⇒ UI 既不把它当错误块，也拿不到 message ⇒ **用户看不到任何反馈**。
    //   修正：part 用标准形态 {kind:"error", error: ErrorLike}；error 必须是带 message 的对象。
    //
    // ★★★ 血案 V2（(undefined) undefined，2026-10-11 07:40）：JSON 序列化吃掉了 Error 的 message。
    //   现象：新建会话输入任何内容 ⇒ UI 报 「错误: (undefined) undefined」。
    //   实证：全链路 emit 的消息经 rpc.mjs:56 JSON.stringify(msg) 出网；
    //     JSON.stringify({kind:"error", error:new Error("Authentication Fails")}) ⇒ {"kind":"error","error":{}}
    //     —— Error 的 message 是 non-enumerable，序列化后整个丢失；errorType 因 if(code!=null) 从未挂上。
    //   VS Code 侧模板 agentHost.turnError = "错误: ({0}) {1}"，{0}←F.errorType、{1}←F.message ⇒ 双侧 undefined。
    //   修正：error 必须用普通对象（可枚举、可序列化），且 errorType 给默认值，绝不留空。
    //   ★ 注意：本文件整体位于模板字符串内，注释中禁止出现反引号或美元花括号插值（会提前终止字符串）。
    const errorPart = (m, code) => {
      const message = String(m == null ? "error" : (m.message || m));
      return {
        kind: "error",
        // ★ 普通对象（非 Error 实例）：保证 message/errorType 均可被 JSON.stringify 保留
        error: { message, errorType: code != null ? String(code) : "TURN_FAILED" },
      };
    };
    // failTurn：标准 chat/error（part.kind === "error"），供异步回流阶段报错
    const failTurn = (t, m, code) => {
      const c = cgetByThread(t);
      try { log("info", "failTurn t=" + String(t).slice(-12) + " c.turnId=" + (c.turnId || "null") + " hasResource=" + (c.resource ? "Y" : "N") + " hasDone=" + (c._done ? "Y" : "N")); } catch (_) {}
      if (c.turnId) emit(t, { type: "chat/error", turnId: c.turnId, duration: 0, part: errorPart(m, code) });
      c.turnId = null; settleTurn(t);
    };
    const mdDelta = (t, x) => { if (!x) return; const c = cgetByThread(t); if (!c.turnId) startTurn(t); if (!c.md) { c.mdId = _nid(); c.md = !0; emit(t, { type: "chat/responsePart", turnId: c.turnId, part: { kind: "markdown", id: c.mdId, content: x } }); } else emit(t, { type: "chat/delta", turnId: c.turnId, partId: c.mdId, content: x }); };
    const rzDelta = (t, x) => { if (!x) return; const c = cgetByThread(t); if (!c.turnId) startTurn(t); if (!c.rz) { c.rzId = _nid(); c.rz = !0; emit(t, { type: "chat/responsePart", turnId: c.turnId, part: { kind: "reasoning", id: c.rzId, content: x } }); } else emit(t, { type: "chat/reasoning", turnId: c.turnId, partId: c.rzId, content: x }); };

    // ★★★ T1（工具调用结构化，2026-10-11）：**renderer 契约实证**（sessions.desktop.main.js）：
    //   chat/toolCallStart{turnId,toolCallId,toolName,displayName,intention?,contributor?,_meta?}
    //       → 建 {kind:"toolCall",toolCall:{...,status:"streaming"}}（要求 activeTurn.id===turnId）
    //   chat/toolCallDelta{turnId,toolCallId,content}            → partialInput += content
    //   chat/toolCallReady{turnId,toolCallId,toolInput?,confirmed?} → status: streaming→running
    //   chat/toolCallContentChanged{turnId,toolCallId,content:[...]} → **仅 status==="running" 生效**
    //   chat/toolCallComplete{turnId,toolCallId,result:{success}} → 完成
    //   ⇒ 顺序铁律：Start(streaming) → Ready(running) → ContentChanged → Complete。
    //   且必须在 turn 收尾**之前** Complete（否则 PIo 会把 streaming 的工具标 cancelled/skipped）。
    //   ★ displayName 必填（UI 标题来源）；toolCallId 必须稳定（同一工具的 start/delta/complete 共用一个）。
    const safeJson = (v) => { try { return typeof v === "string" ? v : JSON.stringify(v); } catch (_) { return String(v); } };
    const tcStart = (t, it) => {
      const c = cgetByThread(t); if (!c.turnId) startTurn(t);
      const id = it.toolCallId || _nid();
      if (c.toolCalls.has(id)) return id;
      const name = it.toolName || it.title || "tool";
      c.toolCalls.set(id, { status: "streaming" });
      emit(t, {
        type: "chat/toolCallStart", turnId: c.turnId, toolCallId: id,
        toolName: name, displayName: it.displayName || it.title || name,
        ...(it.intention ? { intention: it.intention } : {}),
      });
      // 若有初始输入，作为增量下发（等价 toolCallDelta）
      const inputStr = it.rawInput !== undefined ? safeJson(it.rawInput) : "";
      if (inputStr) emit(t, { type: "chat/toolCallDelta", turnId: c.turnId, toolCallId: id, content: inputStr });
      return id;
    };
    // 声明工具「就绪」（拿到完整输入）→ streaming 变 running（ContentChanged 的前置条件）
    const tcReady = (t, id, it) => {
      const c = cgetByThread(t); if (!c.turnId) return;
      const st = c.toolCalls.get(id); if (!st) return;
      const inputStr = it && it.rawInput !== undefined ? safeJson(it.rawInput) : undefined;
      emit(t, { type: "chat/toolCallReady", turnId: c.turnId, toolCallId: id, ...(inputStr ? { toolInput: inputStr } : {}), confirmed: !0 });
      st.status = "running";
    };
    // 工具输出 → chat/toolCallContentChanged（只在 running 时生效）
    const tcContent = (t, id, text) => {
      const c = cgetByThread(t); if (!c.turnId || !text) return;
      const st = c.toolCalls.get(id); if (!st || st.status !== "running") return;
      emit(t, { type: "chat/toolCallContentChanged", turnId: c.turnId, toolCallId: id, content: [{ type: "text", text: String(text).slice(0, 4000) }] });
    };
    // 工具完成
    const tcComplete = (t, id, ok) => {
      const c = cgetByThread(t); if (!c.turnId) return;
      const st = c.toolCalls.get(id); if (!st) return;
      emit(t, { type: "chat/toolCallComplete", turnId: c.turnId, toolCallId: id, result: { success: ok !== false } });
      c.toolCalls.delete(id);
    };
    const reflow = (method, p) => {
      const t = (p && (p.threadId || p.sessionId)) || "__d";
      // ★★ 诊断（2026-10-11 02:3x 真机卡死取证）：记录每条通知到达时的映射结果。
      //   目的：确认 turn/completed 是否到达、t 是否命中同一 chat 状态（c）、c.turnId 是否为 null。
      try {
        const cc = cgetByThread(t);
        log("info", "reflow in method=" + method + " t=" + String(t).slice(-12)
          + " mappedUri=" + String(cc.resource || "null").slice(-12)
          + " c.turnId=" + (cc.turnId || "null")
          + " hasErr=" + (p && p.error ? "Y" : "N"));
      } catch (_) {}
      switch (method) {
        // ★ T2：桥的 turn/started 带 turn.id（轮次单一真源）——优先用它建 activeTurn
        case "turn/started": {
          const hostId = (p && p.turn && p.turn.id) || (p && p.turnId);
          startTurn(t, p && p.message && p.message.text, hostId);
          break;
        }
        case "item/agentMessage/delta": mdDelta(t, p && (p.delta || p.content)); break;
        // ★ T3：reasoning 专用通道（桥已改发 item/reasoning/textDelta）
        case "item/reasoning/textDelta": case "item/reasoning/summaryTextDelta": {
          rzDelta(t, p && (p.delta || p.content)); break;
        }
        // 兼容旧桥：item/started(type:reasoning) 与 item/reasoning/delta 仍受理
        case "item/reasoning/delta": case "item/agentThought/delta": rzDelta(t, p && (p.delta || p.content)); break;
        case "item/started": {
          const it = p && p.item;
          if (!it) break;
          if (it.type === "reasoning" && typeof it.text === "string") { rzDelta(t, it.text); break; }
          // ★★★ T1：工具调用升级为**结构化 toolCall 通道**（原为 markdown 降级）。
          if (it.type === "toolCall") {
            const id = tcStart(t, it);
            const st = it.status || "in_progress";
            // 若一开始就带完整输入且状态非 in_progress，直接置为 running（Ready）
            if (st !== "in_progress") tcReady(t, id, it);
            break;
          }
          break;
        }
        case "item/completed": {
          const it = p && p.item;
          if (!it) break;
          if (it.type === "agentMessage" && typeof it.text === "string") { mdDelta(t, it.text); break; }
          if (it.type === "toolCall") {
            const c = cgetByThread(t);
            const id = it.toolCallId || (c.toolCalls.size ? [...c.toolCalls.keys()][0] : null);
            if (!id) break;
            // 顺序铁律：Ready(→running) → ContentChanged → Complete
            if ((it.status || "completed") !== "completed") { tcReady(t, id, it); break; }
            tcReady(t, id, it);
            const out = Array.isArray(it.content)
              ? it.content.map(cc => (cc && cc.content && cc.content.text) || (cc && cc.text) || "").join("")
              : (it.rawOutput ? safeJson(it.rawOutput) : "");
            if (out) tcContent(t, id, out);
            tcComplete(t, id, it.status === "completed");
            break;
          }
          break;
        }
        // ★ T4：token 用量 → chat/usage（renderer 契约 {turnId, usage}）
        case "thread/tokenUsage/updated": {
          const c = cgetByThread(t);
          if (!c.turnId) break;
          emit(t, { type: "chat/usage", turnId: c.turnId, usage: p && p.tokenUsage });
          break;
        }
        // ★ T4：MCP 启动态 —— 目前无 UI 消费需求，静默（保持协议对称）
        case "mcpServer/startupStatus/updated": break;
        // ★★ 血案（错误反馈体系，2026-10-10 22:55）：
        //   桥在 turn 失败时**不是**发 turn/error，而是发 turn/completed 并携带 error 字段！
        //   实证（真桥抓包）：
        //     {"method":"turn/completed","params":{"threadId":"...","error":{"message":"...Authentication Fails..."}}}
        //   第 3 版把 turn/completed 一律当成功 ⇒ 错误被静默吞掉 ⇒ UI 只看到「完成但没内容」。
        //   修正：turn/completed 若带 error ⇒ 走 failTurn（fire 标准 chat/error）。
        case "turn/completed": {
          const err = p && p.error;
          // ★ 透传真实错误：err.code（若有）作 errorType，err.message 作 message
          if (err) failTurn(t, err.message || err, err && err.code);
          else finishTurn(t, p && p.duration);
          break;
        }
        case "turn/error": case "error": {
          const e2 = p && p.error;
          failTurn(t, p && (p.message || (e2 && e2.message)), (p && p.code) || (e2 && e2.code));
          break;
        }
        default: break;
      }
    };

    const req = (method, params) => new Promise((resolve, reject) => {
      if (!child) return reject(new Error("bridge not started"));
      const id = nextId++;
      pending.set(id, { resolve, reject, method });
      try { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n"); }
      catch (e) { pending.delete(id); reject(e); }
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("bridge timeout: " + method)); } }, 120000);
    });

    // ★★★ 血案（2026-10-11 01:10）：**反向请求（审批 / 用户提问 / 动态工具调用）全链路断裂**。
    //   VS Code 的 agent host（Ax 实例，注入点同作用域变量 p）**原生注册**了这些反向请求处理器：
    //     p 作为 JSON-RPC 端点，已 onRequest("item/commandExecution/requestApproval")、
    //     onRequest("item/fileChange/requestApproval")、onRequest("item/permissions/requestApproval")、
    //     onRequest("item/tool/call")、onRequest("item/tool/requestUserInput")、
    //     onRequest("mcpServer/elicitation/request")  —— 均会渲染成 UI 审批卡/提问卡。
    //   而桥（作为 DSH→codex 转译层）在 DSH 发 session/request_permission 时，
    //   会**反向**向客户端发 rpc.request("item/permissions/requestApproval", ...)（带 id + method）。
    //
    //   旧版注入片段的分帧分支是**二元的**：
    //     ① msg.id && (result|error)  → 响应      ② msg.method（无 id）→ reflow 通知
    //   ⇒ 桥的反向请求（有 id + 有 method）落进**两个分支之外 ⇒ 被静默丢弃**！
    //   后果：① UI 无审批卡 ② 桥侧等应答永远不来 ⇒ DSH 的 request_permission 悬挂
    //        ⇒ turn 永久 pending（实测：写沙箱外文件时进程卡满 3.5 分钟仍未回）。
    //
    //   修：补**第三分支** —— 把桥的反向请求透传给 VS Code 的 RPC 端点 p（p.request 会触发
    //   上面那些 onRequest 处理器，弹出标准审批/提问 UI），拿到应答后回写给桥。
    //   契约对齐：桥 rpc.request 期望的应答 = codex 端点返回的原样 result
    //   （审批类形如 { result: { decision: "allow"|"deny"|... } } 或 { selectedOptionId }）；
    //   桥的 translateApprovalToAcpOutcome 两者都能解析，故这里**原样透传**最稳。
    const forwardInboundRequest = async (msg) => {
      const method = msg.method;
      const params = msg.params || {};
      try {
        // p = VS Code 侧那个 Ax（JSON-RPC 端点）。它可能叫 p 或 p 的别名，逐个探测。
        const ep = (typeof p !== "undefined" && p && typeof p.request === "function") ? p
          : (typeof p !== "undefined" && p && typeof p.sendRequest === "function") ? p : null;
        if (!ep) {
          log("error", "inbound " + method + ": no VS Code RPC endpoint (p) available; auto-denying");
          return { response: "cancel", decision: "deny" };
        }
        log("info", "inbound request → VS Code: " + method);
        const result = await ep.request(method, params);
        log("info", "inbound request answered: " + method + " → " + JSON.stringify(result).slice(0, 200));
        return result;
      } catch (e) {
        log("error", "inbound " + method + " failed: " + (e && e.message));
        // 出错时给「拒绝/取消」语义，避免上游永久悬挂（宁可安全拒绝，不可卡死）
        if (/requestUserInput|elicitation/.test(method)) return { response: "cancel" };
        return { decision: "deny" };
      }
    };

    const ensureBridge = (cwd) => {
      _probe();
      if (child) return;
      if (!spawnBridge) { log("error", "no spawn namespace available"); return; }
      child = spawnBridge(cfg.node, [
        cfg.bridge, "--node", cfg.node, "--dsh-bin", cfg.dshBin,
        "--cwd", cwd || cfg.cwd, "--provider-id", SESSION_TYPE_ID,
      ], { cwd: cwd || cfg.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      child.stdout && child.stdout.setEncoding("utf8");
      child.stderr && child.stderr.setEncoding("utf8");
      child.stderr && child.stderr.on("data", d => log("info", String(d).trimEnd()));
      // ★★ 血案（2026-10-11）：桥子进程退出后，child 变量仍非空、readyP 仍指向旧握手，
      //   后续任何 req() 都会因通道已断而**永久 pending** ⇒ 等满 120s ⇒
      //   "(sendFailed) bridge timeout: thread/start"（VS Code 现场日志实证）。
      //   修：退出时把 child / readyP / 会话映射全部置空，让下一次调用重新 spawn + 重新握手。
      child.on("exit", (code, sig) => {
        log("info", "bridge exited code=" + code + " sig=" + sig + "; resetting channel");
        child = null; buf = "";
        readyP = null;
        for (const [, p] of pending) { try { p.reject(new Error("bridge exited (code=" + code + ")")); } catch (_) {} }
        pending.clear();
        sessionByChatUri.clear(); chatUriBySession.clear();
        // ★ 同步清理 cwd 溯源/缓存（2026-10-14）：桥重启后会话映射已失效，
        //   残留的 cwd 记录会让新会话误判"cwd 不一致"。与上面两个 Map 同寿命。
        //   注：这两个 Map 声明在本闭包稍后位置（第 860/864 行），但 exit 回调
        //   只在 spawn 之后异步触发（此时片段已执行完）⇒ 引用安全；仍用 typeof 兜底。
        try {
          if (typeof _threadCwdByChat !== "undefined") _threadCwdByChat.clear();
          if (typeof _wdCache !== "undefined") _wdCache.clear();
        } catch (_) {}
      });
      child.stdout && child.stdout.on("data", chunk => {
        buf += chunk; let i;
        while ((i = buf.indexOf("\\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const p = pending.get(msg.id);
            if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.code + ": " + msg.error.message)) : p.resolve(msg.result); }
          } else if (msg.method && msg.id !== undefined) {
            // ★★★ 第三分支（2026-10-11 补）：桥→客户端的**反向请求**（审批/提问/动态工具调用）。
            //   必须回写应答，否则桥侧 rpc.request 永久 pending ⇒ DSH 审批悬挂 ⇒ turn 卡死。
            Promise.resolve()
              .then(() => forwardInboundRequest(msg))
              .then((result) => { try { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n"); } catch (_) {} })
              .catch((e) => { try { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e && e.message || e) } }) + "\\n"); } catch (_) {} });
          } else if (msg.method) {
            // ★ 通知（无 id）：走事件回流翻译成 chat/* action
            try { reflow(msg.method, msg.params || {}); } catch (e) { log("error", "reflow failed: " + e.message); }
          }
        }
      });
      log("info", "bridge spawned pid=" + (child && child.pid));
    };

    // ★★★ 会话工作目录解析（遗留项 4，2026-10-11）
    //   数据源优先级（全部实证，见 resolveSessionWorkingDir 的文档注释）：
    //     ① VS Code stateManager：y.getSessionState(sessionUri)?.workingDirectories
    //        —— 与内置 host 的 oo(this._stateManager, e) **同源同语义**（最准）。
    //     ② configurationService：j.getEffectiveWorkingDirectories(...) —— 等价备份。
    //     ③ 回落 cfg.cwd（保持旧行为，零回归）。
    //   sessionUri 从 chatContext 的 configurationResource / resource 取（Lu 里 configurationResource = session）。
    const _wdCache = new Map();   // chatKey → 解析出的工作目录（会话生命周期内稳定）
    // ★ cwd 溯源表（2026-10-14）：chatKey → { cwd, source }，记录建 thread 时实际用的 cwd。
    //   用途：ensureThread 冲突检测 —— 若首建用了 fallback（cfg.cwd）而后又解析到真实目录，
    //   可据此触发纠偏重建。这是「未分组」类问题的定位与自愈依据。
    const _threadCwdByChat = new Map();
    // 路径归一（仅用于比较）：反斜杠→正斜杠、去尾斜杠、Windows 盘符/路径小写。
    // ★ 注意：本代码位于模板字符串内，反斜杠需双重转义；为免歧义改用 split/join（无正则）。
    const normPath = (p) => {
      try {
        let s = String(p ?? "").split("\\\\").join("/");
        while (s.length > 1 && s.charAt(s.length - 1) === "/") s = s.slice(0, -1);
        if (/^[A-Za-z]:/.test(s)) s = s.toLowerCase();
        return s;
      } catch (_) { return String(p ?? ""); }
    };
    //   ★ 单一真源注入：这两个函数体来自 src/inject-snippet.mjs 的同名导出（离线可单测）。
    const resolveSessionWorkingDirFn = __RESOLVE_WD__;
    const uriLikeToFsPathFn = __URI_TO_PATH__;
    const expandChatUriVariantsFn = __EXPAND_CHAT_URI__;
    // DIAG 辅助：安全取 chatContext 字段并转字符串
    const ctxStr = (c, k) => {
      try {
        const v = c && c[k];
        if (v == null) return null;
        return typeof v === "string" ? v.slice(0, 120) : String(v).slice(0, 120);
      } catch (_) { return "<err>"; }
    };
    const resolveWd = (chatContext, chatKey) => {
      const hit = _wdCache.get(_K(chatKey));
      if (hit) return hit;
      const _diagKeys = [];
      let wd;
      // ★★★ 真根因（2026-10-11 CDP 真机实证，P0-1 二次修复）：
      //   chatContext 对象里 **没有** configurationResource/session/resource 任一字段
      //   （实测 cfgKeys={"configurationResource":null,"session":null,"resource":null}）。
      //   而 sendMessage 收到的 chatUri（= chatKey）**本身就是**会话 URI：
      //     chatContext.chatUri || chatContext.chat || chatContext.uri || chatContext
      //     ⇒ 实测值 ahp-chat://default/<base64url("dsh:/<uuid>")>
      //   所以解析的**首要来源应是 chatKey 本身**（而非 chatContext 的字段）。
      //   修：把 chatKey 也纳入候选（并对它做 ahp-chat:// → dsh:/<uuid> 变体展开）。
      //   保序：chatKey 优先（实测有效），再回落 chatContext 的字段（兼容其它形态）。
      const candidates = [];
      const pushCand = (v) => {
        if (v == null) return;
        const s = typeof v === "string" ? v : (typeof v.toString === "function" ? v.toString() : null);
        if (!s) return;
        candidates.push(s);
        try {
          for (const x of (expandChatUriVariantsFn ? expandChatUriVariantsFn(s) : [])) candidates.push(x);
        } catch (_) {}
      };
      pushCand(chatKey);                                   // ★ 首要来源（实测）
      if (chatContext && typeof chatContext === "object") {
        pushCand(chatContext.configurationResource);
        pushCand(chatContext.session);
        pushCand(chatContext.resource);
      }

      // ① stateManager 直查（首选）
      try {
        for (const uri of candidates) {
          if (!uri) continue;
          let st;
          try { st = (y && typeof y.getSessionState === "function") ? y.getSessionState(uri) : undefined; } catch (_) {}
          _diagKeys.push(uri.slice(0, 70) + "=>" + (st ? "HIT" : "miss"));
          const wds = st && st.workingDirectories;
          if (Array.isArray(wds) && wds.length) {
            for (const w of wds) { const p = uriLikeToFsPathFn(w); if (p) { wd = p; break; } }
            if (wd) break;
          }
        }
      } catch (_) {}
      // ② configurationService 备份路径
      if (!wd) {
        try {
          for (const uri of candidates) {
            if (!uri || !j || typeof j.getEffectiveWorkingDirectories !== "function") continue;
            let list;
            try { list = j.getEffectiveWorkingDirectories(uri); } catch (_) {}
            _diagKeys.push("cfg:" + uri.slice(0, 60) + "=>" + (Array.isArray(list) && list.length ? "HIT" : "miss"));
            if (Array.isArray(list) && list.length) {
              const p = uriLikeToFsPathFn(list[0]);
              if (p) { wd = p; break; }
            }
          }
        } catch (_) {}
      }
      if (wd) { _wdCache.set(_K(chatKey), wd); log("info", "resolveWd: chat=" + String(chatKey).slice(-12) + " cwd=" + wd); }
      else {
        // 失败时输出足够定位的上下文（仅在未命中时打印，无噪声）：
        //   chatKey 形态 + 两级探测的逐候选命中情况 + 回落值。
        log("info", "resolveWd: chat=" + String(chatKey).slice(-12) + " → 未解析到，回落 cfg.cwd=" + cfg.cwd +
          " | chatKey=" + ctxStr({ k: chatKey }, "k") +
          " ctxKeys=" + JSON.stringify({
            configurationResource: ctxStr(chatContext, "configurationResource"),
            session: ctxStr(chatContext, "session"),
            resource: ctxStr(chatContext, "resource"),
          }) +
          " probes=[" + _diagKeys.join(" | ") + "]");
      }
      return wd;
    };

    // ★ 血案：桥的 DSH 连接是在 initialize 请求里懒启动的（桥内部 await dsh.start()）。
    //   第 2 版注入片段直接发 model/list / thread/start，桥内 dsh 仍为 null
    //   ⇒ 报 -32603: Cannot read properties of null (reading 'request')。
    //   修正：任何请求前必须先完成一次 initialize 握手（幂等，缓存 promise）。
    let readyP = null;
    const ensureReady = (cwd) => {
      if (readyP) return readyP;
      ensureBridge(cwd);
      readyP = req("initialize", {
        clientInfo: { name: "vscode-dsh-provider", version: "0.1.0" },
        capabilities: {},
      }).then(r => { log("info", "bridge initialized: " + JSON.stringify(r && r.serverInfo || {})); return r; })
        .catch(e => { log("error", "initialize failed: " + e.message); readyP = null; throw e; });
      return readyP;
    };

    // 4) 会话改道：sendMessage → (懒建 thread) → turn/start（DSH）
    //    ★ 血案：第 1 版直接拿 VS Code 的 chatId 当 threadId 发 turn/start，
    //      而桥要求的是 thread/start 返回的 dsh sessionId ⇒ 桥找不到 session，回复永不回流，
    //      且 sendMessage 立刻 resolve ⇒ UI 认为轮次结束 ⇒ 允许重复发送。
    //    修正：先确保 thread 存在（懒建 + 缓存），再用真实 sessionId 发 turn。
    const ensureThread = async (chatUri, workDir) => {
      const key = String(chatUri);
      let sid = sessionByChatUri.get(key);
      if (sid) {
        // ★★★ 血案修复（2026-10-14）：cwd 溯源校验。已建 thread 时，若本次解析出的
        //   会话工作目录与建 thread 时用的不一致，说明前者用了 fallback（cfg.cwd）而
        //   后者才是**会话真实目录** —— 这正是「未分组」的病灶。此处显式告警以便定位，
        //   并在 workDir 更可信（非空且非 cfg.cwd）时**纠正**（见下方纠偏分支）。
        const rec = _threadCwdByChat.get(_K(key));
        if (rec && workDir && _K(normPath(workDir)) !== _K(normPath(rec.cwd))) {
          log("warn", "ensureThread: cwd 不一致 chat=" + String(key).slice(-12) +
            " 已建=" + rec.cwd + " (source=" + rec.source + ") 本次=" + workDir);
          // 纠偏：若已建 thread 用的是不可信来源（fallback/cfg.cwd），而本次拿到真实聚合目录
          // ⇒ 丢弃旧映射、重建 thread（旧 session 保留在 DSH，仅本会话改绑到正确 cwd）。
          if (rec.source !== "params.cwd" && _K(normPath(workDir)) !== _K(normPath(cfg.cwd))) {
            log("warn", "ensureThread: 触发 cwd 纠偏重建 chat=" + String(key).slice(-12) + " → " + workDir);
            try { chatUriBySession.delete(_K(sid)); } catch (_) {}
            try { sessionByChatUri.delete(_K(key)); } catch (_) {}
            sid = null;
          }
        }
        if (sid) return sid;
      }
      await ensureReady(workDir || cfg.cwd);
      // ★★★ 遗留项 4（2026-10-11）：把**会话真实工作目录**（worktree 隔离时为 worktree 路径）
      //   透传给 thread/start。参照内置 host 的语义：
      //     _resolveWorkingDirectoryBeforeSend → configurationService.getEffectiveWorkingDirectories(chat)
      //   ⇒ 会话的工作目录由 VS Code 会话配置决定，**不是**桥进程的静态启动目录。
      //   不传的话，worktree 会话的 DSH session 仍落在仓库主目录 ⇒ "隔离"名存实亡。
      //   回落序：解析出的 workDir → cfg.cwd（保持旧行为，零回归）。
      const cwdForThread = workDir || cfg.cwd;
      // ★ cwd 溯源（2026-10-14）：记录本次建 thread 用的 cwd 及其来源，供后续冲突检测。
      const cwdSrc = workDir ? "params.cwd" : "cfg.cwd(fallback)";
      // ★ 路线 B：把本会话选中的 agent（DSH preset）透传给桥 → thread/start。
      //   uri 形如 agent:<presetId>，剥前缀得到 presetId 供 DSH/桥使用。
      let agentArg;
      try {
        const sel = _selectedAgents.get(_K(key));
        if (sel && sel.uri) agentArg = String(sel.uri).replace(/^agent:/, "");
      } catch (_) {}
      const res = await req("thread/start", agentArg ? { cwd: cwdForThread, agent: agentArg } : { cwd: cwdForThread });
      sid = res && (res.threadId || res.sessionId);
      if (!sid) throw new Error("thread/start returned no threadId");
      sessionByChatUri.set(_K(key), _K(sid));
      chatUriBySession.set(_K(sid), _K(chatUri));   // 回流时 sessionId → chatUri（一律 String 归一）
      // ★ cwd 溯源记录（2026-10-14）：供后续 ensureThread 冲突检测 / 纠偏
      _threadCwdByChat.set(_K(key), { cwd: cwdForThread, source: cwdSrc });
      log("info", "map set: sid=" + String(sid).slice(-12) + " → uri=" + String(chatUri).slice(-12) + " (mapSize=" + chatUriBySession.size + ")");
      const c = cget(key); c.resource = _K(chatUri);
      log("info", "thread ready: chat=" + key + " dshSession=" + sid + " cwd=" + cwdForThread + " (source=" + cwdSrc + ")");
      return sid;
    };
    // ★★ 血案（真机第 4 版修复，2026-10-10 22:40）：
    //   真实调用签名（bundle 实证 @2612774）：chats.sendMessage(chatContext, messageText, turnId, attachments, ...)
    //   第 2 参是**纯字符串消息文本**（来自 outgoingTurn 的 k.message.text），第 3 参才是 turnId。
    //   第 3 版误写成 (chatId, turnId, input, ...) ⇒ text 取到的是 turnId 对象 ⇒ 解析为空串
    //   ⇒ 桥报 "Invalid params: empty prompt"（真机日志实证）。
    const readText = __READ_TEXT__;
    base.chats.sendMessage = (chatContext, messageText, turnId, ...rest) => {
      // 第 1 参是 chat context 对象（含 chatUri），取其稳定字符串作为 key/resource
      const chatUri = (chatContext && (chatContext.chatUri || chatContext.chat || chatContext.uri)) || chatContext;
      const key = _K(chatUri);
      const text = readText(messageText);
      // ★★★ 血案（2026-10-16，turnId 不一致导致对话空白）：
      //   VS Code renderer 派发一轮对话时会**自己生成 requestId** 并登记：
      //     (sessions.desktop.main.js @21322806) this._clientDispatchedTurnIds.add(c)  // c = t.requestId
      //   且后续判定「是否服务端主动发起」用的就是它：
      //     if (this._clientDispatchedTurnIds.has(O.id)) {...return}   // 认得出 → 跳过 server 分支
      //   ⇒ 若我们发的 chat/turnStarted 用自造的 "turn-<ts>"（≠ requestId），
      //     renderer 认不出 ⇒ 走 Server-initiated 分支 ⇒ 额外插一条消息（=双条）+ 现在就崩。
      //   ★ 修法：第 3 参 turnId（VS Code 传入的 requestId）**作为轮次唯一真源**，
      //     一路贯通到 chat/turnStarted、chat/responsePart、chat/turnComplete。
      //   注意：turnId 可能是对象（bundle 里为 { id } 形态），统一取纯字符串。
      //   ⚠ 必须在 ready 之外声明（ready.then 里要用），否则作用域不可见。
      const vscodeTurnId = (turnId && typeof turnId === "object")
        ? (turnId.id || turnId.turnId || String(turnId))
        : (turnId != null ? String(turnId) : null);
      log("info", "sendMessage reroute: chat=" + key + " textLen=" + text.length
          + " vscodeTurnId=" + String(vscodeTurnId || "null"));
      // ★ 返回一个「等 DSH 回复结束（turn/completed）」才 settle 的 promise：
      //   UI 据此保持 turn 进行中，从而禁止在上一条未回时重复发送。
      const done = new Promise((resolve) => { cget(key)._done = resolve; });
      // ★ 准备阶段（握手 / 建 thread / 下发 prompt）的错误必须**冒泡**，
      //   让 VS Code 标准 catch 走 chat/error（bundle @2612774）——这样 UI 自动显示错误块。
      //   只有「prompt 已下发、进入异步回流后」的错误才由 failTurn 自己 fire。
      const ready = (async () => {
        // ★ 遗留项 4：解析本会话工作目录（worktree 隔离时 = worktree 路径），
        //   先于 ensureBridge，让桥进程也以该目录为 cwd（与内置 host 语义对齐）。
        const wd = resolveWd(chatContext, key);
        ensureBridge(wd || cfg.cwd);
        cget(key).resource = _K(chatUri);
        const sid = await ensureThread(chatUri, wd);      // 可能 throw
        await req("turn/start", { threadId: sid, input: [{ type: "text", text }],
                                  vscodeTurnId: vscodeTurnId }); // 可能 throw
        return sid;
      })();
      ready.then(() => {
        // 只有 prompt 成功下发后才宣布轮次开始（避免失败时留下孤儿 turnStarted）
        // ★ 用 VS Code 的 turnId 建轮次（与 renderer 的 activeTurn.id 对齐）
        startTurn(key, text, vscodeTurnId);
      }).catch((e) => {
        // 准备失败 → 记录 + 让 sendMessage reject（触发 VS Code 标准 chat/error）
        log("error", "sendMessage prepare failed: " + (e && e.message));
        settleTurn(key);
      });
      // 安全兜底：即便通知丢失，120s 后也必须解锁，避免永久卡死
      const guard = setTimeout(() => settleTurn(key), 120000);
      return Promise.all([done, ready])
        .then(() => { clearTimeout(guard); return { threadId: chatUri, turnId: turnId }; })
        .catch((e) => { clearTimeout(guard); throw e; });   // ★ 冒泡 → 标准 chat/error
    };

    // ★★★ 4b) changeModel / changeAgent 改道（2026-10-12，modelSelectionFailed 真因修复）
    //
    //   【根因（bundle 逐环实证，agentHostMain.js）】
    //     _sendTurnMessage(e)（@2610457）里：
    //       let{agent:t,...} = e;                              // t = getProviderForSession(session)
    //       ... a.model && w.push(t.chats.changeModel(p, a.model, b))   // @2611382
    //       ... t.chats.sendMessage(...)                       // @2611823
    //     ⇒ changeModel / sendMessage **共用同一个 t**。
    //     · sendMessage 被本片段改道（下面的 base.chats.sendMessage）⇒ 走桥 ⇒ OK
    //     · changeModel 未改道 ⇒ 仍是 tt（= copilotcli provider 类）的原生实现：
    //         changeModel(e,t,n) => this._changeModel(e,t,n)     // chats 对象字面量 @1664681
    //         _changeModel → _changeModelOnce → await _validateModelSelection(t)  // @1489070
    //         _validateModelSelection: if (this._models.get().some(n=>n.id===e.id)) return;
    //                                  let t=this._models.get();
    //                                  if (t.length>0 && !t.some(n=>n.id===e.id))
    //                                    throw new Error(h(2955,null,e.id));   // "模型 '{0}' 无法获取。"
    //     ⇒ Copilot 的 _models 里**没有**桥注册的模型（那些只在本片段写进了 base._models）
    //     ⇒ 每次发消息都抛 modelSelectionFailed（[AgentSideEffects] modelSelection failed）。
    //
    //   【与 2026-10-12 双层前缀修复的关系】：
    //     上面是「changeModel 未改道」这一层的原因；而**更前置**还有一层：
    //     桥曾把模型 id 报成 "agent-host-dsh:<raw>"（自带前缀），VS Code 渲染层又补一层
    //     ⇒ availableModels 变成 "agent-host-dsh:agent-host-dsh:[...]"（双层）
    //     ⇒ 渲染层 selectModel 的 find(h=>h.identifier===e) 严格匹配失败
    //     ⇒ 直接报 selection-rejected/modelUnavailable，**发送被前置拒绝**（消息根本发不出去）。
    //     修复：桥改报**裸 id**（translate.mjs），与正常工作的 copilotcli 同构。
    //
    //   注：该 reject 发生在 Promise.all(w) 中且**不阻塞 sendMessage**，因此 14:13 那一轮
    //       sendMessage 仍能成功 —— 报错是「并行副作用」，不是「发送失败」。
    //
    //   【修法】把 changeModel / changeAgent 从 tt 原生实现上「摘下来」：
    //     · 不再调用 Copilot 的 _validateModelSelection（根除抛错）；
    //     · 模型解析 + 下发复用桥既有链路 thread/settings/update → session/set_config_option
    //       （bridge.mjs @614，已含「无法识别则拒绝、绝不静默回落默认 provider」的护栏）。
    //     · 失败只记日志、**不抛** —— 保持与 Copilot 侧 Promise.all 的容忍语义一致，
    //       绝不因模型设置问题把用户的正常发送打挂。
    const _chatUriOf = (chatLike) => {
      const u = (chatLike && (chatLike.chatUri || chatLike.chat || chatLike.uri)) || chatLike;
      return _K(u);
    };
    // 把「VS Code 模型对象/字符串」归一成桥可解析的模型串：
    //   优先取 .id —— 2026-10-12 裸 id 修复后，桥报的 id 已是**裸值**
    //   （如 '["bumen","deepseek-v4.1-flash"]'），VS Code 渲染层补一层前缀后
    //   变成 'agent-host-dsh:["bumen",...]'；bridge 的 translateModelSelectionToDsh
    //   会循环剥离前缀（兼容 1~2 层），再用 rawValue / name 反查，故两种形态都能解析。
    const _modelToBridgeString = (m) => {
      if (m == null) return undefined;
      if (typeof m === "string") return m;
      if (typeof m === "object") {
        if (typeof m.id === "string") return m.id;
        if (typeof m.identifier === "string") return m.identifier;
        if (typeof m.model === "string") return m.model;
      }
      return undefined;
    };
    base.chats.changeModel = async (chatLike, model, ..._rest) => {
      const key = _chatUriOf(chatLike);
      const modelStr = _modelToBridgeString(model);
      log("info", "changeModel reroute: chat=" + key + " model=" + JSON.stringify(modelStr));
      try {
        // 尚未建 thread 时先建（否则桥找不到 session 无法 set_config_option）
        let sid = sessionByChatUri.get(_K(key));
        if (!sid) {
          // ★★★ 血案修复（2026-10-14，P0 "设了工作区却挂未分组" 真根因）：
          //   changeModel 走 tt 原生 Promise.all，**时序上先于 sendMessage** 触发
          //   （实证 08:38:10.383 changeModel → .384 thread/start(cfg.cwd) → .542 sendMessage）。
          //   旧实现此处用 cfg.cwd（= 桥进程启动目录，注入时静态固化，与会话无关）建 thread
          //   ⇒ DSH 会话 header.cwd 被**写死为桥启动目录** ⇒ 与 VS Code 会话工作目录不符
          //   ⇒ DSH Web 归组失败（realpath(header.cwd) ≠ workspace.path）⇒ 落「未分组」。
          //   而随后 sendMessage 里 resolveWd 虽解析出**正确** cwd，却因 sid 已缓存被
          //   ensureThread 短路丢弃 ⇒ 正确 cwd 永远用不上。
          //   修：changeModel 也走 resolveWd（同一解析器，chatKey 同源），用**会话真实工作目录**
          //   建 thread；解析失败才回落 cfg.cwd（保持旧行为，零回归）。
          let wd;
          try { wd = resolveWd(chatLike, key); } catch (_) {}
          if (!wd) log("info", "changeModel: resolveWd 未解析到，回落 cfg.cwd=" + cfg.cwd);
          try { sid = await ensureThread(key, wd || cfg.cwd); }
          catch (e) { log("info", "changeModel: ensureThread failed (" + (e && e.message) + "); 跳过硬校验"); }
        }
        if (sid && modelStr) {
          // ★ 走桥：thread/settings/update → session/set_config_option（含解析 + 拒绝静默回落护栏）
          await req("thread/settings/update", { threadId: sid, model: modelStr });
          log("info", "changeModel reroute ok: sid=" + String(sid).slice(-12) + " -> " + modelStr);
        } else {
          log("info", "changeModel reroute skipped (sid=" + (sid ? "ok" : "none") + ", model=" + JSON.stringify(modelStr) + ")");
        }
      } catch (e) {
        // ★ 绝不冒泡：模型设置失败不得阻塞对话（sendMessage 才是关键路径）
        log("error", "changeModel reroute failed (ignored): " + (e && e.message));
      }
      return undefined;
    };
    // changeAgent：agent 由 thread/start 的 agent 参数承载；此处只需记录选中态，
    //   避免走 Copilot 原生 _changeAgent（同类校验/副作用）。
    base.chats.changeAgent = async (chatLike, agent, ..._rest) => {
      const key = _chatUriOf(chatLike);
      try {
        if (agent && typeof agent === "object") {
          _selectedAgents.set(_K(key), { uri: agent.uri, name: agent.name });
        }
      } catch (_) {}
      log("info", "changeAgent reroute (noop-recorded): chat=" + key + " agent=" + JSON.stringify(agent && (agent.uri || agent.name || agent)));
      return undefined;
    };

    // 5) 模型改道：桥的 model/list 已修复为「不依赖已建 thread」（2026-10-11）
    //    桥内部自带 bootstrap 探测会话 ⇒ 首次调用即返回全量模型，无需客户端预建。
    //    此处保留一层兼容探测：万一旧版桥仍在跑（未更新），补一次 thread/start 再列。

    // ★★★ 2026-10-15：把桥报回的模型「能力字段」透传进 base._models。
    //
    //   背景（双根因诊断，证据见 docs/DSH模型池归属与能力属性缺失-双根因诊断-20261015.md）：
    //     本行原先只写 {id,name,provider} 三个字段。而 agentHostMain.js 的
    //     _publishAgentInfos 是【逐字段挑选】：
    //       { id, provider, name, maxContextWindow, maxOutputTokens, maxPromptTokens,
    //         supportsVision, policyState, configSchema, _meta }
    //     ⇒ 未提供的字段一律成 undefined ⇒ renderer 侧 Vfe.provideLanguageModelChatInfo
    //       把它们填成默认值（maxInputTokens=0 / vision=false / configurationSchema 空）
    //     ⇒ VS Code 模型列表里「多模态 / 思考等级 / 上下文大小」全空。
    //
    //   修复：注入层把桥报回的字段补齐并透传（字段名严格对齐 _publishAgentInfos）。
    //   兼容：桥为旧版时不带这些字段 ⇒ 透传 undefined ⇒ 行为等同改动前（不退化）。
    //
    //   ★ 思考等级的正确形态（实测 agentHostMain.js）：
    //     _publishAgentInfos 不挑 supportedReasoningEfforts，只挑 configSchema。
    //     故此处必须把它转换成 JSON-Schema 形态的 configSchema：
    //       { type:"object", properties:{ thinkingLevel:{ type:"string", enum:[...], ... } } }
    //     其中 thinkingLevel 是 VS Code 的 key 常量（Mf="thinkingLevel"）。
    //     且 effort id 必须落在 VS Code 白名单内：
    //       bC = ["none","minimal","low","medium","high","xhigh","max","ultra"]
    //     DSH 的 "off" 不在白名单 ⇒ 必须过滤掉（原生 BYOK 同样 filter）。
    const VSCODE_THINKING_LEVEL_KEY = "thinkingLevel";
    const VSCODE_EFFORT_WHITELIST = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
    const _buildThinkingConfigSchema = (x) => {
      const raw = Array.isArray(x.supportedReasoningEfforts) ? x.supportedReasoningEfforts : [];
      const efforts = raw.filter((e) => typeof e === "string" && VSCODE_EFFORT_WHITELIST.includes(e));
      if (!efforts.length) return undefined;
      const labels = (x.reasoningEffortLabels && typeof x.reasoningEffortLabels === "object") ? x.reasoningEffortLabels : {};
      const def = (typeof x.defaultReasoningEffort === "string" && efforts.includes(x.defaultReasoningEffort))
        ? x.defaultReasoningEffort
        : (efforts.includes("medium") ? "medium" : efforts[0]);
      return {
        type: "object",
        properties: {
          [VSCODE_THINKING_LEVEL_KEY]: {
            type: "string",
            title: "Thinking Level",
            description: "Selectable reasoning effort for this model.",
            default: def,
            enum: efforts,
            enumLabels: efforts.map((e) => labels[e] ?? e),
          },
        },
      };
    };
    /** 桥的模型条目 → _publishAgentInfos 的字段形态（只写有值的，undefined 不写）。 */
    const _toProviderModel = (x) => {
      const m = { id: x.id, name: x.name, provider: x.provider };
      if (typeof x.maxContextWindow === "number") m.maxContextWindow = x.maxContextWindow;
      if (typeof x.maxOutputTokens === "number") m.maxOutputTokens = x.maxOutputTokens;
      if (typeof x.maxPromptTokens === "number") m.maxPromptTokens = x.maxPromptTokens;
      if (typeof x.supportsVision === "boolean") m.supportsVision = x.supportsVision;
      const cs = _buildThinkingConfigSchema(x);
      if (cs) m.configSchema = cs;
      if (x._meta && typeof x._meta === "object") m._meta = x._meta;
      return m;
    };

    /** ★ v5：桥报回的模型（最新一次），供 _publishModels 包装层追加。 */
    let _MODEL_OURS = [];
    /** 本壳是否已包过 _publishModels（幂等）。 */
    let _modelPublisherInstalled = false;

    /**
     * ★ v5 核心：包住 provider 壳的 _publishModels，使 ours 永不被 VS Code 原生逻辑覆盖。
     *
     *   原生（tt 类 @agentHostMain.js:1424655）：
     *     _publishModels(){ this._models.set([...this._capiModels, ...hydra?, ...this._byokModels], void 0) }
     *   —— 每次调用都会把 _models 重置为「capi + hydrafusion + byok」，ours 全丢。
     *
     * ★★★ 2026-10-15 v6（模型池白名单化 —— 用户问题①修复）：
     *
     *   血案（真机取证）：
     *     state.vscdb 的 chat.cachedLanguageModels.v2 里，vendor=agent-host-dsh 名下**有 9 条**：
     *       7 条真 DSH 模型（["deepseek-official","deepseek-flash"] 等）
     *     + 3 条**不属于 DSH 的外来项**：
     *         · hydrafusion             —— VS Code 原生「路由模型」
     *         · customendpoint/Bowei/Qwen3.8-Flash-AI     —— VS Code BYOK
     *         · customendpoint/BoweiBM/deepseek-v4.1-flash —— VS Code BYOK
     *     真机日志铁证（agenthost.log）：P5DIAG#2 base.models n=10
     *       [hydrafusion|customendpoint/Bowei/...|customendpoint/BoweiBM/...|["deepseek-official",...]
     *
     *   根因：原生 _publishModels 的池 = _capiModels（DSH 恒空）+ hydrafusion（可配开关）
     *     + _byokModels（_refreshByokModels 把 chatLanguageModels.json **对每个 provider 无差别克隆**）。
     *     而**旧包装层只 append（追加 ours）、从不 filter（剔除外来）** ⇒ 池 = 3 外来 + 7 ours。
     *
     *   修法：**白名单化** —— 包装层跑完原生后，把 _models **整体重置为 ours**（_MODEL_OURS）。
     *     · ours 是桥 model/list 报回的 7 条，带 modelGroups/rawValue 等桥侧元数据，
     *       是判断「是否 DSH 真模型」的**权威白名单**。
     *     · _models 是各 provider **实例私有**（构造器 this._models = li(this, [])），
     *       本壳只改自己实例 ⇒ **不影响 copilotcli/claude/codex**。
     *     · **安全兜底**：若 _MODEL_OURS 尚为空（bootstrap 未完成 / 桥未就绪），
     *       **不重置池**（保持原生结果），避免把下拉清空；待 ours 到位后下一次 publish 即净化。
     *     · 幂等、无副作用（每次 publish 都是「先原生、再覆盖为 ours」）。
     */
    const _installModelPublisher = () => {
      if (_modelPublisherInstalled) return;
      try {
        const _orig = base._publishModels;
        if (typeof _orig !== "function") {
          log("error", "models: _publishModels not a function on base — cannot install publisher");
          return;
        }
        const _bound = _orig.bind(base);
        base._publishModels = function () {
          let ok = false;
          try { _bound(); ok = true; }
          catch (e) { log("error", "models: original _publishModels threw: " + (e && e.message)); }
          try {
            // ★ v6 白名单化：ours 就绪时，池 = ours（剔净 hydrafusion / BYOK 克隆等外来项）。
            //   未就绪时不动池（兜底，避免清空下拉）。
            if (!_MODEL_OURS.length) return;
            const before = (base._models && base._models.get && base._models.get()) || [];
            const beforeIds = [];
            for (let i = 0; i < before.length; i++) { try { beforeIds.push(String(before[i].id)); } catch (_) {} }
            base._models.set(_MODEL_OURS, undefined);
            const removed = beforeIds.filter((id) => !_MODEL_OURS.some((m) => String(m.id) === id));
            log("info", "models: pool whitelisted → " + _MODEL_OURS.length + " ours" +
              (removed.length ? " (removed " + removed.length + " foreign: " + removed.join(",") + ")" : " (no foreign)"));
          } catch (e) { log("error", "models: publisher whitelist failed: " + (e && e.message)); }
          if (!ok) return;
        };
        _modelPublisherInstalled = true;
        log("info", "models: _publishModels wrapped (ours-only whitelist installed)");
      } catch (e) { log("error", "models: install publisher failed: " + (e && e.message)); }
    };

    const refreshModels = async () => {
      try {
        await ensureReady(cfg.cwd);
        let res = await req("model/list", {});
        let ms = (res && res.models) || [];
        if (!ms.length) {
          // 兼容旧版桥：冷启动空列表时补建探测 thread 再列
          await req("thread/start", { cwd: cfg.cwd }).catch(e => log("info", "probe thread/start: " + e.message));
          res = await req("model/list", {});
          ms = (res && res.models) || [];
        }
        if (ms.length && base._models && base._models.set) {
          // ★ v5（2026-10-15 深夜，真根因·最终）：既 set 又【包 _publishModels】。
          //   真机铁证：v4 的 fire 确实生效（19:03:25 日志 'republished via base._plugins._onDidChange.fire()'），
          //   但 19:03:36 发消息后池又变回 BYOK 3 条。根因不在 fire，而在
          //   tt._publishModels()  （agentHostMain.js:1424655，293 字符）：
          //       this._models.set([...this._capiModels, ...hydrafusion?, ...this._byokModels], undefined)
          //   ★ 它【完全不含】桥报的模型 —— 我们的 set 只是被它覆盖前的临时状态。
          //   _publishModels 有 7 个调用点（_listModels 成功 / _refreshByokModels / client 重启…），
          //   而启动+发消息期间 BYOK bridge changed; refreshing models 会触发多次 ⇒ 每次覆盖。
          //   ⇒ 唯一稳法：包住 _publishModels，set 后把 ours 追加回去（按 id 去重，幂等）。
          _MODEL_OURS = ms.map(_toProviderModel);
          base._models.set(_MODEL_OURS, undefined);
          const withCaps = ms.filter(x => typeof x.maxContextWindow === "number" || typeof x.supportsVision === "boolean").length;
          log("info", "models refreshed: " + ms.length + " [" + ms.map(x => x.id).join(", ") + "] caps=" + withCaps);
          _installModelPublisher();

          // ★★★ 2026-10-15 v3（真根因修复）：set 完 _models 必须【主动触发一次 agent 信息重发布】。
          //
          //   证据链（agentHostMain.js 逐段实证）：
          //     ① 池数据源 = _publishAgentInfos(this._options.agents.get())
          //          → { provider, ..., models: r.models.get().map(逐字段挑选) }
          //          → dispatchServerAction("root/agentsChanged", { agents })
          //     ② renderer: _handleRootStateChange → _registerAgent(agent)
          //          → new Vfe("agent-host-dsh") → g.updateModels(agent.models)   ← 池就是它
          //     ③ Provider 基类构造： this._models = li(this,[]); this.models = this._models;
          //          ⇒ base._models 与 r.models 是【同一对象】⇒ 写它有数据
          //     ④ 但 _publishAgentInfos 只有 4 个触发点，_models 变化【不在其中】：
          //          - _options.agents observable
          //          - provider.onDidCustomizationsChange    ← ★ 本处采用
          //          - root/configChanged
          //          - 会话相关
          //   ⇒ 旧版只 set 不 fire ⇒ agentsChanged 不重发 ⇒ renderer 的 agent.models
          //     停留在启动时空值 ⇒ updateModels(空) ⇒ dsh 池只剩 VS Code 自己合成的
          //     hydrafusion + 2 个 BYOK 克隆（实测 state.vscdb 正是这 3 条）。
          //
          //   ★★★ v4 更正（2026-10-15 夜，真机日志证伪 v3 假设）：
          //     v3 假设「_onDidCustomizationsChange 与 _models 同段构造、必存在」——**错**。
          //     真机日志：models: customizations emitter not fireable (has onDidCustomizationsChange fn only)
          //     ⇒ v3 走了 else-if 退化分支，**从未 fire**，池从未刷新。
          //
          //     代码铁证（tt = copilotcli provider 类 @agentHostMain.js:1389106，类体 ~118747 字符）：
          //       符号计数：_models 7 次 / _capiModels 8 / _byokModels 10 / getCustomizations 2
          //                 onDidCustomizationsChange 1 次（内容↓）
          //                 _onDidCustomizationsChange **0 次**   ← ★ 根本不存在
          //       那 1 次是：this.onDidCustomizationsChange = this._plugins.onDidChange;
          //       ⇒ base.onDidCustomizationsChange 是【事件注册函数 event(fn)】，不是 emitter，
          //         没有 .fire()。vscode 基类惯用写法 X.onDidY = X._onDidY.event 。
          //
          //     ★ 真 emitter 在 plugins 控制器上：Zb 类（@1510311）构造
          //         this._onDidChange = this._register(new F);
          //         this.onDidChange  = this._onDidChange.event;
          //       ⇒ 真 emitter = base._plugins._onDidChange，**可 .fire()**
          //
          //     链路：base._plugins._onDidChange.fire()
          //         → Zb.onDidChange → tt.onDidCustomizationsChange（触发点②的订阅源）
          //         → _publishAgentInfos(this._options.agents.get()) → root/agentsChanged → renderer updateModels(7)
          //
          //   幂等且无副作用：customizations 事件本就会周期性因 MCP/插件变化而 fire。
          try {
            let _em = null, _via = "";
            // ① 首选：真 emitter（plugins 控制器）
            try {
              const _pl = base._plugins;
              if (_pl && _pl._onDidChange && typeof _pl._onDidChange.fire === "function") {
                _em = _pl._onDidChange; _via = "base._plugins._onDidChange.fire()";
              }
            } catch (_) {}
            // ② 兼容：某些 provider 壳直接挂 emitter（非 event 函数）
            if (!_em) {
              try {
                const _c = base._onDidCustomizationsChange;
                if (_c && typeof _c.fire === "function") { _em = _c; _via = "base._onDidCustomizationsChange.fire()"; }
              } catch (_) {}
            }
            if (_em) {
              _em.fire();
              log("info", "models: republished via " + _via);
            } else {
              // 彻底找不到 ⇒ 打印候选字段便于下一轮取证（不再静默）
              let _keys = "";
              try {
                _keys = Object.getOwnPropertyNames(base).filter(k => /custom|Custom|plugin|Plugin/i.test(k)).join(",");
                const _pl = base._plugins;
                if (_pl) _keys += " || plugins{" + Object.getOwnPropertyNames(_pl).filter(k => /Change|change/i.test(k)).join(",") + "}";
              } catch (_) {}
              log("error", "models: NO fireable customizations emitter — pool won't refresh; candidates=" + _keys);
            }
          } catch (e) { log("error", "models: republish fire failed: " + (e && e.message)); }

          // ★ v5/v6：包好 _publishModels 后【立即主动调一次】，让首发就走包装路径。
          //   v6 白名单化后：原生 set（capi+hydra+byok）会被包装层**整体覆盖为 ours**
          //   ⇒ 首发即净化，下拉只剩 DSH 真模型。
          try {
            if (typeof base._publishModels === "function") {
              base._publishModels();
              log("info", "models: published via wrapped _publishModels (n=" + ((base._models && base._models.get && base._models.get()) || []).length + ")");
            }
          } catch (e) { log("error", "models: wrapped _publishModels call failed: " + (e && e.message)); }
        } else {
          log("error", "models empty after bootstrap+probe — VS Code will fall back to Auto (check bridge bootstrapError)");
        }
      } catch (e) { log("info", "refreshModels skipped: " + e.message); }
    };
    // 预热稍早触发（桥已改在 initialize 里主动建 bootstrap），并补一次延迟重试兜住慢启动
    setTimeout(refreshModels, 1200);
    setTimeout(refreshModels, 4000);

    // ★★★ 路线 B（2026-10-11）：把 DSH 的 agent preset 喂给 VS Code 的 agent picker。
    //
    //   契约实证（sessions.desktop.main.js）：
    //     agentHostAgentPicker._initAgent(...):
    //        let l = c.getCustomAgents(e.sessionId);          // c = provider（本实例）
    //        let p = Xyn(l, t, u);  ... this._setAgent(e, c, p)
    //     _setAgent(...): t.setAgent?.(e.sessionId, {uri, name})   // 选中后回调 provider
    //     _ensureProviderListener(provider):
    //        provider.onDidChangeCustomAgents(() => fire 刷新)  // provider 必须暴露该事件
    //   ⇒ 只要 provider 实现 getCustomAgents / setAgent / onDidChangeCustomAgents，
    //     即可让 DSH preset 出现在 picker 里并被选中。
    //
    //   agent 项形态（参照 _agentFromMode）：{ id, uri, name, type:"agent", description? }
    //   uri 用 agent:<presetId> 形式，便于 setAgent 时反解 presetId。
    let _agentCache = [];        // 从桥 agent/list 拉到的 preset 数组
    const _agentEmitter = (() => {
      // 复用 provider 基类的 emitter 工厂；缺失时自造一个极简 Emitter
      try { if (base._onDidChangeCustomAgents) return base._onDidChangeCustomAgents; } catch (_) {}
      const listeners = [];
      return {
        event: (fn) => { listeners.push(fn); return { dispose: () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); } }; },
        fire: () => { for (const fn of [...listeners]) { try { fn(); } catch (_) {} } },
      };
    })();
    const _agentEventObj = _agentEmitter.event ? { dispose() {} } : undefined;

    const _toPickerAgent = (a) => ({
      id: String(a.id),
      uri: "agent:" + String(a.id),
      name: a.name || String(a.id),
      type: "agent",
      ...(a.description ? { description: a.description } : {}),
    });

    // ★★★ 路线 B 真根因修复（2026-10-11 23:5x，bundle 实证）：
    //   picker 的 agent 真源是 **harness 的 itemProvider**，优先级高于 promptsService：
    //     customizationHarnessService.getCustomAgents(o,e){
    //       let t = Li(o), i = this.findHarnessById(t);              // t = session scheme
    //       if (!i || !i.itemProvider)
    //         return (await this.promptsService.getCustomAgents(e)).filter(l => rw(l.sessionTypes, t));   // 【第3路】
    //       if (i.itemProvider.provideCustomAgents)                   // 【第1路】★ 最高优先
    //         return i.itemProvider.provideCustomAgents(o, e);
    //       let n = await i.itemProvider.provideChatSessionCustomizations(o, e);                          // 【第2路】
    //       ...
    //     }
    //   ⇒ 只要 harness 的 itemProvider 实现了 provideCustomAgents，就**完全绕过** promptsService。
    //   之前只覆盖了 provider 自身的 getCustomAgents（那是另一条“恢复已选”的路径），
    //   而 picker 走的是 itemProvider.* —— **这就是“桥返回 5 个、picker 却恒空”的真因**。
    //
    //   itemProvider 的取法：i.itemProvider。我们的 provider（壳）上需暴露 itemProvider，
    //   其形态须含 { provideCustomAgents, provideChatSessionCustomizations, onDidChange }。
    //   ★ 用 _refreshRef 间接引用，避免 refreshAgents 的 TDZ（它在下面才 const 声明）。
    const _refreshRef = { fn: null };
    const _toItemAgent = (a) => ({
      uri: "agent:" + String(a.id),
      name: a.name || String(a.id),
      description: a.description,
      type: "agent",
      enabled: true,
      sessionTypes: [SESSION_TYPE_ID],
    });
    const _itemProvider = (() => {
      // 复用 provider 上可能已存在的 itemProvider（补齐缺失方法）；否则新建
      let ip = null;
      try { ip = base.itemProvider; } catch (_) {}
      if (!ip || typeof ip !== "object") ip = {};
      try {
        ip.provideCustomAgents = (o, e) => {
          try {
            if (!_agentCache.length) { try { _refreshRef.fn && _refreshRef.fn(); } catch (_) {} return []; }
            const arr = _agentCache.map(_toItemAgent);
            log("info", "itemProvider.provideCustomAgents → " + arr.length + " [" + arr.map(x => x.name).join(",") + "]");
            return arr;
          } catch (err) { log("error", "provideCustomAgents failed: " + (err && err.message)); return []; }
        };
      } catch (_) {}
      try {
        ip.provideChatSessionCustomizations = (o, e) => {
          try {
            if (!_agentCache.length) return [];
            return _agentCache.map(a => ({
              uri: "agent:" + String(a.id), type: "agent",
              name: a.name || String(a.id), description: a.description,
              enabled: true, source: "user", sessionTypes: [SESSION_TYPE_ID],
            }));
          } catch (_) { return []; }
        };
      } catch (_) {}
      try { ip.onDidChange = ip.onDidChange || ((fn) => _agentEmitter.event(fn)); } catch (_) {}
      try {
        Object.defineProperty(base, "itemProvider", { configurable: true, enumerable: true, get: () => ip });
      } catch (_) { try { base.itemProvider = ip; } catch (_) {} }
      return ip;
    })();

    // 覆盖 getCustomAgents：返回 DSH preset 列表（同步签名——picker 调用处未 await）
    const _origGetCustomAgents = base.getCustomAgents ? base.getCustomAgents.bind(base) : null;
    base.getCustomAgents = (sessionId) => {
      try {
        void sessionId;
        if (_agentCache.length) return _agentCache.map(_toPickerAgent);
        // 尚未拉到（桥冷启动）→ 触发一次后台拉取；本次先返回原实现（通常空）以免阻塞
        refreshAgents();
        return _origGetCustomAgents ? (_origGetCustomAgents(sessionId) || []) : [];
      } catch (e) { log("error", "getCustomAgents failed: " + (e && e.message)); return []; }
    };

    // 覆盖 setAgent：记住用户选中的 agent，供 thread/start 透传给桥 → DSH preset
    const _selectedAgents = new Map();   // sessionId → { uri, name }
    const _origSetAgent = base.setAgent ? base.setAgent.bind(base) : null;
    base.setAgent = (sessionId, agent) => {
      try {
        if (agent) { _selectedAgents.set(String(sessionId), agent); log("info", "setAgent: session=" + String(sessionId).slice(-12) + " agent=" + JSON.stringify(agent)); }
        else { _selectedAgents.delete(String(sessionId)); log("info", "setAgent: cleared for " + String(sessionId).slice(-12)); }
      } catch (_) {}
      try { if (_origSetAgent) _origSetAgent(sessionId, agent); } catch (_) {}
    };
    base.getSelectedAgentForBridge = (sessionId) => _selectedAgents.get(String(sessionId)) ?? null;

    // 暴露 onDidChangeCustomAgents 事件（picker 的 _ensureProviderListener 必需）
    try {
      Object.defineProperty(base, "onDidChangeCustomAgents", {
        configurable: true,
        get: () => _agentEmitter.event,
      });
    } catch (_) { try { base.onDidChangeCustomAgents = _agentEmitter.event; } catch (_) {} }

    // 从桥拉取 preset 清单（agent/list），成功后 fire 变更事件让 picker 刷新
    let _agentFetching = false;
    const refreshAgents = async () => {
      if (_agentFetching) return;
      _agentFetching = true;
      try {
        await ensureReady(cfg.cwd);
        const res = await req("agent/list", {});
        const list = (res && res.agents) || [];
        const before = _agentCache.map(a => a.id).join(",");
        _agentCache = list;
        const after = _agentCache.map(a => a.id).join(",");
        log("info", "agents refreshed: " + _agentCache.length + " [" + after + "]");
        if (before !== after) { try { _agentEmitter.fire(); } catch (_) {} }
      } catch (e) {
        log("info", "refreshAgents skipped: " + (e && e.message));
      } finally { _agentFetching = false; }
    };
    setTimeout(refreshAgents, 1500);
    setTimeout(refreshAgents, 5000);
    // ★ 打通间接引用（供 itemProvider.provideCustomAgents 在冷启动时触发拉取）
    _refreshRef.fn = refreshAgents;
    // ★ 诊断：确认 itemProvider 已挂上（这是 picker 的第 1 优先数据源）
    try {
      const ipChk = base.itemProvider;
      log("info", "itemProvider mounted: provideCustomAgents=" + (ipChk && typeof ipChk.provideCustomAgents) +
        " provideChatSessionCustomizations=" + (ipChk && typeof ipChk.provideChatSessionCustomizations) +
        " onDidChange=" + (ipChk && typeof ipChk.onDidChange));
    } catch (e) { log("error", "itemProvider check failed: " + (e && e.message)); }

    // 6) 注册
    // ★★★ 铁探针（2026-10-16）：到达 registerProvider 前
    try {
      var _ib5 = "[dsh-ironboot] reached step6 before registerProvider; base.id=" + base.id;
      try { process.stderr.write(_ib5 + String.fromCharCode(10)); } catch (_) {}
      try {
        var _bfs5 = process.getBuiltinModule && process.getBuiltinModule("fs");
        if (_bfs5 && _bfs5.appendFileSync) _bfs5.appendFileSync(cfg.bridge.replace(/[^/\\\\]+$/, "") + "../temp/ironboot.log", new Date().toISOString() + " " + _ib5 + String.fromCharCode(10));
      } catch (_) {}
    } catch (_) {}
    __PROVIDER_SVC__.registerProvider(base);
    try {
      var _ib6 = "[dsh-ironboot] registerProvider RETURNED OK";
      try { process.stderr.write(_ib6 + String.fromCharCode(10)); } catch (_) {}
      try {
        var _bfs6 = process.getBuiltinModule && process.getBuiltinModule("fs");
        if (_bfs6 && _bfs6.appendFileSync) _bfs6.appendFileSync(cfg.bridge.replace(/[^/\\\\]+$/, "") + "../temp/ironboot.log", new Date().toISOString() + " " + _ib6 + String.fromCharCode(10));
      } catch (_) {}
    } catch (_) {}
    log("info", "provider injected: id=" + ID + " bridge=" + cfg.bridge);

    // ★ v5 诊断：周期打印 base.models 实时内容 —— 直接观察「发消息后池是否被覆盖」。
    //   只在前 90 秒内每 3 秒打一次（避免长期刷日志）。
    try {
      let _diagN = 0;
      const _diagTimer = setInterval(() => {
        _diagN++;
        if (_diagN > 30) { clearInterval(_diagN); clearInterval(_diagTimer); return; }
        try {
          const cur = (base._models && base._models.get && base._models.get()) || [];
          const ids = cur.map(x => x && x.id).join("|");
          log("info", "P5DIAG#"+_diagN+" base.models n=" + cur.length + " pubCount=" + (base._publishCount||0) + " [" + ids + "]");
        } catch (e) { log("error", "P5DIAG err: " + (e && e.message)); }
      }, 3000);
    } catch (_) {}

    // ★ v5 诊断：给 _publishModels 计数（不改变行为，只在原函数外记录）
    try {
      const _pc0 = base._publishModels;
      if (typeof _pc0 === "function" && !base._publishCount) {
        base._publishCount = 0;
        const _pcWrapped = base._publishModels;   // 已被 _installModelPublisher 包过
        base._publishModels = function () {
          base._publishCount++;
          log("info", "P5DIAG _publishModels() called #" + base._publishCount);
          return _pcWrapped.apply(base, arguments);
        };
      }
    } catch (_) {}

    // ★ 诊断探针（2026-10-11，路线B 排障）：读 provider 服务里真实的 id 表 + getProvider 行为
    setTimeout(() => {
      try {
        const P = D._providers;
        const kind = P ? (typeof P.get === "function" ? "Map" : (typeof P.add === "function" ? "Set" : typeof P)) : "null";
        let ids = [];
        try { if (P && P.keys) ids = [...P.keys()]; else if (P && P.forEach) { P.forEach((v) => ids.push(v && v.id)); } } catch (_) {}
        const byGet = (() => { try { const r = P && P.get ? P.get(ID) : null; return r ? (r.id || "obj") : "undefined"; } catch (e) { return "throw:" + e.message; } })();
        let byId = "n/a";
        try { if (P) { let found = false; if (P.forEach) P.forEach((x) => { if (x && x.id === ID) found = true; }); else if (P[Symbol.iterator]) for (const x of P) { if (x && x.id === ID) found = true; } byId = found ? "found" : "notfound"; } } catch (e) { byId = "throw:" + e.message; }
        const gp = (() => { try { const r = D.getProvider ? D.getProvider(ID) : "noMethod"; return r ? (r.id || "obj") : "undefined"; } catch (e) { return "throw:" + e.message; } })();
        const gpn = (() => { try { const r = D.getProvider ? D.getProvider("copilotcli") : "noMethod"; return r ? (r.id || "obj") : "undefined"; } catch (e) { return "throw:" + e.message; } })();
        const allM = (() => { try { return D.getProviders ? D.getProviders().map((x) => x && x.id).join(",") : "noMethod"; } catch (e) { return "throw:" + e.message; } })();
        const baseOwn = [];
        for (const k of ["getCustomAgents", "setAgent", "onDidChangeCustomAgents", "id"]) { try { baseOwn.push(k + "=" + typeof base[k]); } catch (_) {} }
        const line = "[dsh-bridge][DIAG] providerSvc kind=" + kind + " size=" + (P && P.size) + " ids=[" + ids.join(",") + "]"
          + " | get(ID)=" + byGet + " | scan.findBy.id=" + byId
          + " | D.getProvider(ID)=" + gp + " | D.getProvider(copilotcli)=" + gpn
          + " | getProviders()=" + allM
          + " | base{" + baseOwn.join(" ") + "} cacheN=" + _agentCache.length;
        log("info", line);   // ★ 写入文件日志（原仅 c.error 进 logService，取证不可读）
        try { c.error(line); } catch (_) { try { console.error(line); } catch (_) {} }
      } catch (e) { try { c.error("[dsh-bridge][DIAG] probe failed: " + (e && e.stack || e)); } catch (_) {} }
    }, 8000);

    // ★★★ P4 诊断（2026-10-12）：modelSelectionFailed 根因定位。
    //   假设链：_sendTurnMessage 里 agent = getProviderForSession(session)；
    //     getProviderForSession: ① _sessionToProvider.get(uri) ② L.provider(uri) ③ _defaultProvider
    //   若 ①② 均 miss ⇒ 回落到 _defaultProvider（= 第一个注册的 provider，很可能是 copilotcli）
    //     ⇒ t = Copilot provider ⇒ t.chats.changeModel → Copilot._validateModelSelection → 抛错。
    //   本探针只读，打印三段判定 + 对真实 dsh session uri 的解析结果。
    setTimeout(() => {
      try {
        const _safe = (f) => { try { return f(); } catch (e) { return "throw:" + (e && e.message); } };
        const dp = _safe(() => D._defaultProvider === undefined ? "undefined" : String(D._defaultProvider));
        const stp = _safe(() => {
          const M = D._sessionToProvider;
          if (!M) return "null";
          const arr = [];
          try { M.forEach((v, k) => arr.push(String(k) + "=>" + String(v))); } catch (_) {}
          return "size=" + (M.size) + " [" + arr.slice(0, 8).join(" | ") + "]";
        });
        // 用真实 dsh session uri 试解析（从 state 里取一条；取不到就用构造串）
        const probeUri = _safe(() => {
          const cand = "dsh:/f26b9322-17ce-49be-93ff-c20e67755a1a";
          return cand;
        });
        const gpf = _safe(() => {
          if (typeof D.getProviderForSession !== "function") return "noMethod";
          const r = D.getProviderForSession(probeUri);
          return r ? (r.id || "obj") : "undefined";
        });
        const gpfHostScheme = _safe(() => {
          if (typeof D.getProviderForSession !== "function") return "noMethod";
          const cand2 = "agent-host-dsh:/f26b9322-17ce-49be-93ff-c20e67755a1a";
          const r = D.getProviderForSession(cand2);
          return r ? (r.id || "obj") : "undefined";
        });
        const line = "[dsh-bridge][P4DIAG] _defaultProvider=" + dp
          + " | _sessionToProvider(" + stp + ")"
          + " | getProviderForSession(" + probeUri + ")=" + gpf
          + " | getProviderForSession(agent-host-dsh:/... )=" + gpfHostScheme;
        log("info", line);
        try { c.error(line); } catch (_) {}
      } catch (e) { try { c.error("[dsh-bridge][P4DIAG] failed: " + (e && e.stack || e)); } catch (_) {} }
    }, 9000);
  } catch (e) {
    // ★★★ 铁探针（2026-10-16）：原实现用硬编码 c.error()（1.142 里 c 已非 logService ⇒ 抛异常被吞）
    //   ⇒ 异常信息永久丢失。改为零依赖三路留痕：stderr + getBuiltinModule(fs) + console。
    //   ★ 排障完成后整段删除（是探针，不是产品功能）。
    try {
      var _IRONERR = "[dsh-ironerr] snippet THREW: " + (e && e.message) +
        String.fromCharCode(10) + "STACK: " + (e && e.stack ? String(e.stack) : "(no stack)");
      try { process.stderr.write(_IRONERR + String.fromCharCode(10)); } catch (_) {}
      try { console.log(_IRONERR); } catch (_) {}
      try {
        var _bfs2 = process.getBuiltinModule && process.getBuiltinModule("fs");
        if (_bfs2 && _bfs2.appendFileSync) {
          _bfs2.appendFileSync("C:/Users/liuyue/WorkBuddy/2026-10-09-10-48-30/temp/dsh-ahp-bridge/bridge/temp/ironerr.log",
            new Date().toISOString() + " pid=" + process.pid + String.fromCharCode(10) + _IRONERR + String.fromCharCode(10));
        }
      } catch (_) {}
    } catch (_) {}
    try { __LOG_SVC__ && __LOG_SVC__.error && __LOG_SVC__.error("[dsh-bridge] inject failed: " + (e && e.message)); } catch (_) {}
  }
})({
  bridge: "__BRIDGE__",
  dshBin: "__DSH_BIN__",
  node: "__NODE__",
  cwd: "__CWD__",
})
/* <<< BOWEI-DSH-P3-END <<< */
`;

/** 旧版（保留备查）：仅改身份、不接桥 —— 即 C 路 DEMO 的做法 */
export const BOWEI_IDENTITY_ONLY_SNIPPET = `
/* >>> BOWEI-C-INJECT-BEGIN >>> */
(() => {
  try {
    let _b = __DI__.createInstance(__SHELL_CLS__);
    _b.id = "bowei";
    _b.getDescriptor = () => ({
      provider: "bowei", displayName: "Bowei",
      description: "Bowei AHP harness (C-route demo)",
      capabilities: { multipleChats: { fork: true, sideChat: true } },
    });
    __PROVIDER_SVC__.registerProvider(_b);
    try { n.value.info("[bowei-inject] provider injected id=bowei") } catch (_) {}
  } catch (_e) { try { n.value.error("[bowei-inject] failed", _e) } catch (_) {} }
})()
/* <<< BOWEI-C-INJECT-END <<< */
`;

// 保留旧导出名以兼容既有引用
export const BOWEI_DSH_INJECT_SNIPPET = P3_TT_SHELL_REROUTE_SNIPPET;

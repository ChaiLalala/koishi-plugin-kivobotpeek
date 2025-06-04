var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  Config: () => Config,
  apply: () => apply
});
module.exports = __toCommonJS(index_exports);
var import_koishi = require("koishi");
var import_crypto = require("crypto");
var import_ws = require("ws");
var import_ws2 = require("ws");
var logger = new import_koishi.Logger("screenshot-service");
var Config = import_koishi.Schema.object({
  port: import_koishi.Schema.number().default(8765).description("WebSocket 服务器端口"),
  authToken: import_koishi.Schema.string().required().description("客户端认证令牌"),
  commandPrefix: import_koishi.Schema.string().default("截图").description("指令前缀"),
  maxClients: import_koishi.Schema.number().default(10).description("最大客户端数量"),
  responseTimeout: import_koishi.Schema.number().default(3e4).description("响应超时时间(ms)")
});
function apply(ctx, config) {
  const clients = /* @__PURE__ */ new Map();
  const pendingSessions = /* @__PURE__ */ new Map();
  const wss = new import_ws.WebSocketServer({ port: config.port });
  logger.info(`截图服务已启动，监听端口 ${config.port}`);
  wss.on("connection", (ws, req) => {
    const ip = req.socket.remoteAddress;
    logger.info(`新的客户端连接: ${ip}`);
    let authenticated = false;
    let clientId = null;
    let clientName = "未知设备";
    ws.on("message", async (message) => {
      try {
        const data = message.toString();
        if (!authenticated) {
          if (!data.startsWith("auth:")) {
            logger.warn(`来自 ${ip} 的未认证消息: ${data}`);
            ws.close(1008, "请先认证");
            return;
          }
          const [_, token, name] = data.split(":");
          if (token !== config.authToken) {
            logger.warn(`来自 ${ip} 的无效令牌: ${token}`);
            ws.close(1008, "无效令牌");
            return;
          }
          clientId = (0, import_crypto.createHash)("sha256").update(`${ip}:${Date.now()}`).digest("hex").substring(0, 12);
          clientName = name || `客户端-${clientId.substring(0, 6)}`;
          if (clients.size >= config.maxClients) {
            logger.warn(`客户端数量已达上限 (${config.maxClients})`);
            ws.close(1008, "服务器客户端数量已达上限");
            return;
          }
          clients.set(clientId, {
            id: clientId,
            name: clientName,
            ws,
            lastSeen: /* @__PURE__ */ new Date(),
            lastCommand: null,
            lastResponse: null
          });
          authenticated = true;
          ws.send(`auth:success:${clientId}`);
          logger.info(`客户端认证成功: ${clientName} (${clientId})`);
          return;
        }
        const client = clients.get(clientId);
        if (client) {
          client.lastSeen = /* @__PURE__ */ new Date();
        }
        if (data.startsWith("image:")) {
          const [_, sessionId, imageData] = data.split(":", 3);
          logger.info(`收到来自 ${clientName} 的截图响应 (会话: ${sessionId})`);
          const sessionData = pendingSessions.get(sessionId);
          if (sessionData) {
            await sessionData.session.send(import_koishi.h.image(`data:image/jpeg;base64,${imageData}`));
            pendingSessions.delete(sessionId);
            if (client) {
              client.lastResponse = /* @__PURE__ */ new Date();
            }
          } else {
            logger.warn(`收到未识别的会话响应: ${sessionId}`);
          }
          return;
        }
        if (data.startsWith("error:")) {
          const [_, sessionId, errorMsg] = data.split(":", 3);
          logger.error(`来自 ${clientName} 的错误: ${errorMsg} (会话: ${sessionId})`);
          const sessionData = pendingSessions.get(sessionId);
          if (sessionData) {
            await sessionData.session.send(`截图失败: ${errorMsg}`);
            pendingSessions.delete(sessionId);
          }
          return;
        }
        logger.debug(`来自 ${clientName} 的消息: ${data}`);
      } catch (error) {
        logger.error(`处理消息时出错: ${error.message}`);
      }
    });
    ws.on("close", () => {
      if (clientId && clients.has(clientId)) {
        clients.delete(clientId);
        logger.info(`客户端断开连接: ${clientName} (${clientId})`);
      }
    });
    ws.on("error", (error) => {
      logger.error(`与 ${clientName} 的连接错误: ${error.message}`);
    });
  });
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, sessionData] of pendingSessions) {
      if (now - sessionData.timestamp > config.responseTimeout) {
        try {
          sessionData.session.send("截图请求超时，客户端未响应");
        } catch (error) {
          logger.warn(`发送超时消息失败: ${error.message}`);
        }
        pendingSessions.delete(sessionId);
        logger.warn(`会话超时: ${sessionId}`);
      }
    }
  }, 5e3);
  ctx.command(`${config.commandPrefix} [clientId]`, "请求客户端截图").option("list", "-l 列出所有可用客户端").action(async ({ session, options }, clientId) => {
    if (options.list) {
      if (clients.size === 0) {
        return "没有可用的客户端";
      }
      const clientList = Array.from(clients.values()).map((client2) => {
        const status = client2.lastResponse ? `最后响应: ${formatTime(client2.lastResponse)}` : client2.lastCommand ? `等待响应... (${formatTime(client2.lastCommand)})` : "空闲";
        return `${client2.name} (${client2.id}) - ${status}`;
      });
      return `可用客户端:
${clientList.join("\n")}`;
    }
    if (!clientId && clients.size > 0) {
      clientId = clients.keys().next().value;
    }
    if (!clientId || !clients.has(clientId)) {
      return "请指定有效的客户端ID，使用 -l 选项查看可用客户端";
    }
    const client = clients.get(clientId);
    if (client.ws.readyState !== import_ws2.WebSocket.OPEN) {
      return `客户端 ${client.name} 连接已断开，请重试或选择其他客户端`;
    }
    const sessionId = (0, import_crypto.createHash)("sha256").update(`${Date.now()}:${session.userId}`).digest("hex").substring(0, 8);
    try {
      client.ws.send(`capture:${sessionId}`);
      pendingSessions.set(sessionId, {
        session,
        // 存储原始会话对象
        timestamp: Date.now(),
        clientId,
        clientName: client.name
      });
      client.lastCommand = /* @__PURE__ */ new Date();
      client.lastResponse = null;
      logger.info(`发送截图请求到 ${client.name} (会话: ${sessionId})`);
      return `已向 ${client.name} 发送截图请求，请稍候...`;
    } catch (error) {
      logger.error(`发送截图请求失败: ${error.message}`);
      return `发送截图请求失败: ${error.message}`;
    }
  });
  ctx.command(`${config.commandPrefix}.admin`, "管理截图客户端").alias("截图管理").option("list", "-l 列出所有客户端").option("disconnect", "-d <clientId> 断开指定客户端").action(async ({ session, options }) => {
    if (options.list) {
      if (clients.size === 0) {
        return "没有已连接的客户端";
      }
      const clientList = Array.from(clients.values()).map((client) => {
        const status = client.lastResponse ? `最后响应: ${formatTime(client.lastResponse)}` : client.lastCommand ? `等待响应... (${formatTime(client.lastCommand)})` : "空闲";
        return `${client.name} (${client.id}) - 最后活动: ${formatTime(client.lastSeen)} - ${status}`;
      });
      return `已连接客户端:
${clientList.join("\n")}`;
    }
    if (options.disconnect) {
      const clientId = options.disconnect;
      if (!clients.has(clientId)) {
        return `未找到客户端: ${clientId}`;
      }
      const client = clients.get(clientId);
      try {
        client.ws.close(1e3, "管理员断开连接");
        clients.delete(clientId);
        logger.info(`管理员断开客户端: ${client.name} (${clientId})`);
        return `已断开客户端: ${client.name}`;
      } catch (error) {
        logger.error(`断开客户端失败: ${error.message}`);
        return `断开客户端失败: ${error.message}`;
      }
    }
    return "请指定操作选项 (使用 --help 查看帮助)";
  });
  function formatTime(date) {
    return date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }
  __name(formatTime, "formatTime");
  ctx.on("dispose", () => {
    wss.close();
    logger.info("截图服务已关闭");
  });
}
__name(apply, "apply");
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Config,
  apply
});

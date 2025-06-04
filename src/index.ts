import { Context, Schema, Logger, h } from 'koishi';
import { createHash } from 'crypto';
import { WebSocketServer } from 'ws';
import { WebSocket } from 'ws' ;


// 日志记录器
const logger = new Logger('screenshot-service');

// 客户端信息接口
interface ClientInfo {
  id: string;
  name: string;
  ws: WebSocket;
  lastSeen: Date;
  lastCommand: Date | null;
  lastResponse: Date | null;
}

// 插件配置
export interface Config {
  port: number;
  authToken: string;
  commandPrefix: string;
  maxClients: number;
  responseTimeout: number;
}

// 配置模式
export const Config: Schema<Config> = Schema.object({
  port: Schema.number().default(8765).description('WebSocket 服务器端口'),
  authToken: Schema.string().required().description('客户端认证令牌'),
  commandPrefix: Schema.string().default('截图').description('指令前缀'),
  maxClients: Schema.number().default(10).description('最大客户端数量'),
  responseTimeout: Schema.number().default(30000).description('响应超时时间(ms)'),
});

// 应用插件
export function apply(ctx: Context, config: Config) {
  // 存储客户端信息
  const clients = new Map<string, ClientInfo>();
  
  // 存储等待响应的会话
  const pendingSessions = new Map<string, any>();
  
  // 创建 WebSocket 服务器
  const wss = new WebSocketServer({ port: config.port });
  
  logger.info(`截图服务已启动，监听端口 ${config.port}`);
  
  // WebSocket 连接处理
  wss.on('connection', (ws, req) => {
    // 获取客户端 IP
    const ip = req.socket.remoteAddress;
    logger.info(`新的客户端连接: ${ip}`);
    
    // 客户端认证处理
    let authenticated = false;
    let clientId: string | null = null;
    let clientName = '未知设备';
    
    // 消息处理
    ws.on('message', async (message) => {
      try {
        const data = message.toString();
        
        // 处理认证消息
        if (!authenticated) {
          if (!data.startsWith('auth:')) {
            logger.warn(`来自 ${ip} 的未认证消息: ${data}`);
            ws.close(1008, '请先认证');
            return;
          }
          
          // 解析认证信息
          const [_, token, name] = data.split(':');
          if (token !== config.authToken) {
            logger.warn(`来自 ${ip} 的无效令牌: ${token}`);
            ws.close(1008, '无效令牌');
            return;
          }
          
          // 生成客户端 ID
          clientId = createHash('sha256').update(`${ip}:${Date.now()}`).digest('hex').substring(0, 12);
          clientName = name || `客户端-${clientId.substring(0, 6)}`;
          
          // 检查客户端数量
          if (clients.size >= config.maxClients) {
            logger.warn(`客户端数量已达上限 (${config.maxClients})`);
            ws.close(1008, '服务器客户端数量已达上限');
            return;
          }
          
          // 存储客户端信息
          clients.set(clientId, {
            id: clientId,
            name: clientName,
            ws,
            lastSeen: new Date(),
            lastCommand: null,
            lastResponse: null,
          });
          
          authenticated = true;
          ws.send(`auth:success:${clientId}`);
          logger.info(`客户端认证成功: ${clientName} (${clientId})`);
          return;
        }
        
        // 更新最后活动时间
        const client = clients.get(clientId);
        if (client) {
          client.lastSeen = new Date();
        }
        
        // 处理截图响应
        if (data.startsWith('image:')) {
          const [_, sessionId, imageData] = data.split(':', 3);
          logger.info(`收到来自 ${clientName} 的截图响应 (会话: ${sessionId})`);
          
          // 查找等待响应的会话
          const sessionData = pendingSessions.get(sessionId);
          if (sessionData) {
            // 使用 data: 协议发送图片消息
            await sessionData.session.send(h.image(`data:image/jpeg;base64,${imageData}`));
            pendingSessions.delete(sessionId);
            
            // 更新客户端状态
            if (client) {
              client.lastResponse = new Date();
            }
          } else {
            logger.warn(`收到未识别的会话响应: ${sessionId}`);
          }
          return;
        }
        
        // 处理错误响应
        if (data.startsWith('error:')) {
          const [_, sessionId, errorMsg] = data.split(':', 3);
          logger.error(`来自 ${clientName} 的错误: ${errorMsg} (会话: ${sessionId})`);
          
          // 查找等待响应的会话
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
    
    // 关闭连接处理
    ws.on('close', () => {
      if (clientId && clients.has(clientId)) {
        clients.delete(clientId);
        logger.info(`客户端断开连接: ${clientName} (${clientId})`);
      }
    });
    
    // 错误处理
    ws.on('error', (error) => {
      logger.error(`与 ${clientName} 的连接错误: ${error.message}`);
    });
  });
  
  // 定时清理超时会话
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, sessionData] of pendingSessions) {
      if (now - sessionData.timestamp > config.responseTimeout) {
        try {
          // 使用存储的 session 对象发送超时消息
          sessionData.session.send('截图请求超时，客户端未响应');
        } catch (error) {
          logger.warn(`发送超时消息失败: ${error.message}`);
        }
        pendingSessions.delete(sessionId);
        logger.warn(`会话超时: ${sessionId}`);
      }
    }
  }, 5000);
  
  // 注册指令：截图
  ctx.command(`${config.commandPrefix} [clientId]`, '请求客户端截图')
    .option('list', '-l 列出所有可用客户端')
    .action(async ({ session, options }, clientId) => {
      // 列出所有客户端
      if (options.list) {
        if (clients.size === 0) {
          return '没有可用的客户端';
        }
        
        const clientList = Array.from(clients.values()).map(client => {
          const status = client.lastResponse 
            ? `最后响应: ${formatTime(client.lastResponse)}`
            : client.lastCommand
              ? `等待响应... (${formatTime(client.lastCommand)})`
              : '空闲';
              
          return `${client.name} (${client.id}) - ${status}`;
        });
        
        return `可用客户端:\n${clientList.join('\n')}`;
      }
      
      // 如果没有提供 clientId，使用第一个客户端
      if (!clientId && clients.size > 0) {
        clientId = clients.keys().next().value;
      }
      
      // 检查客户端是否存在
      if (!clientId || !clients.has(clientId)) {
        return '请指定有效的客户端ID，使用 -l 选项查看可用客户端';
      }
      
      const client = clients.get(clientId);
      
      // 检查客户端连接状态
      if (client.ws.readyState !== WebSocket.OPEN) {
        return `客户端 ${client.name} 连接已断开，请重试或选择其他客户端`;
      }
      
      // 生成会话ID
      const sessionId = createHash('sha256').update(`${Date.now()}:${session.userId}`).digest('hex').substring(0, 8);
      
      try {
        // 发送截图请求
        client.ws.send(`capture:${sessionId}`);
        
        // 记录会话
        pendingSessions.set(sessionId, {
          session,  // 存储原始会话对象
          timestamp: Date.now(),
          clientId,
          clientName: client.name
        });
        
        // 更新客户端状态
        client.lastCommand = new Date();
        client.lastResponse = null;
        
        logger.info(`发送截图请求到 ${client.name} (会话: ${sessionId})`);
        
        return `已向 ${client.name} 发送截图请求，请稍候...`;
      } catch (error) {
        logger.error(`发送截图请求失败: ${error.message}`);
        return `发送截图请求失败: ${error.message}`;
      }
    });
  
  // 注册指令：客户端管理
  ctx.command(`${config.commandPrefix}.admin`, '管理截图客户端')
    .alias('截图管理')
    .option('list', '-l 列出所有客户端')
    .option('disconnect', '-d <clientId> 断开指定客户端')
    .action(async ({ session, options }) => {
      // 列出所有客户端
      if (options.list) {
        if (clients.size === 0) {
          return '没有已连接的客户端';
        }
        
        const clientList = Array.from(clients.values()).map(client => {
          const status = client.lastResponse 
            ? `最后响应: ${formatTime(client.lastResponse)}`
            : client.lastCommand
              ? `等待响应... (${formatTime(client.lastCommand)})`
              : '空闲';
              
          return `${client.name} (${client.id}) - 最后活动: ${formatTime(client.lastSeen)} - ${status}`;
        });
        
        return `已连接客户端:\n${clientList.join('\n')}`;
      }
      
      // 断开客户端
      if (options.disconnect) {
        const clientId = options.disconnect;
        if (!clients.has(clientId)) {
          return `未找到客户端: ${clientId}`;
        }
        
        const client = clients.get(clientId);
        try {
          client.ws.close(1000, '管理员断开连接');
          clients.delete(clientId);
          logger.info(`管理员断开客户端: ${client.name} (${clientId})`);
          return `已断开客户端: ${client.name}`;
        } catch (error) {
          logger.error(`断开客户端失败: ${error.message}`);
          return `断开客户端失败: ${error.message}`;
        }
      }
      
      return '请指定操作选项 (使用 --help 查看帮助)';
    });
  
  // 格式化时间
  function formatTime(date: Date): string {
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }
  
  // 插件卸载时关闭 WebSocket 服务器
  ctx.on('dispose', () => {
    wss.close();
    logger.info('截图服务已关闭');
  });
}
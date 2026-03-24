let TELEGRAM_TOKEN;

function buildCorsHeaders(request) {
    const requestHeaders = request.headers.get("Access-Control-Request-Headers");
    const origin = request.headers.get("Origin");
    return {
        "Access-Control-Allow-Origin": origin || "*",
        "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": requestHeaders || "*",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin, Access-Control-Request-Headers"
    };
}

function withCors(response, request) {
    const headers = new Headers(response.headers);
    const corsHeaders = buildCorsHeaders(request);
    for (const [key, value] of Object.entries(corsHeaders)) {
        headers.set(key, value);
    }
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}

export default {
    async fetch(request, env) {
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: buildCorsHeaders(request)
            });
        }

        const url = new URL(request.url);
        const userAgentHeader = request.headers.get('User-Agent');
        const userAgent = userAgentHeader ? userAgentHeader.toLowerCase() : "null";
        let newUrl;

        if (env.TGTOKEN) {
            TELEGRAM_TOKEN = env.TGTOKEN;
            // 处理 webhook
            if (url.pathname === `/telegram/${TELEGRAM_TOKEN}/webhook`) {
                try {
                    const update = await request.json();
                    const response = await handleUpdate(update);
                    return withCors(
                        new Response(response ? JSON.stringify(response) : "OK", { status: 200 }),
                        request
                    );
                } catch (e) {
                    return withCors(new Response(e.stack, { status: 200 }), request);
                }
            }

            if (userAgent.includes('mozilla') && !url.search) {
                if (url.pathname === `/${TELEGRAM_TOKEN}`) {
                    const domain = url.host;
                    const result = {};
                    const api = createTelegramBotAPI(TELEGRAM_TOKEN);
                    const hookUrl = `https://${domain}/telegram/${TELEGRAM_TOKEN}/webhook`;

                    result.webhook = await api.setWebhook({ url: hookUrl }).then(r => r.json());
                    result.commands = await api.setMyCommands({
                        commands: [
                            { command: "start", description: "启动机器人" },
                            { command: "id", description: "获取你的 Telegram ID" }
                        ]
                    }).then(r => r.json());

                    return withCors(
                        new Response(JSON.stringify(result, null, 2), {
                            headers: { "Content-Type": "application/json" }
                        }),
                        request
                    );
                } else {
                    try {
                        const botUsernameUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe`;
                        const botInfo = await fetch(botUsernameUrl).then(r => r.json());
                        if (botInfo.ok && botInfo.result.username) {
                            newUrl = `https://t.me/${botInfo.result.username}`;
                        } else {
                            throw new Error('Failed to get bot username');
                        }
                    } catch (e) {
                        console.error('Error getting bot info:', e);
                        newUrl = 'https://t.me'; // 如果获取失败则跳转到 Telegram 主页
                    }
                }
            } else {
                if (url.pathname.includes('/bot')) {
                    newUrl = 'https://api.telegram.org' + url.pathname + url.search;
                } else {
                    // 保持原始路径，只添加bot token前缀
                    newUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}${url.pathname}` + url.search;
                }
            }
        } else {
            newUrl = 'https://api.telegram.org' + url.pathname + url.search;
        }

        // 创建新的请求
        const newRequest = new Request(newUrl, {
            method: request.method,
            headers: request.headers,
            body: request.body
        });

        // 发送请求并返回响应
        return withCors(await fetch(newRequest), request);
    }
};

class MessageSender {
    api;
    context;

    constructor(token, context) {
        this.api = createTelegramBotAPI(token);
        this.context = context;
    }

    static fromMessage(token, message) {
        return new MessageSender(token, { chat_id: message.chat.id });
    }

    sendPlainText(text, parseMode = null) {
        return this.api.sendMessage({
            chat_id: this.context.chat_id,
            text: text,
            parse_mode: parseMode
        });
    }

    sendDocument(document, caption = null, parseMode = null) {
        return this.api.sendDocument({
            chat_id: this.context.chat_id,
            document: document,
            caption: caption,
            parse_mode: parseMode
        });
    }
}

class IdCommandHandler {
    command = "/id";

    escapeMarkdown(text) {
        // 在 MarkdownV2 中需要转义这些特殊字符
        return text.toString().replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    }

    formatUserInfo(user) {
        const lines = [];
        lines.push("*用户信息*");
        lines.push(`    ID： \`${this.escapeMarkdown(user.id)}\``);
        lines.push(`    姓： \`${this.escapeMarkdown(user.last_name || '未设置')}\``);
        lines.push(`    名： \`${this.escapeMarkdown(user.first_name || '未设置')}\``);
        lines.push(`    用户名： \`${this.escapeMarkdown(user.username ? '@' + user.username : '未设置')}\``);
        lines.push(`    语言代码： \`${this.escapeMarkdown(user.language_code || '未知')}\``);
        lines.push(`    会员： \`${this.escapeMarkdown(user.is_premium ? '已开通' : '未开通')}\``);

        // 用换行符连接所有行
        return lines.join('\n');
    }

    handle = async (message, context) => {
        const sender = MessageSender.fromMessage(context.SHARE_CONTEXT.TELEGRAM_TOKEN, message);
        return sender.sendPlainText(this.formatUserInfo(message.from), "MarkdownV2");
    };
}

class StartCommandHandler {
    command = "/start";

    handle = async (message, context) => {
        const sender = MessageSender.fromMessage(context.SHARE_CONTEXT.TELEGRAM_TOKEN, message);
        return sender.sendPlainText(`*通知机器人已启动！*\n    您的 Telegram ID 是：\`${message.from.id}\``, "MarkdownV2");
    };
}

const COMMANDS = [
    new StartCommandHandler(),
    new IdCommandHandler()
];

async function handleCommandMessage(message) {
    try {
        const text = message.text || "";
        console.log("Received command:", text); // 添加日志

        for (const cmd of COMMANDS) {
            if (text === cmd.command || text.startsWith(`${cmd.command} `)) {
                console.log("Executing command:", cmd.command); // 添加日志
                return await cmd.handle(message, {
                    SHARE_CONTEXT: {
                        TELEGRAM_TOKEN: TELEGRAM_TOKEN,
                        chatHistoryKey: `history:${message.chat.id}`
                    }
                });
            }
        }
        console.log("No matching command found"); // 添加日志
        return null;
    } catch (e) {
        console.error("Error handling command:", e); // 添加错误日志
        return new Response(`Error: ${e.message}`, { status: 200 });
    }
}

async function handleUpdate(update) {
    if (update.message) {
        return await handleCommandMessage(update.message);
    }
    return null;
}

function createTelegramBotAPI(token) {
    const baseURL = "https://api.telegram.org";
    return {
        sendMessage: (params) => {
            return fetch(`${baseURL}/bot${token}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(params)
            });
        },
        sendDocument: (params) => {
            return fetch(`${baseURL}/bot${token}/sendDocument`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(params)
            });
        },
        setWebhook: (params) => {
            return fetch(`${baseURL}/bot${token}/setWebhook`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(params)
            });
        },
        setMyCommands: (params) => {
            return fetch(`${baseURL}/bot${token}/setMyCommands`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(params)
            });
        }
    };
}

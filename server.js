// ==========================================================
//          HOTBOT API - VERSÃO FINAL E CORRIGIDA
// ==========================================================
const express = require('express');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors({
  origin: 'https://hottrackerbot.netlify.app',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

const sql = neon(process.env.DATABASE_URL);

// ==========================================================
//          LÓGICA DE RETRY PARA O BANCO DE DADOS
// ==========================================================
async function sqlWithRetry(query, params = [], retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            if (typeof query === 'string') { return await sql(query, params); }
            return await query;
        } catch (error) {
            const isRetryable = error.message.includes('fetch failed') || (error.sourceError && error.sourceError.code === 'UND_ERR_SOCKET');
            if (isRetryable && i < retries - 1) { await new Promise(res => setTimeout(res, delay)); } else { throw error; }
        }
    }
}

// --- MIDDLEWARE DE AUTENTICAÇÃO ---
async function authenticateJwt(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Token não fornecido.' });
    
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: 'Token inválido.' });
        req.user = user;
        next();
    });
}

// ==========================================================
//          MOTOR DE FLUXO E LÓGICAS DO TELEGRAM
// ==========================================================
function findNextNode(currentNodeId, handleId, edges) {
    const edge = edges.find(edge => edge.source === currentNodeId && (edge.sourceHandle === handleId || !edge.sourceHandle || handleId === null));
    return edge ? edge.target : null;
}

async function sendTelegramRequest(botToken, method, data, options = {}) {
    const { headers = {}, responseType = 'json' } = options;
    try {
        const apiUrl = `https://api.telegram.org/bot${botToken}/${method}`;
        const response = await axios.post(apiUrl, data, { headers, responseType });
        return response.data;
    } catch (error) {
        const errorData = error.response?.data;
        const errorMessage = (errorData instanceof ArrayBuffer) 
            ? JSON.parse(Buffer.from(errorData).toString('utf8'))
            : errorData;
        
        console.error(`[TELEGRAM API ERROR] Method: ${method}, ChatID: ${data.chat_id || (data.get && data.get('chat_id'))}:`, errorMessage || error.message);
        throw error;
    }
}

async function saveMessageToDb(sellerId, botId, message, senderType) {
    const { message_id, chat, from, text, photo, video, voice } = message;
    let mediaType = null;
    let mediaFileId = null;
    let messageText = text;
    let newClickId = null;

    if (text && text.startsWith('/start ')) {
        newClickId = text.substring(7);
    }

    let finalClickId = newClickId;
    if (!finalClickId) {
        const result = await sqlWithRetry(
            'SELECT click_id FROM telegram_chats WHERE chat_id = $1 AND bot_id = $2 AND click_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
            [chat.id, botId]
        );
        if (result.length > 0) {
            finalClickId = result[0].click_id;
        }
    }

    if (photo) {
        mediaType = 'photo';
        mediaFileId = photo[photo.length - 1].file_id;
        messageText = message.caption || '[Foto]';
    } else if (video) {
        mediaType = 'video';
        mediaFileId = video.file_id;
        messageText = message.caption || '[Vídeo]';
    } else if (voice) {
        mediaType = 'voice';
        mediaFileId = voice.file_id;
        messageText = '[Mensagem de Voz]';
    }
    const botInfo = senderType === 'bot' ? { first_name: 'Bot', last_name: '(Fluxo)' } : {};
    const fromUser = from || chat;

    await sqlWithRetry(`
        INSERT INTO telegram_chats (seller_id, bot_id, chat_id, message_id, user_id, first_name, last_name, username, message_text, sender_type, media_type, media_file_id, click_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (chat_id, message_id) DO NOTHING;
    `, [sellerId, botId, chat.id, message_id, fromUser.id, fromUser.first_name || botInfo.first_name, fromUser.last_name || botInfo.last_name, fromUser.username || null, messageText, senderType, mediaType, mediaFileId, finalClickId]);

    if (newClickId) {
        await sqlWithRetry(
            'UPDATE telegram_chats SET click_id = $1 WHERE chat_id = $2 AND bot_id = $3',
            [newClickId, chat.id, botId]
        );
    }
}


async function replaceVariables(text, variables) {
    if (!text) return '';
    let processedText = text;
    for (const key in variables) {
        const regex = new RegExp(`{{${key}}}`, 'g');
        processedText = processedText.replace(regex, variables[key]);
    }
    return processedText;
}

async function processFlow(chatId, botId, botToken, sellerId, startNodeId = null, initialVariables = {}, flowData = null) {
    let currentFlowData = flowData;
    let variables = { ...initialVariables };
    try {
        if (!currentFlowData) {
            const flowResult = await sqlWithRetry('SELECT nodes FROM flows WHERE bot_id = $1 ORDER BY updated_at DESC LIMIT 1', [botId]);
            currentFlowData = flowResult[0]?.nodes;
        }
        if (!currentFlowData) return;
    } catch (e) { return; }
    let { nodes = [], edges = [] } = currentFlowData;
    let currentNodeId = startNodeId;
    const userStateResult = await sqlWithRetry('SELECT * FROM user_flow_states WHERE chat_id = $1 AND bot_id = $2', [chatId, botId]);
    const userState = userStateResult[0];
    if (userState) {
        variables = { ...userState.variables, ...variables };
    }
    if (initialVariables.click_id) {
        variables.click_id = initialVariables.click_id;
    }
    if (!currentNodeId) {
        if (userState && userState.waiting_for_input) {
            currentNodeId = findNextNode(userState.current_node_id, 'a', edges);
        } else if (userState && !userState.waiting_for_input) {
            return;
        } else {
            const startNode = nodes.find(node => node.type === 'trigger');
            if (startNode) currentNodeId = findNextNode(startNode.id, null, edges);
        }
    }
    if (!currentNodeId) {
        if (userState) await sqlWithRetry('DELETE FROM user_flow_states WHERE chat_id = $1 AND bot_id = $2', [chatId, botId]);
        return;
    }
    let safetyLock = 0;
    while (currentNodeId && safetyLock < 20) {
        const currentNode = nodes.find(node => node.id === currentNodeId);
        if (!currentNode) break;
        await sqlWithRetry(`
            INSERT INTO user_flow_states (chat_id, bot_id, current_node_id, variables, waiting_for_input) VALUES ($1, $2, $3, $4, FALSE)
            ON CONFLICT (chat_id, bot_id) DO UPDATE SET current_node_id = EXCLUDED.current_node_id, variables = EXCLUDED.variables, waiting_for_input = FALSE;
        `, [chatId, botId, currentNodeId, JSON.stringify(variables)]);
        const nodeData = currentNode.data || {};
        switch (currentNode.type) {
            case 'message': {
                const textToSend = await replaceVariables(nodeData.text, variables);
                const response = await sendTelegramRequest(botToken, 'sendMessage', { chat_id: chatId, text: textToSend, parse_mode: 'HTML' });
                if (response.ok) {
                    await saveMessageToDb(sellerId, botId, response.result, 'bot');
                }
                if (nodeData.waitForReply) {
                    await sqlWithRetry('UPDATE user_flow_states SET waiting_for_input = TRUE WHERE chat_id = $1 AND bot_id = $2', [chatId, botId]);
                    const timeoutMinutes = nodeData.replyTimeout || 5;
                    const noReplyNodeId = findNextNode(currentNode.id, 'b', edges);
                    if (noReplyNodeId) {
                        await sqlWithRetry(`INSERT INTO flow_timeouts (chat_id, bot_id, execute_at, target_node_id, variables) VALUES ($1, $2, NOW() + INTERVAL '${timeoutMinutes} minutes', $3, $4)`, [chatId, botId, noReplyNodeId, JSON.stringify({ ...variables, flow_data: JSON.stringify(currentFlowData) })]);
                    }
                    currentNodeId = null;
                } else {
                    currentNodeId = findNextNode(currentNodeId, 'a', edges);
                }
                break;
            }
            case 'image': case 'video': case 'audio': {
                const typeMap = { image: 'sendPhoto', video: 'sendVideo', audio: 'sendVoice' };
                const urlMap = { image: 'imageUrl', video: 'videoUrl', audio: 'audioUrl' };
                const fieldMap = { image: 'photo', video: 'video', audio: 'voice' };
                const method = typeMap[currentNode.type];
                let fileIdentifier = nodeData[urlMap[currentNode.type]];
                const caption = await replaceVariables(nodeData.caption, variables);
                let response;
                if (fileIdentifier) {
                    const isLibraryFile = fileIdentifier.startsWith('BAAC') || fileIdentifier.startsWith('AgAC') || fileIdentifier.startsWith('AwAC');
                    if (isLibraryFile) {
                        try {
                            const storageBotToken = process.env.TELEGRAM_STORAGE_BOT_TOKEN;
                            if (!storageBotToken) throw new Error('Storage bot token não configurado.');
                            const fileInfoResponse = await sendTelegramRequest(storageBotToken, 'getFile', { file_id: fileIdentifier });
                            if (!fileInfoResponse.ok || !fileInfoResponse.result?.file_path) throw new Error('Não foi possível obter informações do arquivo.');
                            const fileUrl = `https://api.telegram.org/file/bot${storageBotToken}/${fileInfoResponse.result.file_path}`;
                            const fileBuffer = await axios.get(fileUrl, { responseType: 'arraybuffer' }).then(res => res.data);
                            const formData = new FormData();
                            formData.append('chat_id', chatId);
                            formData.append(fieldMap[currentNode.type], fileBuffer, { filename: 'mediafile' });
                            if (caption) formData.append('caption', caption);
                            response = await sendTelegramRequest(botToken, method, formData, { headers: formData.getHeaders() });
                        } catch (e) {
                            console.error("Erro ao processar arquivo da biblioteca:", e.message);
                        }
                    } else {
                        const payload = { chat_id: chatId, [fieldMap[currentNode.type]]: fileIdentifier };
                        if (caption) payload.caption = caption;
                        response = await sendTelegramRequest(botToken, method, payload);
                    }
                    if (response && response.ok) {
                        await saveMessageToDb(sellerId, botId, response.result, 'bot');
                    }
                }
                currentNodeId = findNextNode(currentNodeId, 'a', edges);
                break;
            }
            case 'delay': {
                const delaySeconds = nodeData.delayInSeconds || 1;
                const nextNodeId = findNextNode(currentNodeId, null, edges);
                if (nextNodeId) {
                    await sqlWithRetry(`INSERT INTO flow_timeouts (chat_id, bot_id, execute_at, target_node_id, variables) VALUES ($1, $2, NOW() + INTERVAL '${delaySeconds} seconds', $3, $4)`, [chatId, botId, nextNodeId, JSON.stringify({ ...variables, flow_data: JSON.stringify(currentFlowData) })]);
                }
                currentNodeId = null; 
                break;
            }
            case 'action_pix': {
                try {
                    const valueInCents = nodeData.valueInCents;
                    if (!valueInCents) throw new Error("Valor do PIX não definido.");
                    const click_id = variables.click_id;
                    if (!click_id) throw new Error("Click ID não encontrado para gerar PIX.");
                    const [seller] = await sqlWithRetry('SELECT hottrack_api_key FROM sellers WHERE id = $1', [sellerId]);
                    if (!seller || !seller.hottrack_api_key) throw new Error("Chave de API do HotTrack não configurada.");
                    const response = await axios.post('https://novaapi-one.vercel.app/api/pix/generate', { click_id, value_cents: valueInCents }, { headers: { 'x-api-key': seller.hottrack_api_key } });
                    variables.last_transaction_id = response.data.transaction_id;
                    await sqlWithRetry('UPDATE user_flow_states SET variables = $1 WHERE chat_id = $2 AND bot_id = $3', [JSON.stringify(variables), chatId, botId]);
                    
                    const pixMessageText = nodeData.pixMessageText || '✅ PIX Gerado! Copie o código abaixo para pagar:';
                    const textToSend = `<pre>${response.data.qr_code_text}</pre>\n\n${pixMessageText}`;
                    
                    const sentMessage = await sendTelegramRequest(botToken, 'sendMessage', {
                        chat_id: chatId,
                        text: textToSend,
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '📋 Copiar Código PIX', copy_text: { text: response.data.qr_code_text } }]
                            ]
                        }
                    });

                    if (sentMessage.ok) {
                        await saveMessageToDb(sellerId, botId, sentMessage.result, 'bot');
                    }
                } catch (error) {
                    const errorMessage = error.response?.data?.message || error.message || "Erro ao gerar PIX.";
                    const sentMessage = await sendTelegramRequest(botToken, 'sendMessage', { chat_id: chatId, text: errorMessage });
                    if (sentMessage.ok) {
                        await saveMessageToDb(sellerId, botId, sentMessage.result, 'bot');
                    }
                }
                currentNodeId = findNextNode(currentNodeId, 'a', edges);
                break;
            }
        }
        safetyLock++;
    }
}
app.get('/api/cron/process-timeouts', async (req, res) => {
    const cronSecret = process.env.CRON_SECRET;
    if (req.headers['authorization'] !== `Bearer ${cronSecret}`) return res.status(401).send('Unauthorized');
    try {
        const pendingTimeouts = await sqlWithRetry('SELECT * FROM flow_timeouts WHERE execute_at <= NOW()');
        if (pendingTimeouts.length > 0) {
            for (const timeout of pendingTimeouts) {
                await sqlWithRetry('DELETE FROM flow_timeouts WHERE id = $1', [timeout.id]);
                const userStateResult = await sqlWithRetry('SELECT waiting_for_input FROM user_flow_states WHERE chat_id = $1 AND bot_id = $2', [timeout.chat_id, timeout.bot_id]);
                const userState = userStateResult[0];
                const isReplyTimeout = userState && userState.waiting_for_input;
                const isScheduledDelay = userState && !userState.waiting_for_input;
                if (isReplyTimeout || isScheduledDelay) {
                    const botResult = await sqlWithRetry('SELECT seller_id, bot_token FROM telegram_bots WHERE id = $1', [timeout.bot_id]);
                    const bot = botResult[0];
                    if (bot) {
                        const initialVars = timeout.variables || {};
                        const flowData = initialVars.flow_data ? JSON.parse(initialVars.flow_data) : null;
                        if (initialVars.flow_data) delete initialVars.flow_data;
                        processFlow(timeout.chat_id, timeout.bot_id, bot.bot_token, bot.seller_id, timeout.target_node_id, initialVars, flowData);
                    }
                }
            }
        }
        res.status(200).send(`Processados ${pendingTimeouts.length} jobs.`);
    } catch (error) {
        res.status(500).send('Erro interno no servidor.');
    }
});
app.get('/api/health', async (req, res) => {
    try {
        await sqlWithRetry('SELECT 1 as status;');
        res.status(200).json({ status: 'ok' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Erro de conexão ao BD.' });
    }
});
app.post('/api/sellers/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password || password.length < 8) {
        return res.status(400).json({ message: 'Dados inválidos. Nome, email e senha (mínimo 8 caracteres) são obrigatórios.' });
    }
    try {
        const normalizedEmail = email.trim().toLowerCase();
        const existingSeller = await sqlWithRetry('SELECT id FROM sellers WHERE LOWER(email) = $1', [normalizedEmail]);
        if (existingSeller.length > 0) {
            return res.status(409).json({ message: 'Este email já está em uso.' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const apiKey = uuidv4();
        await sqlWithRetry('INSERT INTO sellers (name, email, password_hash, api_key, is_active) VALUES ($1, $2, $3, $4, TRUE)', [name, normalizedEmail, hashedPassword, apiKey]);
        res.status(201).json({ message: 'Vendedor cadastrado com sucesso!' });
    } catch (error) {
        console.error("Erro no registro:", error);
        res.status(500).json({ message: 'Erro interno do servidor.' });
    }
});
app.post('/api/sellers/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email e senha são obrigatórios.' });
    try {
        const normalizedEmail = email.trim().toLowerCase();
        const [seller] = await sqlWithRetry('SELECT * FROM sellers WHERE email = $1', [normalizedEmail]);
        if (!seller) return res.status(404).json({ message: 'Usuário não encontrado.' });
        if (!seller.is_active) return res.status(403).json({ message: 'Este usuário está bloqueado.' });
        const isPasswordCorrect = await bcrypt.compare(password, seller.password_hash);
        if (!isPasswordCorrect) return res.status(401).json({ message: 'Senha incorreta.' });
        const token = jwt.sign({ id: seller.id, email: seller.email }, process.env.JWT_SECRET, { expiresIn: '1d' });
        res.status(200).json({ token });
    } catch (error) { 
        res.status(500).json({ message: 'Erro interno do servidor.' }); 
    }
});
app.get('/api/dashboard/data', authenticateJwt, async (req, res) => {
    try {
        const botsPromise = sqlWithRetry('SELECT * FROM telegram_bots WHERE seller_id = $1 ORDER BY created_at DESC', [req.user.id]);
        const settingsPromise = sqlWithRetry('SELECT hottrack_api_key FROM sellers WHERE id = $1', [req.user.id]);
        const [bots, settingsResult] = await Promise.all([botsPromise, settingsPromise]);
        const settings = settingsResult[0] || {};
        res.json({ bots, settings });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao buscar dados.' });
    }
});
app.put('/api/settings/hottrack-key', authenticateJwt, async (req, res) => {
    const { apiKey } = req.body;
    if (typeof apiKey === 'undefined') return res.status(400).json({ message: 'O campo apiKey é obrigatório.' });
    try {
        await sqlWithRetry('UPDATE sellers SET hottrack_api_key = $1 WHERE id = $2', [apiKey, req.user.id]);
        res.status(200).json({ message: 'Chave de API do HotTrack salva com sucesso!' });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao salvar a chave.' });
    }
});
app.post('/api/bots', authenticateJwt, async (req, res) => {
    const { bot_name } = req.body;
    if (!bot_name) return res.status(400).json({ message: 'O nome do bot é obrigatório.' });
    try {
        const placeholderToken = `placeholder_${uuidv4()}`;
        const [newBot] = await sqlWithRetry(`
            INSERT INTO telegram_bots (seller_id, bot_name, bot_token) 
            VALUES ($1, $2, $3) RETURNING *;`, [req.user.id, bot_name, placeholderToken]);
        res.status(201).json(newBot);
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ message: 'Um bot com este nome de usuário já existe.' });
        res.status(500).json({ message: 'Erro ao salvar o bot.' });
    }
});
app.delete('/api/bots/:id', authenticateJwt, async (req, res) => {
    try {
        await sqlWithRetry('DELETE FROM telegram_bots WHERE id = $1 AND seller_id = $2', [req.params.id, req.user.id]);
        res.status(204).send();
    } catch (error) { res.status(500).json({ message: 'Erro ao excluir o bot.' }); }
});
app.put('/api/bots/:id', authenticateJwt, async (req, res) => {
    const { bot_token } = req.body;
    if (!bot_token) return res.status(400).json({ message: 'O token do bot é obrigatório.' });
    try {
        await sqlWithRetry('UPDATE telegram_bots SET bot_token = $1 WHERE id = $2 AND seller_id = $3', [bot_token.trim(), req.params.id, req.user.id]);
        res.status(200).json({ message: 'Token do bot atualizado.' });
    } catch (error) { res.status(500).json({ message: 'Erro ao atualizar o token.' }); }
});
app.post('/api/bots/:id/set-webhook', authenticateJwt, async (req, res) => {
    const { id } = req.params;
    try {
        const [bot] = await sqlWithRetry('SELECT bot_token FROM telegram_bots WHERE id = $1 AND seller_id = $2', [id, req.user.id]);
        if (!bot || !bot.bot_token) return res.status(400).json({ message: 'Token do bot não configurado.' });
        const webhookUrl = `https://hottrack.vercel.app/api/webhook/telegram/${id}`;
        await sendTelegramRequest(bot.bot_token, 'setWebhook', { url: webhookUrl });
        res.status(200).json({ message: 'Webhook configurado com sucesso!' });
    } catch (error) {
        res.status(500).json({ message: `Erro ao configurar webhook: ${error.message}` });
    }
});
app.get('/api/flows', authenticateJwt, async (req, res) => {
    try {
        const flows = await sqlWithRetry('SELECT * FROM flows WHERE seller_id = $1 ORDER BY created_at DESC', [req.user.id]);
        res.status(200).json(flows.map(f => ({ ...f, nodes: f.nodes || { nodes: [], edges: [] } })));
    } catch (error) { res.status(500).json({ message: 'Erro ao buscar os fluxos.' }); }
});
app.post('/api/flows', authenticateJwt, async (req, res) => {
    const { name, botId } = req.body;
    if (!name || !botId) return res.status(400).json({ message: 'Nome e ID do bot são obrigatórios.' });
    try {
        const initialFlow = { nodes: [{ id: 'start', type: 'trigger', position: { x: 250, y: 50 }, data: {} }], edges: [] };
        const [newFlow] = await sqlWithRetry(`
            INSERT INTO flows (seller_id, bot_id, name, nodes) VALUES ($1, $2, $3, $4) RETURNING *;`, [req.user.id, botId, name, JSON.stringify(initialFlow)]);
        res.status(201).json(newFlow);
    } catch (error) { res.status(500).json({ message: 'Erro ao criar o fluxo.' }); }
});
app.put('/api/flows/:id', authenticateJwt, async (req, res) => {
    const { name, nodes } = req.body;
    if (!name || !nodes) return res.status(400).json({ message: 'Nome e estrutura de nós são obrigatórios.' });
    try {
        const [updated] = await sqlWithRetry('UPDATE flows SET name = $1, nodes = $2, updated_at = NOW() WHERE id = $3 AND seller_id = $4 RETURNING *;', [name, nodes, req.params.id, req.user.id]);
        if (updated) res.status(200).json(updated);
        else res.status(404).json({ message: 'Fluxo não encontrado.' });
    } catch (error) { res.status(500).json({ message: 'Erro ao salvar o fluxo.' }); }
});
app.delete('/api/flows/:id', authenticateJwt, async (req, res) => {
    try {
        const result = await sqlWithRetry('DELETE FROM flows WHERE id = $1 AND seller_id = $2', [req.params.id, req.user.id]);
        if (result.count > 0) res.status(204).send();
        else res.status(404).json({ message: 'Fluxo não encontrado.' });
    } catch (error) { res.status(500).json({ message: 'Erro ao deletar o fluxo.' }); }
});
app.get('/api/chats/:botId', authenticateJwt, async (req, res) => {
    try {
        const users = await sqlWithRetry(`
            SELECT DISTINCT ON (chat_id) * FROM telegram_chats 
            WHERE bot_id = $1 AND seller_id = $2
            ORDER BY chat_id, created_at DESC;`, [req.params.botId, req.user.id]);
        res.status(200).json(users);
    } catch (error) { res.status(500).json({ message: 'Erro ao buscar usuários do chat.' }); }
});
app.get('/api/chats/:botId/:chatId', authenticateJwt, async (req, res) => {
    try {
        const messages = await sqlWithRetry(`
            SELECT * FROM telegram_chats WHERE bot_id = $1 AND chat_id = $2 AND seller_id = $3 ORDER BY created_at ASC;`, [req.params.botId, req.params.chatId, req.user.id]);
        res.status(200).json(messages);
    } catch (error) { res.status(500).json({ message: 'Erro ao buscar mensagens.' }); }
});
app.post('/api/chats/:botId/send-message', authenticateJwt, async (req, res) => {
    const { chatId, text } = req.body;
    if (!chatId || !text) return res.status(400).json({ message: 'Chat ID e texto são obrigatórios.' });
    try {
        const [bot] = await sqlWithRetry('SELECT bot_token FROM telegram_bots WHERE id = $1 AND seller_id = $2', [req.params.botId, req.user.id]);
        if (!bot) return res.status(404).json({ message: 'Bot não encontrado.' });
        const response = await sendTelegramRequest(bot.bot_token, 'sendMessage', { chat_id: chatId, text });
        if (response.ok) {
            await saveMessageToDb(req.user.id, req.params.botId, response.result, 'operator');
        }
        res.status(200).json({ message: 'Mensagem enviada!' });
    } catch (error) { res.status(500).json({ message: 'Não foi possível enviar a mensagem.' }); }
});
app.post('/api/chats/:botId/send-media', authenticateJwt, async (req, res) => {
    const { chatId, fileData, fileType, fileName } = req.body;
    if (!chatId || !fileData || !fileType || !fileName) {
        return res.status(400).json({ message: 'Dados incompletos.' });
    }
    try {
        const [bot] = await sqlWithRetry('SELECT bot_token FROM telegram_bots WHERE id = $1 AND seller_id = $2', [req.params.botId, req.user.id]);
        if (!bot) return res.status(404).json({ message: 'Bot não encontrado.' });
        const buffer = Buffer.from(fileData, 'base64');
        const formData = new FormData();
        formData.append('chat_id', chatId);
        let method, field;
        if (fileType.startsWith('image/')) {
            method = 'sendPhoto';
            field = 'photo';
        } else if (fileType.startsWith('video/')) {
            method = 'sendVideo';
            field = 'video';
        } else if (fileType.startsWith('audio/')) {
            method = 'sendVoice';
            field = 'voice';
        } else {
            return res.status(400).json({ message: 'Tipo de arquivo não suportado.' });
        }
        formData.append(field, buffer, { filename: fileName });
        const response = await sendTelegramRequest(bot.bot_token, method, formData, { headers: formData.getHeaders() });
        if (response.ok) {
            await saveMessageToDb(req.user.id, req.params.botId, response.result, 'operator');
        }
        res.status(200).json({ message: 'Mídia enviada!' });
    } catch (error) {
        res.status(500).json({ message: 'Não foi possível enviar a mídia.' });
    }
});
app.delete('/api/chats/:botId/:chatId', authenticateJwt, async (req, res) => {
    try {
        await sqlWithRetry('DELETE FROM telegram_chats WHERE bot_id = $1 AND chat_id = $2 AND seller_id = $3', [req.params.botId, req.params.chatId, req.user.id]);
        await sqlWithRetry('DELETE FROM user_flow_states WHERE bot_id = $1 AND chat_id = $2', [req.params.botId, req.params.chatId]);
        res.status(204).send();
    } catch (error) { res.status(500).json({ message: 'Erro ao deletar a conversa.' }); }
});
app.post('/api/chats/generate-pix', authenticateJwt, async (req, res) => {
    const { botId, chatId, click_id, valueInCents, pixMessage, pixButtonText } = req.body;
    try {
        if (!click_id) return res.status(400).json({ message: "Usuário não tem um Click ID para gerar PIX." });
        
        const [seller] = await sqlWithRetry('SELECT hottrack_api_key FROM sellers WHERE id = $1', [req.user.id]);
        if (!seller || !seller.hottrack_api_key) return res.status(400).json({ message: "Chave de API do HotTrack não configurada." });
        
        const pixResponse = await axios.post('https://novaapi-one.vercel.app/api/pix/generate', { click_id, value_cents: valueInCents }, { headers: { 'x-api-key': seller.hottrack_api_key } });
        const { transaction_id, qr_code_text } = pixResponse.data;

        await sqlWithRetry(`UPDATE telegram_chats SET last_transaction_id = $1 WHERE bot_id = $2 AND chat_id = $3`, [transaction_id, botId, chatId]);

        const [bot] = await sqlWithRetry('SELECT bot_token FROM telegram_bots WHERE id = $1', [botId]);
        
        const messageText = pixMessage || '✅ PIX Gerado! Copie o código abaixo para pagar:';
        const buttonText = pixButtonText || '📋 Copiar Código PIX';
        const textToSend = `<pre>${qr_code_text}</pre>\n\n${messageText}`;

        const sentMessage = await sendTelegramRequest(bot.bot_token, 'sendMessage', {
            chat_id: chatId,
            text: textToSend,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: buttonText, copy_text: { text: qr_code_text } }]
                ]
            }
        });

        if (sentMessage.ok) {
            await saveMessageToDb(req.user.id, botId, sentMessage.result, 'operator');
        }
        res.status(200).json({ message: 'PIX enviado ao usuário.' });
    } catch (error) {
        res.status(500).json({ message: error.response?.data?.message || 'Erro ao gerar PIX.' });
    }
});
app.get('/api/chats/check-pix/:botId/:chatId', authenticateJwt, async (req, res) => {
    try {
        const { botId, chatId } = req.params;
        const [chat] = await sqlWithRetry('SELECT last_transaction_id FROM telegram_chats WHERE bot_id = $1 AND chat_id = $2 AND last_transaction_id IS NOT NULL ORDER BY created_at DESC LIMIT 1', [botId, chatId]);
        if (!chat || !chat.last_transaction_id) return res.status(404).json({ message: 'Nenhuma transação PIX recente encontrada para este usuário.' });
        
        const [seller] = await sqlWithRetry('SELECT hottrack_api_key FROM sellers WHERE id = $1', [req.user.id]);
        if (!seller || !seller.hottrack_api_key) return res.status(400).json({ message: "Chave de API do HotTrack não configurada." });

        const checkResponse = await axios.get(`https://novaapi-one.vercel.app/api/pix/status/${chat.last_transaction_id}`, { headers: { 'x-api-key': seller.hottrack_api_key } });
        res.status(200).json(checkResponse.data);
    } catch (error) {
        res.status(500).json({ message: error.response?.data?.message || 'Erro ao consultar PIX.' });
    }
});
app.post('/api/chats/start-flow', authenticateJwt, async (req, res) => {
    const { botId, chatId, flowId } = req.body;
    try {
        const [bot] = await sqlWithRetry('SELECT seller_id, bot_token FROM telegram_bots WHERE id = $1', [botId]);
        if (!bot) return res.status(404).json({ message: 'Bot não encontrado' });
        
        const [flow] = await sqlWithRetry('SELECT nodes FROM flows WHERE id = $1 AND bot_id = $2', [flowId, botId]);
        if (!flow) return res.status(404).json({ message: 'Fluxo não encontrado' });
        
        const flowData = flow.nodes;
        const startNode = flowData.nodes.find(node => node.type === 'trigger');
        const firstNodeId = findNextNode(startNode.id, null, flowData.edges);
        
        processFlow(chatId, botId, bot.bot_token, bot.seller_id, firstNodeId, {}, flowData);

        res.status(200).json({ message: 'Fluxo iniciado para o usuário.' });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao iniciar fluxo.' });
    }
});
app.get('/api/media/preview/:bot_id/:file_id', async (req, res) => {
    try {
        const { bot_id, file_id } = req.params;
        let token;
        if (bot_id === 'storage') {
            token = process.env.TELEGRAM_STORAGE_BOT_TOKEN;
        } else {
            const [bot] = await sqlWithRetry('SELECT bot_token FROM telegram_bots WHERE id = $1', [bot_id]);
            token = bot?.bot_token;
        }
        if (!token) return res.status(404).send('Bot não encontrado.');
        const fileInfoResponse = await sendTelegramRequest(token, 'getFile', { file_id });
        if (!fileInfoResponse.ok || !fileInfoResponse.result?.file_path) {
            return res.status(404).send('Arquivo não encontrado no Telegram.');
        }
        const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfoResponse.result.file_path}`;
        const response = await axios.get(fileUrl, { responseType: 'stream' });
        res.setHeader('Content-Type', response.headers['content-type']);
        response.data.pipe(res);
    } catch (error) {
        console.error("Erro no preview:", error.message);
        res.status(500).send('Erro ao buscar o arquivo.');
    }
});
app.get('/api/media', authenticateJwt, async (req, res) => {
    try {
        const mediaFiles = await sqlWithRetry('SELECT id, file_name, file_id, file_type, thumbnail_file_id FROM media_library WHERE seller_id = $1 ORDER BY created_at DESC', [req.user.id]);
        res.status(200).json(mediaFiles);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao buscar a biblioteca de mídia.' });
    }
});
app.post('/api/media/upload', authenticateJwt, async (req, res) => {
    const { fileName, fileData, fileType } = req.body;
    if (!fileName || !fileData || !fileType) return res.status(400).json({ message: 'Dados do ficheiro incompletos.' });
    try {
        const storageBotToken = process.env.TELEGRAM_STORAGE_BOT_TOKEN;
        const storageChannelId = process.env.TELEGRAM_STORAGE_CHANNEL_ID;
        if (!storageBotToken || !storageChannelId) throw new Error('Credenciais do bot de armazenamento não configuradas.');
        const buffer = Buffer.from(fileData, 'base64');
        const formData = new FormData();
        formData.append('chat_id', storageChannelId);
        let telegramMethod = '', fieldName = '';
        if (fileType === 'image') {
            telegramMethod = 'sendPhoto';
            fieldName = 'photo';
        } else if (fileType === 'video') {
            telegramMethod = 'sendVideo';
            fieldName = 'video';
        } else if (fileType === 'audio') { // Mapeia 'audio' para 'sendVoice'
            telegramMethod = 'sendVoice';
            fieldName = 'voice';
        } else {
            return res.status(400).json({ message: 'Tipo de ficheiro não suportado.' });
        }
        formData.append(fieldName, buffer, { filename: fileName });
        const response = await sendTelegramRequest(storageBotToken, telegramMethod, formData, { headers: formData.getHeaders() });
        const result = response.result;
        let fileId, thumbnailFileId = null;
        if (fileType === 'image') {
            fileId = result.photo[result.photo.length - 1].file_id;
            thumbnailFileId = result.photo[0].file_id;
        } else if (fileType === 'video') {
            fileId = result.video.file_id;
            thumbnailFileId = result.video.thumbnail?.file_id || null;
        } else { // audio/voice
            fileId = result.voice.file_id;
        }
        if (!fileId) throw new Error('Não foi possível obter o file_id do Telegram.');
        const [newMedia] = await sqlWithRetry(`
            INSERT INTO media_library (seller_id, file_name, file_id, file_type, thumbnail_file_id)
            VALUES ($1, $2, $3, $4, $5) RETURNING id, file_name, file_id, file_type, thumbnail_file_id;
        `, [req.user.id, fileName, fileId, fileType, thumbnailFileId]);
        res.status(201).json(newMedia);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao processar o upload do ficheiro: ' + error.message });
    }
});
app.delete('/api/media/:id', authenticateJwt, async (req, res) => {
    try {
        const result = await sqlWithRetry('DELETE FROM media_library WHERE id = $1 AND seller_id = $2', [req.params.id, req.user.id]);
        if (result.count > 0) res.status(204).send();
        else res.status(404).json({ message: 'Mídia não encontrada.' });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao excluir a mídia.' });
    }
});
app.post('/api/webhook/telegram/:botId', async (req, res) => {
    const { botId } = req.params;
    const body = req.body;
    res.sendStatus(200);
    try {
        const [bot] = await sqlWithRetry('SELECT seller_id, bot_token FROM telegram_bots WHERE id = $1', [botId]);
        if (!bot) return;
        if (body.message) {
            const message = body.message;
            const chatId = message?.chat?.id;
            if (!chatId) return;
            await sqlWithRetry('DELETE FROM flow_timeouts WHERE chat_id = $1 AND bot_id = $2', [chatId, botId]);
            await saveMessageToDb(bot.seller_id, botId, message, 'user');
            if (message.text) {
                let initialVars = {};
                if (message.text.startsWith('/start ')) {
                    initialVars.click_id = message.text.substring(7);
                }
                await processFlow(chatId, botId, bot.bot_token, bot.seller_id, null, initialVars, null);
            }
        }
    } catch (error) {
        console.error("Erro no Webhook do Telegram:", error);
    }
});

// --- NOVAS ROTAS PARA IMPORTAÇÃO DE CONTATOS ---
const NOVA_API_URL = 'https://novaapi-one.vercel.app/api';

app.post('/api/novaapi/connect', authenticateJwt, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ message: 'Email e senha são obrigatórios.' });
    }

    try {
        const loginResponse = await axios.post(`${NOVA_API_URL}/sellers/login`, { email, password });
        const token = loginResponse.data.token;

        if (!token) {
            throw new Error('Token não recebido da Nova API.');
        }
        
        const dashboardResponse = await axios.get(`${NOVA_API_URL}/dashboard/data`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        res.status(200).json({
            message: 'Conectado com sucesso!',
            token: token,
            bots: dashboardResponse.data.bots || []
        });

    } catch (error) {
        console.error("Erro ao conectar com a Nova API:", error.response?.data || error.message);
        const status = error.response?.status || 500;
        const message = error.response?.data?.message || 'Falha ao conectar. Verifique suas credenciais.';
        res.status(status).json({ message });
    }
});

app.post('/api/novaapi/import', authenticateJwt, async (req, res) => {
    const { sourceBotId, destinationBotId, novaApiToken } = req.body;
    const sellerId = req.user.id;

    if (!sourceBotId || !destinationBotId || !novaApiToken) {
        return res.status(400).json({ message: 'Todos os campos são obrigatórios.' });
    }

    try {
        const { data: sourceContacts } = await axios.get(`${NOVA_API_URL}/chats/${sourceBotId}`, {
            headers: { 'Authorization': `Bearer ${novaApiToken}` }
        });

        if (!sourceContacts || sourceContacts.length === 0) {
            return res.status(404).json({ message: 'Nenhum contato encontrado no bot de origem da Nova API.' });
        }

        let importedCount = 0;
        for (const contact of sourceContacts) {
             const existingContact = await sqlWithRetry(`
                SELECT id FROM telegram_chats WHERE bot_id = $1 AND chat_id = $2 LIMIT 1
            `, [destinationBotId, contact.chat_id]);
            
            if (existingContact.length === 0) {
                const result = await sqlWithRetry(`
                    INSERT INTO telegram_chats 
                        (seller_id, bot_id, chat_id, message_id, user_id, first_name, last_name, username, click_id, message_text, sender_type)
                    VALUES 
                        ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Contato importado via Nova API', 'user')
                `, [
                    sellerId, destinationBotId, contact.chat_id, (contact.message_id || Date.now()), contact.user_id, 
                    contact.first_name, contact.last_name, contact.username, contact.click_id
                ]);
                
                if (result.count > 0) {
                    importedCount++;
                }
            }
        }
        
        res.status(200).json({ message: `Importação concluída! ${importedCount} novos contatos foram adicionados.` });

    } catch (error) {
        console.error("Erro durante a importação de contatos da Nova API:", error.response?.data || error.message);
        const status = error.response?.status || 500;
        const message = error.response?.data?.message || 'Falha ao importar contatos.';
        res.status(status).json({ message });
    }
});

// --- ROTA PARA CONTAR CONTATOS --
app.post('/api/bots/contacts-count', authenticateJwt, async (req, res) => {
    const { botIds } = req.body;
    const sellerId = req.user.id;

    if (!botIds || !Array.isArray(botIds) || botIds.length === 0) {
        return res.status(400).json({ message: 'Uma lista de IDs de bots é obrigatória.' });
    }

    try {
        const result = await sqlWithRetry(
            `SELECT COUNT(DISTINCT chat_id) FROM telegram_chats WHERE seller_id = $1 AND bot_id = ANY($2::int[])`,
            [sellerId, botIds]
        );
        res.status(200).json({ count: parseInt(result[0].count, 10) });
    } catch (error) {
        console.error("Erro ao contar contatos:", error);
        res.status(500).json({ message: 'Erro interno ao contar contatos.' });
    }
});


// --- NOVAS ROTAS PARA VALIDAÇÃO E DISPAROS ---
app.post('/api/bots/mass-send', authenticateJwt, async (req, res) => {
    const sellerId = req.user.id;
    const { botIds, flowSteps, campaignName } = req.body;

    if (!botIds || botIds.length === 0 || !flowSteps || flowSteps.length === 0 || !campaignName) {
        return res.status(400).json({ message: 'Nome da campanha, bots e um fluxo de disparo são obrigatórios.' });
    }

    try {
        const [history] = await sqlWithRetry(
            `INSERT INTO disparo_history (seller_id, campaign_name, bot_ids, flow_steps, status) VALUES ($1, $2, $3, $4, 'PENDING') RETURNING id`,
            [sellerId, campaignName, JSON.stringify(botIds), JSON.stringify(flowSteps)]
        );
        const historyId = history.id;

        res.status(202).json({ message: `Disparo "${campaignName}" agendado com sucesso! O processo ocorrerá em segundo plano.` });

        (async () => {
            let totalContacts = 0;
            const [seller] = await sqlWithRetry('SELECT hottrack_api_key FROM sellers WHERE id = $1', [sellerId]);
            const hottrackApiKey = seller?.hottrack_api_key;
            
            await sqlWithRetry(`UPDATE disparo_history SET status = 'RUNNING' WHERE id = $1`, [historyId]);

            for (const botId of botIds) {
                const [bot] = await sqlWithRetry('SELECT bot_token FROM telegram_bots WHERE id = $1 AND seller_id = $2', [botId, sellerId]);
                if (!bot || !bot.bot_token) continue;

                const contacts = await sqlWithRetry('SELECT DISTINCT ON (chat_id) chat_id, first_name, last_name, click_id FROM telegram_chats WHERE bot_id = $1', [botId]);
                totalContacts += contacts.length;

                for (const contact of contacts) {
                    let userVariables = {
                        primeiro_nome: contact.first_name || '',
                        nome_completo: `${contact.first_name || ''} ${contact.last_name || ''}`.trim(),
                        click_id: contact.click_id
                    };
                    let lastTransactionId = null;
                    let logStatus = 'SENT';

                    for (const step of flowSteps) {
                         try {
                            await new Promise(resolve => setTimeout(resolve, 500));
                            if (step.type === 'pix') {
                                if (!hottrackApiKey || !userVariables.click_id) continue;
                                const pixResponse = await axios.post('https://novaapi-one.vercel.app/api/pix/generate', { click_id: userVariables.click_id, value_cents: step.valueInCents }, { headers: { 'x-api-key': hottrackApiKey } });
                                lastTransactionId = pixResponse.data.transaction_id;
                            }
                         } catch (error) {
                             logStatus = 'FAILED';
                             break;
                         }
                    }
                    
                    await sqlWithRetry(
                        `INSERT INTO disparo_log (history_id, chat_id, bot_id, status, transaction_id) VALUES ($1, $2, $3, $4, $5)`,
                        [historyId, contact.chat_id, botId, logStatus, lastTransactionId]
                    );
                }
            }
             await sqlWithRetry(`UPDATE disparo_history SET status = 'COMPLETED', total_sent = $2 WHERE id = $1`, [historyId, totalContacts]);
        })();

    } catch (error) {
        console.error("Erro crítico no agendamento do disparo:", error);
        if (!res.headersSent) {
            res.status(500).json({ message: 'Erro interno ao agendar o disparo.' });
        }
    }
});

app.get('/api/disparos/history', authenticateJwt, async (req, res) => {
    try {
        const history = await sqlWithRetry(`
            SELECT 
                h.*,
                (SELECT COUNT(*) FROM disparo_log WHERE history_id = h.id AND status = 'CONVERTED') as conversions
            FROM 
                disparo_history h
            WHERE 
                h.seller_id = $1
            ORDER BY 
                h.created_at DESC;
        `, [req.user.id]);
        res.status(200).json(history);
    } catch (error) {
        res.status(500).json({ message: 'Erro ao buscar histórico de disparos.' });
    }
});

app.post('/api/disparos/check-conversions/:historyId', authenticateJwt, async (req, res) => {
    const { historyId } = req.params;
    const sellerId = req.user.id;

    try {
        const [seller] = await sqlWithRetry('SELECT hottrack_api_key FROM sellers WHERE id = $1', [sellerId]);
        if (!seller || !seller.hottrack_api_key) {
            return res.status(400).json({ message: "Chave de API do HotTrack não configurada." });
        }

        const logs = await sqlWithRetry(
            `SELECT id, transaction_id FROM disparo_log WHERE history_id = $1 AND status != 'CONVERTED' AND transaction_id IS NOT NULL`,
            [historyId]
        );
        
        let updatedCount = 0;
        for (const log of logs) {
            try {
                const checkResponse = await axios.get(`https://novaapi-one.vercel.app/api/pix/status/${log.transaction_id}`, { headers: { 'x-api-key': seller.hottrack_api_key } });
                if (checkResponse.data.status === 'PAID') {
                    await sqlWithRetry(`UPDATE disparo_log SET status = 'CONVERTED' WHERE id = $1`, [log.id]);
                    updatedCount++;
                }
            } catch(e) {
                // Ignora erros de PIX não encontrado, etc.
            }
            await new Promise(resolve => setTimeout(resolve, 200)); // Rate limiting
        }

        res.status(200).json({ message: `Verificação concluída. ${updatedCount} novas conversões encontradas.` });
    } catch (error) {
        res.status(500).json({ message: 'Erro ao verificar conversões.' });
    }
});


module.exports = app;

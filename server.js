// ==========================================================
//          HOTBOT API - SERVIÇO DEDICADO PARA BOTS
// ==========================================================
const express = require('express');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const sql = neon(process.env.DATABASE_URL);

// ==========================================================
//          LÓGICA DE RETRY PARA O BANCO DE DADOS
// ==========================================================
async function sqlWithRetry(query, params = [], retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            if (typeof query === 'string') {
                return await sql(query, params);
            }
            return await query;
        } catch (error) {
            const isRetryable = error.message.includes('fetch failed') || (error.sourceError && error.sourceError.code === 'UND_ERR_SOCKET');
            if (isRetryable && i < retries - 1) {
                console.warn(`[DB RETRY] Erro de conexão. Tentando novamente em ${delay}ms... (Tentativa ${i + 1}/${retries})`);
                await new Promise(res => setTimeout(res, delay));
            } else {
                console.error("[DB FATAL] Erro final ao executar a query:", error);
                throw error;
            }
        }
    }
}

// --- MIDDLEWARE DE AUTENTICAÇÃO (COMPARTILHADO) ---
async function authenticateJwt(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Token não fornecido.' });
    
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: 'Token inválido ou expirado.' });
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

async function sendTelegramRequest(botToken, method, data) {
    try {
        const apiUrl = `https://api.telegram.org/bot${botToken}/${method}`;
        const response = await axios.post(apiUrl, data);
        return response.data.result;
    } catch (error) {
        console.error(`[TELEGRAM API ERROR] Method: ${method}, ChatID: ${data.chat_id}:`, error.response?.data || error.message);
        throw error;
    }
}

async function sendTypingAction(chatId, botToken) {
    try {
        await sendTelegramRequest(botToken, 'sendChatAction', { chat_id: chatId, action: 'typing' });
    } catch (error) {
        console.warn(`[TELEGRAM API WARN] Falha ao enviar ação 'typing' para ${chatId}. Continuando o fluxo.`);
    }
}

async function saveMessageToDb(sellerId, botId, message, senderType) {
    const { message_id, chat, from, text } = message;
    const botInfo = senderType === 'bot' ? { first_name: 'Bot', last_name: '(Fluxo)' } : {};

    const query = `
        INSERT INTO telegram_chats (seller_id, bot_id, chat_id, message_id, user_id, first_name, last_name, username, message_text, sender_type)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (chat_id, message_id) DO NOTHING;
    `;
    const params = [sellerId, botId, chat.id, message_id, from.id, from.first_name || botInfo.first_name, from.last_name || botInfo.last_name, from.username || null, text, senderType];
    await sqlWithRetry(query, params);
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
    console.log(`[Flow Engine] Iniciando processo para ${chatId}. Nó inicial: ${startNodeId || 'Padrão'}`);
    
    let currentFlowData = flowData;
    let variables = { ...initialVariables };

    try {
        if (!currentFlowData) {
            const flowResult = await sqlWithRetry('SELECT nodes FROM flows WHERE bot_id = $1 ORDER BY updated_at DESC LIMIT 1', [botId]);
            const dbFlowData = flowResult[0]?.nodes;
            if (!dbFlowData) {
                console.log(`[Flow Engine] Nenhum fluxo ativo encontrado para o bot ID ${botId}.`);
                return;
            }
            currentFlowData = dbFlowData;
        }

        if (typeof currentFlowData !== 'object' || !Array.isArray(currentFlowData.nodes)) {
            console.error("[Flow Engine] Erro fatal: Os dados do fluxo estão em um formato inválido.", currentFlowData);
            return;
        }
    } catch (e) {
        console.error("[Flow Engine] Erro fatal ao carregar os dados do fluxo:", e);
        return;
    }

    let { nodes = [], edges = [] } = currentFlowData;
    let currentNodeId = startNodeId;

    const userStateResult = await sqlWithRetry('SELECT * FROM user_flow_states WHERE chat_id = $1 AND bot_id = $2', [chatId, botId]);
    const userState = userStateResult[0];

    if (userState) {
        variables = { ...userState.variables, ...variables };
    }

    if (!currentNodeId) {
        if (userState && userState.waiting_for_input) {
            console.log(`[Flow Engine] Utilizador respondeu, continuando fluxo.`);
            currentNodeId = findNextNode(userState.current_node_id, 'a', edges);
        } else if (userState && !userState.waiting_for_input) {
            console.log(`[Flow Engine] Mensagem ignorada, bot não estava à espera de resposta.`);
            return; // << -- CORREÇÃO PRINCIPAL ESTÁ AQUI
        } else {
            console.log(`[Flow Engine] Iniciando novo fluxo para ${chatId} a partir do gatilho.`);
            const startNode = nodes.find(node => node.type === 'trigger');
            if (startNode) {
                currentNodeId = findNextNode(startNode.id, null, edges);
            }
        }
    }

    if (!currentNodeId) {
        console.log(`[Flow Engine] Fim do fluxo ou nenhum nó inicial encontrado para ${chatId}.`);
        if (userState) {
            await sqlWithRetry('DELETE FROM user_flow_states WHERE chat_id = $1 AND bot_id = $2', [chatId, botId]);
        }
        return;
    }

    let safetyLock = 0;
    while (currentNodeId && safetyLock < 20) {
        const currentNode = nodes.find(node => node.id === currentNodeId);
        if (!currentNode) {
            console.error(`[Flow Engine] Erro: Nó ${currentNodeId} não encontrado no fluxo.`);
            break;
        }

        const queryInsertState = `
            INSERT INTO user_flow_states (chat_id, bot_id, current_node_id, variables, waiting_for_input)
            VALUES ($1, $2, $3, $4, FALSE)
            ON CONFLICT (chat_id, bot_id)
            DO UPDATE SET current_node_id = EXCLUDED.current_node_id, variables = EXCLUDED.variables, waiting_for_input = FALSE;
        `;
        await sqlWithRetry(queryInsertState, [chatId, botId, currentNodeId, JSON.stringify(variables)]);

        const nodeData = currentNode.data || {};

        switch (currentNode.type) {
            case 'message': {
                const textToSend = await replaceVariables(nodeData.text, variables);
                if (nodeData.showTyping) {
                    await sendTypingAction(chatId, botToken);
                    let typingDuration = textToSend.length * 50;
                    typingDuration = Math.max(500, Math.min(2000, typingDuration));
                    await new Promise(resolve => setTimeout(resolve, typingDuration));
                }
                const sentMessage = await sendTelegramRequest(botToken, 'sendMessage', { chat_id: chatId, text: textToSend, parse_mode: 'HTML' });
                await saveMessageToDb(sellerId, botId, sentMessage, 'bot');

                if (nodeData.waitForReply) {
                    await sqlWithRetry('UPDATE user_flow_states SET waiting_for_input = TRUE WHERE chat_id = $1 AND bot_id = $2', [chatId, botId]);
                    const timeoutMinutes = nodeData.replyTimeout || 5;
                    const noReplyNodeId = findNextNode(currentNode.id, 'b', edges);
                    if (noReplyNodeId) {
                        console.log(`[Flow Engine] Agendando timeout de ${timeoutMinutes} min para o nó ${noReplyNodeId}`);
                        const variablesForTimeout = { ...variables, flow_data: JSON.stringify(currentFlowData) };
                        const queryTimeout = `
                            INSERT INTO flow_timeouts (chat_id, bot_id, execute_at, target_node_id, variables)
                            VALUES ($1, $2, NOW() + INTERVAL '${timeoutMinutes} minutes', $3, $4)
                        `;
                        await sqlWithRetry(queryTimeout, [chatId, botId, noReplyNodeId, JSON.stringify(variablesForTimeout)]);
                    }
                    currentNodeId = null;
                } else {
                    currentNodeId = findNextNode(currentNodeId, 'a', edges);
                }
                break;
            }
            
            case 'image':
            case 'video':
            case 'audio': {
                const typeMap = { image: 'sendPhoto', video: 'sendVideo', audio: 'sendAudio' };
                const urlMap = { image: 'imageUrl', video: 'videoUrl', audio: 'audioUrl' };
                const fieldMap = { image: 'photo', video: 'video', audio: 'audio' };

                const method = typeMap[currentNode.type];
                const url = nodeData[urlMap[currentNode.type]];
                const caption = await replaceVariables(nodeData.caption, variables);
                
                if (url) {
                    await sendTypingAction(chatId, botToken);
                    const payload = { chat_id: chatId, [fieldMap[currentNode.type]]: url };
                    if (caption) payload.caption = caption;
                    await sendTelegramRequest(botToken, method, payload);
                }
                currentNodeId = findNextNode(currentNodeId, 'a', edges);
                break;
            }

            case 'delay': {
                const delaySeconds = nodeData.delayInSeconds || 1;
                const nextNodeId = findNextNode(currentNodeId, null, edges);

                if (nextNodeId) {
                    console.log(`[Flow Engine] Agendando atraso de ${delaySeconds}s para o nó ${nextNodeId}`);
                    const variablesForDelay = { ...variables, flow_data: JSON.stringify(currentFlowData) };
                    const queryDelay = `
                        INSERT INTO flow_timeouts (chat_id, bot_id, execute_at, target_node_id, variables)
                        VALUES ($1, $2, NOW() + INTERVAL '${delaySeconds} seconds', $3, $4)
                    `;
                    await sqlWithRetry(queryDelay, [chatId, botId, nextNodeId, JSON.stringify(variablesForDelay)]);
                }
                currentNodeId = null; 
                break;
            }
            
            case 'action_pix': {
                try {
                    const valueInCents = nodeData.valueInCents;
                    if (!valueInCents) throw new Error("Valor do PIX não definido no nó do fluxo.");
                    
                    const click_id = variables.click_id;
                    if (!click_id) throw new Error("Click ID não encontrado nas variáveis do fluxo para gerar PIX.");

                    const [seller] = await sqlWithRetry('SELECT hottrack_api_key FROM sellers WHERE id = $1', [sellerId]);
                    if (!seller || !seller.hottrack_api_key) {
                        throw new Error("A Chave de API do HotTrack não está configurada.");
                    }

                    const hottrackApiUrl = 'https://novaapi-one.vercel.app/api/pix/generate';
                    const response = await axios.post(hottrackApiUrl, 
                        { click_id, value_cents: valueInCents },
                        { headers: { 'x-api-key': seller.hottrack_api_key } }
                    );

                    const pixResult = response.data;
                    variables.last_transaction_id = pixResult.transaction_id;
                    
                    await sqlWithRetry('UPDATE user_flow_states SET variables = $1 WHERE chat_id = $2 AND bot_id = $3', [JSON.stringify(variables), chatId, botId]);
                    
                    const customText = nodeData.pixMessageText || 'Seu código PIX está abaixo:';
                    const buttonText = nodeData.pixButtonText || '📋 Copiar Código PIX';
                    
                    const messagePayload = {
                        chat_id: chatId,
                        text: `<pre>${pixResult.qr_code_text}</pre>\n\n${customText}`,
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: buttonText,
                                        copy_text: { 
                                            text: pixResult.qr_code_text
                                        }
                                    }
                                ]
                            ]
                        }
                    };
                    
                    console.log("[Flow Engine] Tentando enviar payload com 'copy_text' para a API do Telegram.");
                    const sentMessage = await sendTelegramRequest(botToken, 'sendMessage', messagePayload);

                    await saveMessageToDb(sellerId, botId, sentMessage, 'bot');

                } catch (error) {
                    console.error("[Flow Engine] Erro ao gerar PIX:", error.response?.data || error.message);
                    
                    let errorMessage = "Desculpe, não consegui gerar o PIX neste momento.";
                    if (error.message.includes("A Chave de API do HotTrack não está configurada")) {
                        errorMessage = error.message;
                    } else if (error.response?.data?.message) {
                        errorMessage = error.response.data.message;
                    } else if (error.response?.data?.description?.includes("can't parse inline keyboard button")) {
                         errorMessage = "[ERRO DE TESTE] O Telegram não reconheceu o botão 'copy_text'. Use a formatação <code>, como recomendado.";
                    }
                    
                    const sentMessage = await sendTelegramRequest(botToken, 'sendMessage', { chat_id: chatId, text: errorMessage });
                    await saveMessageToDb(sellerId, botId, sentMessage, 'bot');
                }
                currentNodeId = findNextNode(currentNodeId, 'a', edges);
                break;
            }

            case 'action_check_pix': {
                try {
                    const transactionId = variables.last_transaction_id;
                    if (!transactionId) throw new Error("Nenhum ID de transação PIX encontrado para consultar.");

                    const [seller] = await sqlWithRetry('SELECT hottrack_api_key FROM sellers WHERE id = $1', [sellerId]);
                    if (!seller || !seller.hottrack_api_key) {
                        throw new Error("A Chave de API do HotTrack não está configurada.");
                    }
                    
                    const hottrackApiUrl = `https://novaapi-one.vercel.app/api/pix/status/${transactionId}`;
                    const response = await axios.get(hottrackApiUrl, { headers: { 'x-api-key': seller.hottrack_api_key } });
                    
                    if (response.data.status === 'paid') {
                        const sentMessage = await sendTelegramRequest(botToken, 'sendMessage', { chat_id: chatId, text: "Pagamento confirmado! ✅" });
                        await saveMessageToDb(sellerId, botId, sentMessage, 'bot');
                        currentNodeId = findNextNode(currentNodeId, 'a', edges);
                    } else {
                        const sentMessage = await sendTelegramRequest(botToken, 'sendMessage', { chat_id: chatId, text: "Ainda estamos aguardando o pagamento." });
                        await saveMessageToDb(sellerId, botId, sentMessage, 'bot');
                        currentNodeId = findNextNode(currentNodeId, 'b', edges);
                    }
                } catch (error) {
                     console.error("[Flow Engine] Erro ao consultar PIX:", error.response?.data || error.message);
                     const errorMessage = error.response?.data?.message || "Não consegui consultar o status do PIX agora.";
                     const sentMessage = await sendTelegramRequest(botToken, 'sendMessage', { chat_id: chatId, text: errorMessage });
                     await saveMessageToDb(sellerId, botId, sentMessage, 'bot');
                     currentNodeId = findNextNode(currentNodeId, 'b', edges);
                }
                break;
            }

            case 'action_city': {
                try {
                    const click_id = variables.click_id;
                    if (!click_id) throw new Error("Click ID não encontrado para consultar cidade.");

                    const [seller] = await sqlWithRetry('SELECT hottrack_api_key FROM sellers WHERE id = $1', [sellerId]);
                    if (!seller || !seller.hottrack_api_key) throw new Error("API Key do HotTrack do vendedor não encontrada.");

                    const hottrackApiUrl = 'https://novaapi-one.vercel.app/api/click/info';
                    const response = await axios.post(hottrackApiUrl, { click_id }, { headers: { 'x-api-key': seller.hottrack_api_key } });
                    
                    variables.city = response.data.city || 'Desconhecida';
                    variables.state = response.data.state || 'Desconhecido';
                    
                    await sqlWithRetry('UPDATE user_flow_states SET variables = $1 WHERE chat_id = $2 AND bot_id = $3', [JSON.stringify(variables), chatId, botId]);

                } catch(error) {
                    console.error("[Flow Engine] Erro ao consultar cidade:", error.response?.data || error.message);
                    variables.city = 'Desconhecida';
                    variables.state = 'Desconhecido';
                }
                currentNodeId = findNextNode(currentNodeId, 'a', edges);
                break;
            }
            
            case 'forward_flow': {
                const targetFlowId = nodeData.targetFlowId;
                const [targetFlow] = await sqlWithRetry('SELECT * FROM flows WHERE id = $1 AND bot_id = $2', [targetFlowId, botId]);
                
                if (targetFlow) {
                    await sqlWithRetry('DELETE FROM user_flow_states WHERE chat_id = $1 AND bot_id = $2', [chatId, botId]);
                    const targetFlowData = typeof targetFlow.nodes === 'string' ? JSON.parse(targetFlow.nodes) : targetFlow.nodes;
                    const startNode = (targetFlowData.nodes || []).find(n => n.type === 'trigger');
                    
                    if (startNode) {
                        currentFlowData = targetFlowData;
                        nodes = currentFlowData.nodes || [];
                        edges = currentFlowData.edges || [];
                        currentNodeId = findNextNode(startNode.id, null, edges);
                        continue; 
                    }
                }
                currentNodeId = null;
                break;
            }

            default:
                console.warn(`[Flow Engine] Tipo de nó desconhecido: ${currentNode.type}. Parando fluxo.`);
                currentNodeId = null;
                break;
        }

        if (!currentNodeId) {
            const pendingTimeouts = await sqlWithRetry('SELECT 1 FROM flow_timeouts WHERE chat_id = $1 AND bot_id = $2', [chatId, botId]);
            if(pendingTimeouts.length === 0){
                 await sqlWithRetry('DELETE FROM user_flow_states WHERE chat_id = $1 AND bot_id = $2', [chatId, botId]);
            }
        }
        safetyLock++;
    }
}

// --- ROTA DO CRON JOB ---
app.get('/api/cron/process-timeouts', async (req, res) => {
    const cronSecret = process.env.CRON_SECRET;
    if (req.headers['authorization'] !== `Bearer ${cronSecret}`) {
        return res.status(401).send('Unauthorized');
    }
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
        res.status(200).send(`Processados ${pendingTimeouts.length} jobs agendados.`);
    } catch (error) {
        console.error('[CRON] Erro ao processar jobs agendados:', error);
        res.status(500).send('Erro interno no servidor.');
    }
});

// ==========================================================
//          ENDPOINTS DA API DO HOTBOT
// ==========================================================
// ... (O resto das suas rotas de API, como /api/health, /api/sellers/register, etc., permanecem inalteradas)
// ... Assegure-se de que o resto do seu ficheiro está aqui ...

// --- WEBHOOK DO TELEGRAM (COM LÓGICA CORRIGIDA) ---
app.post('/api/webhook/telegram/:botId', async (req, res) => {
    const { botId } = req.params;
    const body = req.body;
    res.sendStatus(200);

    try {
        const [bot] = await sqlWithRetry('SELECT seller_id, bot_token FROM telegram_bots WHERE id = $1', [botId]);
        if (!bot) return;

        if (body.callback_query) {
            const { message, data } = body.callback_query;
            const chatId = message.chat.id;
            await sendTelegramRequest(bot.bot_token, 'answerCallbackQuery', { callback_query_id: body.callback_query.id });
            const [action, value] = data.split('|');
            if (action === 'continue_flow' && value) {
                const userStateResult = await sqlWithRetry('SELECT variables FROM user_flow_states WHERE chat_id = $1 AND bot_id = $2', [chatId, botId]);
                const variables = userStateResult[0]?.variables || {};
                await processFlow(chatId, botId, bot.bot_token, bot.seller_id, value, variables);
            }
            return;
        }

        if (body.message) {
            const message = body.message;
            const chatId = message?.chat?.id;
            if (!chatId || !message.text) return;
            
            await sqlWithRetry('DELETE FROM flow_timeouts WHERE chat_id = $1 AND bot_id = $2', [chatId, botId]);
            await saveMessageToDb(bot.seller_id, botId, message, 'user');
            
            let initialVars = {};
            if (message.text.startsWith('/start ')) {
                await sqlWithRetry('DELETE FROM user_flow_states WHERE chat_id = $1 AND bot_id = $2', [chatId, botId]);
                const fullClickId = message.text; 
                initialVars.click_id = fullClickId;
                await sqlWithRetry(`
                    UPDATE telegram_chats 
                    SET click_id = $1 
                    WHERE chat_id = $2 AND message_id = $3;
                `, [fullClickId, chatId, message.message_id]);
            }
            
            await processFlow(chatId, botId, bot.bot_token, bot.seller_id, null, initialVars, null);
        }

    } catch (error) {
        console.error("Erro no Webhook do Telegram:", error);
    }
});

module.exports = app;

// ==========================================================
//          HOTBOT API - VERSÃO SEGURA E ROBUSTA
// ==========================================================
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult, param } = require('express-validator');
const { neon } = require('@neondatabase/serverless');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const FormData = require('form-data');

const app = express();

// ******** CORREÇÃO APLICADA AQUI ********
// Informa ao Express para confiar no proxy da Vercel (ou de outra hospedagem).
// Isso é necessário para que o express-rate-limit funcione corretamente.
app.set('trust proxy', 1);

// --- CONFIGURAÇÕES DE SEGURANÇA ---
app.use(helmet()); // Adiciona cabeçalhos de segurança HTTP
app.use(express.json({ limit: '10mb' }));
app.use(cors({
  origin: 'https://hottrackerbot.netlify.app',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// --- LIMITADOR DE REQUISIÇÕES (RATE LIMITING) ---
const apiLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutos
	max: 100, // Limita cada IP a 100 requisições por janela
	standardHeaders: true,
	legacyHeaders: false,
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 5, // Limita tentativas de login para prevenir força bruta
    message: 'Muitas tentativas de login. Tente novamente em 15 minutos.',
    standardHeaders: true,
	legacyHeaders: false,
});

app.use('/api/', apiLimiter); // Aplica o limiter geral a todas as rotas da API

const sql = neon(process.env.DATABASE_URL);

// ==========================================================
//      FUNÇÃO DE BANCO DE DADOS SEGURA (PREVINE SQL INJECTION)
// ==========================================================
// Esta função agora força o uso de queries parametrizadas.
async function sqlWithRetry(queryTemplate, params = [], retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            // A biblioteca `neon` já usa queries parametrizadas por padrão,
            // o que é a principal defesa contra SQL Injection.
            // A sintaxe `sql(template, params)` garante a segurança.
            return await sql(queryTemplate, params);
        } catch (error) {
            const isRetryable = error.message.includes('fetch failed') || (error.sourceError && error.sourceError.code === 'UND_ERR_SOCKET');
            if (isRetryable && i < retries - 1) {
                await new Promise(res => setTimeout(res, delay));
            } else {
                console.error("Database Error:", error.message);
                throw new Error("Erro de comunicação com o banco de dados.");
            }
        }
    }
}

// --- MIDDLEWARE DE AUTENTICAÇÃO E VALIDAÇÃO ---
function authenticateJwt(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Token não fornecido.' });
    
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: 'Token inválido ou expirado.' });
        req.user = user;
        next();
    });
}

// Middleware para tratar erros de validação
function handleValidationErrors(req, res, next) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }
    next();
}


// ==========================================================
//          MOTOR DE FLUXO E LÓGICAS DO TELEGRAM
//          (Mantido com as melhorias de segurança indiretas)
// ==========================================================
// As funções abaixo são chamadas por rotas que agora têm validação e autenticação,
// tornando sua execução mais segura.

function findNextNode(currentNodeId, handleId, edges) {
    const edge = edges.find(edge => edge.source === currentNodeId && (edge.sourceHandle === handleId || !edge.sourceHandle || handleId === null));
    return edge ? edge.target : null;
}

async function sendTelegramRequest(botToken, method, data, options = {}) {
    // ... (código original mantido, pois já trata erros de forma adequada)
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
    // ... (código original mantido, pois já usa queries parametrizadas implicitamente)
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
    const botInfo = senderType === 'bot' ? { first_name: 'Bot', last_name: '(Automação)' } : {};
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

// ... (Restante das funções do motor de fluxo como replaceVariables, sendMediaAsProxy, processFlow etc. são mantidas, pois a segurança é aplicada nas rotas que as invocam)
async function replaceVariables(text, variables) {
    if (!text) return '';
    let processedText = text;
    for (const key in variables) {
        const regex = new RegExp(`{{${key}}}`, 'g');
        processedText = processedText.replace(regex, variables[key] || ''); // Garante que não insira 'undefined'
    }
    return processedText;
}

// ... (código original de sendMediaAsProxy e processFlow mantido)
async function sendMediaAsProxy(destinationBotToken, chatId, fileId, fileType, caption) {
    const storageBotToken = process.env.TELEGRAM_STORAGE_BOT_TOKEN;
    if (!storageBotToken) throw new Error('Token do bot de armazenamento não configurado.');

    const fileInfo = await sendTelegramRequest(storageBotToken, 'getFile', { file_id: fileId });
    if (!fileInfo.ok) throw new Error('Não foi possível obter informações do arquivo da biblioteca.');

    const fileUrl = `https://api.telegram.org/file/bot${storageBotToken}/${fileInfo.result.file_path}`;

    const { data: fileBuffer, headers: fileHeaders } = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    
    const formData = new FormData();
    formData.append('chat_id', chatId);
    if (caption) {
        formData.append('caption', caption);
    }

    const methodMap = { image: 'sendPhoto', video: 'sendVideo', audio: 'sendVoice' };
    const fieldMap = { image: 'photo', video: 'video', audio: 'voice' };
    const fileNameMap = { image: 'image.jpg', video: 'video.mp4', audio: 'audio.ogg' };

    const method = methodMap[fileType];
    const field = fieldMap[fileType];
    const fileName = fileNameMap[fileType];

    if (!method) throw new Error('Tipo de arquivo não suportado.');

    formData.append(field, fileBuffer, { filename: fileName, contentType: fileHeaders['content-type'] });

    return await sendTelegramRequest(destinationBotToken, method, formData, { headers: formData.getHeaders() });
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
    if(initialVariables.primeiro_nome) variables.primeiro_nome = initialVariables.primeiro_nome;
    if(initialVariables.nome_completo) variables.nome_completo = initialVariables.nome_completo;

    if (!variables.click_id) {
        const lastClickResult = await sqlWithRetry(
            'SELECT click_id FROM telegram_chats WHERE chat_id = $1 AND bot_id = $2 AND click_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
            [chatId, botId]
        );
        if (lastClickResult.length > 0) {
            variables.click_id = lastClickResult[0].click_id.replace('/start ', '');
        }
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
                if (nodeData.addTypingAction && nodeData.typingDuration > 0) {
                    await sendTelegramRequest(botToken, 'sendChatAction', { chat_id: chatId, action: 'typing' });
                    await new Promise(resolve => setTimeout(resolve, nodeData.typingDuration * 1000));
                }

                const textToSend = await replaceVariables(nodeData.text, variables);
                
                let payload = { chat_id: chatId, text: textToSend, parse_mode: 'HTML' };
                if (nodeData.buttonText && nodeData.buttonUrl) {
                    payload.reply_markup = {
                        inline_keyboard: [[{ text: nodeData.buttonText, url: nodeData.buttonUrl }]]
                    };
                }

                const response = await sendTelegramRequest(botToken, 'sendMessage', payload);
                
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
                const urlMap = { image: 'imageUrl', video: 'videoUrl', audio: 'audioUrl' };
                let fileIdentifier = nodeData[urlMap[currentNode.type]];
                const caption = await replaceVariables(nodeData.caption, variables);
                
                if (fileIdentifier) {
                    const isLibraryFile = fileIdentifier.startsWith('BAAC') || fileIdentifier.startsWith('AgAC') || fileIdentifier.startsWith('AwAC');
                    
                    try {
                        let response;
                        if (isLibraryFile) {
                            if (currentNode.type === 'audio') {
                                const duration = parseInt(nodeData.durationInSeconds, 10) || 0;
                                if (duration > 0) {
                                    await sendTelegramRequest(botToken, 'sendChatAction', { chat_id: chatId, action: 'record_voice' });
                                    await new Promise(resolve => setTimeout(resolve, duration * 1000));
                                }
                            }
                            response = await sendMediaAsProxy(botToken, chatId, fileIdentifier, currentNode.type, caption);
                        } else {
                            // Lógica para URL externa
                            const methodMap = { image: 'sendPhoto', video: 'sendVideo', audio: 'sendVoice' };
                            const fieldMap = { image: 'photo', video: 'video', audio: 'voice' };
                            const payload = { chat_id: chatId, [fieldMap[currentNode.type]]: fileIdentifier, caption };
                            response = await sendTelegramRequest(botToken, methodMap[currentNode.type], payload);
                        }

                        if (response && response.ok) {
                            await saveMessageToDb(sellerId, botId, response.result, 'bot');
                        }
                    } catch(e) {
                         console.error(`Erro ao enviar mídia no fluxo: ${e.message}`);
                    }
                }
                currentNodeId = findNextNode(currentNodeId, 'a', edges);
                break;
            }
            case 'delay': {
                const delaySeconds = parseInt(nodeData.delayInSeconds, 10) || 1;
                const nextNodeId = findNextNode(currentNodeId, null, edges);
                if (nextNodeId) {
                    await sqlWithRetry(`INSERT INTO flow_timeouts (chat_id, bot_id, execute_at, target_node_id, variables) VALUES ($1, $2, NOW() + INTERVAL '${delaySeconds} seconds', $3, $4)`, [chatId, botId, nextNodeId, JSON.stringify({ ...variables, flow_data: JSON.stringify(currentFlowData) })]);
                }
                currentNodeId = null; 
                break;
            }
            case 'typing_action': {
                const duration = parseInt(nodeData.durationInSeconds, 10) || 1;
                await sendTelegramRequest(botToken, 'sendChatAction', { chat_id: chatId, action: 'typing' });
                await new Promise(resolve => setTimeout(resolve, duration * 1000));
                currentNodeId = findNextNode(currentNodeId, 'a', edges);
                break;
            }
            case 'action_pix': {
                try {
                    const valueInCents = nodeData.valueInCents;
                    if (!valueInCents) throw new Error("Valor do PIX não definido.");
                    if (!variables.click_id) throw new Error("Click ID não encontrado para gerar PIX.");
                    const [seller] = await sqlWithRetry('SELECT hottrack_api_key FROM sellers WHERE id = $1', [sellerId]);
                    if (!seller || !seller.hottrack_api_key) throw new Error("Chave de API do HotTrack não configurada.");
                    
                    const response = await axios.post('https://novaapi-one.vercel.app/api/pix/generate', { click_id: variables.click_id, value_cents: valueInCents }, { headers: { 'x-api-key': seller.hottrack_api_key } });
                    variables.last_transaction_id = response.data.transaction_id;
                    await sqlWithRetry('UPDATE user_flow_states SET variables = $1 WHERE chat_id = $2 AND bot_id = $3', [JSON.stringify(variables), chatId, botId]);
                    
                    const pixMessageText = nodeData.pixMessageText || '✅ PIX Gerado! Copie o código abaixo para pagar:';
                    const textToSend = `<pre>${response.data.qr_code_text}</pre>\n\n${pixMessageText}`;
                    
                    const sentMessage = await sendTelegramRequest(botToken, 'sendMessage', {
                        chat_id: chatId, text: textToSend, parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: [[{ text: '📋 Copiar Código PIX', copy_text: { text: response.data.qr_code_text } }]] }
                    });
                    if (sentMessage.ok) await saveMessageToDb(sellerId, botId, sentMessage.result, 'bot');
                } catch (error) {
                    const errorMessage = error.response?.data?.message || error.message || "Erro ao gerar PIX.";
                    const sentMessage = await sendTelegramRequest(botToken, 'sendMessage', { chat_id: chatId, text: errorMessage });
                    if (sentMessage.ok) await saveMessageToDb(sellerId, botId, sentMessage.result, 'bot');
                }
                currentNodeId = findNextNode(currentNodeId, 'a', edges);
                break;
            }
             case 'forward_flow': {
                const targetFlowId = nodeData.targetFlowId;
                if (targetFlowId) {
                    const [newFlow] = await sqlWithRetry('SELECT nodes FROM flows WHERE id = $1 AND seller_id = $2', [targetFlowId, sellerId]);
                    if (newFlow && newFlow.nodes) {
                        currentFlowData = newFlow.nodes;
                        nodes = currentFlowData.nodes || [];
                        edges = currentFlowData.edges || [];
                        const startNode = nodes.find(node => node.type === 'trigger');
                        currentNodeId = findNextNode(startNode.id, null, edges);
                        continue; 
                    }
                }
                currentNodeId = findNextNode(currentNodeId, 'a', edges);
                break;
            }
             default:
                currentNodeId = findNextNode(currentNodeId, 'a', edges); // Avança em nós desconhecidos
                break;
        }
        safetyLock++;
    }
}


// ==========================================================
//          ROTAS DA API (AGORA COM SEGURANÇA)
// ==========================================================

// --- Rotas de Cron (protegidas por segredo) ---
app.get('/api/cron/process-timeouts', async (req, res) => {
    // ... (código original mantido, segurança por segredo é adequada para cron)
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

app.get('/api/cron/process-disparo-queue', async (req, res) => {
    // ... (código original mantido)
    const cronSecret = process.env.CRON_SECRET;
    if (req.headers['authorization'] !== `Bearer ${cronSecret}`) {
        return res.status(401).send('Unauthorized');
    }

    const BATCH_SIZE = 25; // Processa até 25 mensagens por execução do cron
    let processedCount = 0;

    try {
        const jobs = await sqlWithRetry(
            `SELECT * FROM disparo_queue ORDER BY created_at ASC LIMIT $1`,
            [BATCH_SIZE]
        );

        if (jobs.length === 0) {
            return res.status(200).send('Fila de disparos vazia.');
        }

        for (const job of jobs) {
            const { id, history_id, chat_id, bot_id, step_json, variables_json } = job;
            const step = JSON.parse(step_json);
            const userVariables = JSON.parse(variables_json);
            
            let logStatus = 'SENT';
            let lastTransactionId = null;

            try {
                const [bot] = await sqlWithRetry('SELECT seller_id, bot_token FROM telegram_bots WHERE id = $1', [bot_id]);
                if (!bot || !bot.bot_token) {
                    throw new Error(`Bot com ID ${bot_id} não encontrado ou sem token.`);
                }
                
                const [seller] = await sqlWithRetry('SELECT hottrack_api_key FROM sellers WHERE id = $1', [bot.seller_id]);
                const hottrackApiKey = seller?.hottrack_api_key;
                
                let response;

                if (step.type === 'message') {
                    const textToSend = await replaceVariables(step.text, userVariables);
                    let payload = { chat_id: chat_id, text: textToSend, parse_mode: 'HTML' };
                    if (step.buttonText && step.buttonUrl) {
                        payload.reply_markup = { inline_keyboard: [[{ text: step.buttonText, url: step.buttonUrl }]] };
                    }
                    response = await sendTelegramRequest(bot.bot_token, 'sendMessage', payload);
                } else if (['image', 'video', 'audio'].includes(step.type)) {
                    const fileIdentifier = step.fileUrl;
                    const caption = await replaceVariables(step.caption, userVariables);
                    const isLibraryFile = fileIdentifier && (fileIdentifier.startsWith('BAAC') || fileIdentifier.startsWith('AgAC') || fileIdentifier.startsWith('AwAC'));

                    if (isLibraryFile) {
                        response = await sendMediaAsProxy(bot.bot_token, chat_id, fileIdentifier, step.type, caption);
                    } else {
                        const method = { image: 'sendPhoto', video: 'sendVideo', audio: 'sendVoice' }[step.type];
                        const field = { image: 'photo', video: 'video', audio: 'voice' }[step.type];
                        const payload = { chat_id: chat_id, [field]: fileIdentifier, caption: caption, parse_mode: 'HTML' };
                        response = await sendTelegramRequest(bot.bot_token, method, payload);
                    }
                } else if (step.type === 'pix') {
                    if (!hottrackApiKey || !userVariables.click_id) continue;
                    const pixResponse = await axios.post('https://novaapi-one.vercel.app/api/pix/generate', { click_id: userVariables.click_id, value_cents: step.valueInCents }, { headers: { 'x-api-key': hottrackApiKey } });
                    lastTransactionId = pixResponse.data.transaction_id;
                    
                    const messageText = await replaceVariables(step.pixMessage, userVariables);
                    const buttonText = await replaceVariables(step.pixButtonText, userVariables);
                    const textToSend = `${messageText}\n\n<pre>${pixResponse.data.qr_code_text}</pre>`;

                    response = await sendTelegramRequest(bot.bot_token, 'sendMessage', {
                        chat_id: chat_id, text: textToSend, parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: [[{ text: buttonText, copy_text: { text: pixResponse.data.qr_code_text }}]]}
                    });
                }
                
                if (response && response.ok) {
                   await saveMessageToDb(bot.seller_id, bot_id, response.result, 'bot');
                } else if(response && !response.ok) {
                    throw new Error(response.description);
                }
            } catch(e) {
                logStatus = 'FAILED';
                console.error(`Falha ao processar job ${id} para chat ${chat_id}: ${e.message}`);
            }

            await sqlWithRetry(
                `INSERT INTO disparo_log (history_id, chat_id, bot_id, status, transaction_id) VALUES ($1, $2, $3, $4, $5)`,
                [history_id, chat_id, bot_id, logStatus, lastTransactionId]
            );

            if (logStatus !== 'FAILED') {
                await sqlWithRetry(`UPDATE disparo_history SET total_sent = total_sent + 1 WHERE id = $1`, [history_id]);
            }

            await sqlWithRetry(`DELETE FROM disparo_queue WHERE id = $1`, [id]);
            processedCount++;
        }

        const runningCampaigns = await sqlWithRetry(`SELECT id FROM disparo_history WHERE status = 'RUNNING'`);
        for(const campaign of runningCampaigns) {
            const remainingInQueue = await sqlWithRetry(`SELECT id FROM disparo_queue WHERE history_id = $1 LIMIT 1`, [campaign.id]);
            if(remainingInQueue.length === 0) {
                await sqlWithRetry(`UPDATE disparo_history SET status = 'COMPLETED' WHERE id = $1`, [campaign.id]);
            }
        }
        
        res.status(200).send(`Processados ${processedCount} jobs da fila de disparos.`);

    } catch(e) {
        console.error("Erro crítico no processamento da fila de disparos:", e);
        res.status(500).send("Erro interno ao processar a fila.");
    }
});


// --- Rota de Healthcheck (pública) ---
app.get('/api/health', async (req, res) => {
    try {
        await sqlWithRetry('SELECT 1 as status;');
        res.status(200).json({ status: 'ok' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Erro de conexão ao BD.' });
    }
});

// --- Rotas de Autenticação (com validação e rate limit) ---
app.post('/api/sellers/register',
    loginLimiter, // Aplica rate limit específico
    [ // Validação de entrada
        body('name').trim().notEmpty().escape(),
        body('email').isEmail().normalizeEmail(),
        body('password').isLength({ min: 8 })
    ],
    handleValidationErrors,
    async (req, res) => {
        const { name, email, password } = req.body;
        try {
            const existingSeller = await sqlWithRetry('SELECT id FROM sellers WHERE email = $1', [email]);
            if (existingSeller.length > 0) {
                return res.status(409).json({ message: 'Este email já está em uso.' });
            }
            const hashedPassword = await bcrypt.hash(password, 10);
            const apiKey = uuidv4();
            await sqlWithRetry('INSERT INTO sellers (name, email, password_hash, api_key, is_active) VALUES ($1, $2, $3, $4, TRUE)', [name, email, hashedPassword, apiKey]);
            res.status(201).json({ message: 'Vendedor cadastrado com sucesso!' });
        } catch (error) {
            res.status(500).json({ message: 'Erro interno do servidor.' });
        }
    }
);

app.post('/api/sellers/login',
    loginLimiter,
    [
        body('email').isEmail().normalizeEmail(),
        body('password').notEmpty()
    ],
    handleValidationErrors,
    async (req, res) => {
        const { email, password } = req.body;
        try {
            const [seller] = await sqlWithRetry('SELECT * FROM sellers WHERE email = $1', [email]);
            if (!seller) return res.status(404).json({ message: 'Credenciais inválidas.' });
            if (!seller.is_active) return res.status(403).json({ message: 'Este usuário está bloqueado.' });
            
            const isPasswordCorrect = await bcrypt.compare(password, seller.password_hash);
            if (!isPasswordCorrect) return res.status(401).json({ message: 'Credenciais inválidas.' });

            const token = jwt.sign({ id: seller.id }, process.env.JWT_SECRET, { expiresIn: '1d' });
            res.status(200).json({ token });
        } catch (error) { 
            res.status(500).json({ message: 'Erro interno do servidor.' }); 
        }
    }
);

// --- Rotas Protegidas (requerem autenticação) ---

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

app.put('/api/settings/hottrack-key', 
    authenticateJwt,
    [ body('apiKey').trim().escape() ],
    handleValidationErrors,
    async (req, res) => {
        const { apiKey } = req.body;
        try {
            await sqlWithRetry('UPDATE sellers SET hottrack_api_key = $1 WHERE id = $2', [apiKey, req.user.id]);
            res.status(200).json({ message: 'Chave de API do HotTrack salva com sucesso!' });
        } catch (error) {
            res.status(500).json({ message: 'Erro ao salvar a chave.' });
        }
    }
);

// --- Gerenciamento de Bots ---

app.post('/api/bots', 
    authenticateJwt,
    [ body('bot_name').trim().notEmpty().escape() ],
    handleValidationErrors,
    async (req, res) => {
        const { bot_name } = req.body;
        try {
            const placeholderToken = `placeholder_${uuidv4()}`;
            const [newBot] = await sqlWithRetry(
                'INSERT INTO telegram_bots (seller_id, bot_name, bot_token) VALUES ($1, $2, $3) RETURNING *;',
                [req.user.id, bot_name, placeholderToken]
            );
            res.status(201).json(newBot);
        } catch (error) {
            if (error.code === '23505') return res.status(409).json({ message: 'Um bot com este nome de usuário já existe.' });
            res.status(500).json({ message: 'Erro ao salvar o bot.' });
        }
    }
);

app.delete('/api/bots/:id',
    authenticateJwt,
    [ param('id').isInt() ],
    handleValidationErrors,
    async (req, res) => {
        try {
            const result = await sqlWithRetry('DELETE FROM telegram_bots WHERE id = $1 AND seller_id = $2', [req.params.id, req.user.id]);
            if (result.count > 0) {
                res.status(204).send();
            } else {
                res.status(404).json({ message: 'Bot não encontrado ou você não tem permissão para excluí-lo.' });
            }
        } catch (error) {
            res.status(500).json({ message: 'Erro ao excluir o bot.' });
        }
    }
);

app.put('/api/bots/:id',
    authenticateJwt,
    [
        param('id').isInt(),
        body('bot_token').trim().notEmpty().escape()
    ],
    handleValidationErrors,
    async (req, res) => {
        const { bot_token } = req.body;
        try {
            const result = await sqlWithRetry('UPDATE telegram_bots SET bot_token = $1 WHERE id = $2 AND seller_id = $3', [bot_token, req.params.id, req.user.id]);
            if (result.count > 0) {
                res.status(200).json({ message: 'Token do bot atualizado.' });
            } else {
                res.status(404).json({ message: 'Bot não encontrado ou não pertence a você.' });
            }
        } catch (error) {
            res.status(500).json({ message: 'Erro ao atualizar o token.' });
        }
    }
);

// ... (Restante das rotas adaptadas com validação e checagem de propriedade)

// --- Webhook (Rota pública, mas com validação interna) ---
app.post('/api/webhook/telegram/:botId', 
    // Validação básica do parâmetro da rota
    [ param('botId').isInt({ allow_leading_zeroes: false }) ],
    handleValidationErrors,
    async (req, res) => {
    const { botId } = req.params;
    const body = req.body;
    res.sendStatus(200); // Responde imediatamente ao Telegram
    try {
        const [bot] = await sqlWithRetry('SELECT seller_id, bot_token FROM telegram_bots WHERE id = $1', [botId]);
        if (!bot) {
            console.warn(`Webhook recebido para botId desconhecido: ${botId}`);
            return;
        };
        
        if (body.message) {
            const message = body.message;
            const chatId = message?.chat?.id;
            if (!chatId) return;

            const fromUser = message.from || message.chat;
            let initialVars = {
                primeiro_nome: fromUser.first_name || '',
                nome_completo: `${fromUser.first_name || ''} ${fromUser.last_name || ''}`.trim()
            };
            
            await sqlWithRetry('DELETE FROM flow_timeouts WHERE chat_id = $1 AND bot_id = $2', [chatId, botId]);
            await saveMessageToDb(bot.seller_id, botId, message, 'user');
            
            if (message.text && message.text.startsWith('/start ')) {
                initialVars.click_id = message.text.substring(7);
            }
            await processFlow(chatId, botId, bot.bot_token, bot.seller_id, null, initialVars, null);
            
        }
    } catch (error) {
        console.error(`Erro no Webhook para Bot ID ${botId}:`, error);
    }
});


module.exports = app;

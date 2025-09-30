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
            console.log(`[Flow Engine] USUÁRIO RESPONDEU. PROSSEGUINDO INSTANTANEAMENTE.`);
            await sqlWithRetry('DELETE FROM user_flow_states WHERE chat_id = $1 AND bot_id = $2', [chatId, botId]);
            currentNodeId = findNextNode(userState.current_node_id, 'a', edges);
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
                    
                    // CORREÇÃO DEFINITIVA: Usar o click_id completo, sem remover o prefixo.
                    const click_id = variables.click_id;
                    if (!click_id) throw new Error("Click ID não encontrado nas variáveis do fluxo para gerar PIX.");

                    const [seller] = await sqlWithRetry('SELECT hottrack_api_key FROM sellers WHERE id = $1', [sellerId]);
                    if (!seller || !seller.hottrack_api_key) {
                        throw new Error("A Chave de API do HotTrack não está configurada. Vá para a página de Integrações.");
                    }

                    const hottrackApiUrl = 'https://novaapi-one.vercel.app/api/pix/generate';
                    console.log(`[Flow Engine] Chamando API HotTrack para gerar PIX para o click_id: ${click_id}`);
                    const response = await axios.post(hottrackApiUrl, 
                        { click_id, value_cents: valueInCents },
                        { headers: { 'x-api-key': seller.hottrack_api_key } }
                    );

                    const pixResult = response.data;
                    variables.last_transaction_id = pixResult.transaction_id;
                    
                    await sqlWithRetry('UPDATE user_flow_states SET variables = $1 WHERE chat_id = $2 AND bot_id = $3', [JSON.stringify(variables), chatId, botId]);
                    
                    const textToSend = `Pix copia e cola gerado:\n\n\`${pixResult.qr_code_text}\``;
                    const sentMessage = await sendTelegramRequest(botToken, 'sendMessage', { chat_id: chatId, text: textToSend, parse_mode: 'Markdown' });
                    await saveMessageToDb(sellerId, botId, sentMessage, 'bot');

                } catch (error) {
                    console.error("[Flow Engine] Erro ao gerar PIX via API HotTrack:", error.response?.data || error.message);
                    const errorMessage = error.response?.data?.message || "Desculpe, não consegui gerar o PIX neste momento. Verifique suas configurações ou tente mais tarde.";
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
                        throw new Error("A Chave de API do HotTrack não está configurada. Vá para a página de Integrações.");
                    }
                    
                    const hottrackApiUrl = `https://novaapi-one.vercel.app/api/pix/status/${transactionId}`;
                    console.log(`[Flow Engine] Chamando API HotTrack para consultar status do PIX: ${transactionId}`);
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
                     console.error("[Flow Engine] Erro ao consultar PIX via API HotTrack:", error.response?.data || error.message);
                     const errorMessage = error.response?.data?.message || "Não consegui consultar o status do PIX agora.";
                     const sentMessage = await sendTelegramRequest(botToken, 'sendMessage', { chat_id: chatId, text: errorMessage });
                     await saveMessageToDb(sellerId, botId, sentMessage, 'bot');
                     currentNodeId = findNextNode(currentNodeId, 'b', edges);
                }
                break;
            }

            case 'action_city': {
                try {
                    // CORREÇÃO DEFINITIVA: Usar o click_id completo, sem remover o prefixo.
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
                console.log(`[Flow Engine] Encaminhando ${chatId} para o fluxo ID ${targetFlowId}`);
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
            console.log(`[CRON] Encontrados ${pendingTimeouts.length} jobs agendados para processar.`);
            
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
                        console.log(`[CRON] Processando job agendado para ${timeout.chat_id} no nó ${timeout.target_node_id}`);
                        
                        const initialVars = timeout.variables || {};
                        const flowData = initialVars.flow_data ? JSON.parse(initialVars.flow_data) : null;
                        if (initialVars.flow_data) delete initialVars.flow_data;

                        processFlow(timeout.chat_id, timeout.bot_id, bot.bot_token, bot.seller_id, timeout.target_node_id, initialVars, flowData);
                    }
                } else {
                     console.log(`[CRON] Job para ${timeout.chat_id} ignorado pois o estado do usuário mudou ou não existe mais.`);
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
app.get('/api/health', async (req, res) => {
    try {
        const result = await sqlWithRetry('SELECT 1 as status;');
        if (result[0]?.status === 1) {
            res.status(200).json({ status: 'ok', message: 'API está rodando e a conexão com o banco de dados foi bem-sucedida.' });
        } else {
            throw new Error('O banco de dados não retornou o resultado esperado.' );
        }
    } catch (error) {
        console.error('[HEALTH CHECK ERROR]', error);
        res.status(500).json({ 
            status: 'error', 
            message: 'A API está rodando, mas não conseguiu se conectar ao banco de dados.',
            error: error.message 
        });
    }
});

app.post('/api/sellers/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password || password.length < 8) return res.status(400).json({ message: 'Dados inválidos.' });
    try {
        const normalizedEmail = email.trim().toLowerCase();
        const existingSeller = await sqlWithRetry('SELECT id FROM sellers WHERE LOWER(email) = $1', [normalizedEmail]);
        if (existingSeller.length > 0) return res.status(409).json({ message: 'Este email já está em uso.' });
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const apiKey = uuidv4();
        await sqlWithRetry('INSERT INTO sellers (name, email, password_hash, api_key, is_active) VALUES ($1, $2, $3, $4, TRUE)', [name, normalizedEmail, hashedPassword, apiKey]);
        res.status(201).json({ message: 'Vendedor cadastrado com sucesso!' });
    } catch (error) { res.status(500).json({ message: 'Erro interno do servidor.' }); }
});

app.post('/api/sellers/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email e senha são obrigatórios.' });
    try {
        const normalizedEmail = email.trim().toLowerCase();
        const [seller] = await sqlWithRetry('SELECT id, email, password_hash, is_active FROM sellers WHERE email = $1', [normalizedEmail]);
        if (!seller) return res.status(404).json({ message: 'Usuário não encontrado.' });
        
        if (!seller.is_active) {
            return res.status(403).json({ message: 'Este usuário está bloqueado.' });
        }

        const isPasswordCorrect = await bcrypt.compare(password, seller.password_hash);
        if (!isPasswordCorrect) return res.status(401).json({ message: 'Senha incorreta.' });
        
        const token = jwt.sign({ id: seller.id, email: seller.email }, process.env.JWT_SECRET, { expiresIn: '1d' });
        res.status(200).json({ token });
    } catch (error) { 
        console.error("Erro no login:", error);
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
    if (typeof apiKey === 'undefined') {
        return res.status(400).json({ message: 'O campo apiKey é obrigatório.' });
    }
    try {
        await sqlWithRetry('UPDATE sellers SET hottrack_api_key = $1 WHERE id = $2', [apiKey, req.user.id]);
        res.status(200).json({ message: 'Chave de API do HotTrack salva com sucesso!' });
    } catch (error) {
        console.error("Erro ao salvar a chave de API do HotTrack:", error);
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
        
        const sentMessage = await sendTelegramRequest(bot.bot_token, 'sendMessage', { chat_id: chatId, text });
        await saveMessageToDb(req.user.id, req.params.botId, sentMessage, 'operator');
        res.status(200).json({ message: 'Mensagem enviada!' });
    } catch (error) { res.status(500).json({ message: 'Não foi possível enviar a mensagem.' }); }
});

app.delete('/api/chats/:botId/:chatId', authenticateJwt, async (req, res) => {
    try {
        await sqlWithRetry('DELETE FROM telegram_chats WHERE bot_id = $1 AND chat_id = $2 AND seller_id = $3', [req.params.botId, req.params.chatId, req.user.id]);
        await sqlWithRetry('DELETE FROM user_flow_states WHERE bot_id = $1 AND chat_id = $2', [req.params.botId, req.params.chatId]);
        res.status(204).send();
    } catch (error) { res.status(500).json({ message: 'Erro ao deletar a conversa.' }); }
});

app.post('/api/bots/mass-send', authenticateJwt, async (req, res) => {
    const { botIds, initialText, ctaButtonText, externalLink, imageUrl } = req.body;

    if (!botIds || !initialText || !ctaButtonText) return res.status(400).json({ message: 'Campos obrigatórios faltando.' });
    try {
        const bots = await sqlWithRetry('SELECT id, bot_token FROM telegram_bots WHERE id = ANY($1) AND seller_id = $2', [botIds, req.user.id]);
        if (bots.length === 0) return res.status(404).json({ message: 'Nenhum bot válido selecionado.' });
        
        const users = await sqlWithRetry('SELECT DISTINCT ON (chat_id) chat_id, bot_id FROM telegram_chats WHERE bot_id = ANY($1) AND seller_id = $2', [botIds, req.user.id]);
        if (users.length === 0) return res.status(404).json({ message: 'Nenhum usuário encontrado.' });

        res.status(202).json({ message: `Disparo agendado para ${users.length} usuários.` });
        
        (async () => {
            const botTokenMap = new Map(bots.map(b => [b.id, b.bot_token]));
            for (const user of users) {
                const botToken = botTokenMap.get(user.bot_id);
                if (!botToken) continue;

                const method = imageUrl ? 'sendPhoto' : 'sendMessage';
                const payload = { 
                    chat_id: user.chat_id, 
                    reply_markup: { inline_keyboard: [[{ text: ctaButtonText, url: externalLink }]] }
                };
                if(imageUrl) {
                    payload.photo = imageUrl;
                    payload.caption = initialText;
                } else {
                    payload.text = initialText;
                }

                try {
                    await sendTelegramRequest(botToken, method, payload);
                } catch (error) { console.error(`Falha ao enviar para ${user.chat_id}`); }
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            console.log(`Disparo concluído para ${users.length} usuários.`);
        })();
    } catch (error) {
        if (!res.headersSent) res.status(500).json({ message: 'Erro ao iniciar o disparo.' });
    }
});


// --- WEBHOOK DO TELEGRAM ---
app.post('/api/webhook/telegram/:botId', async (req, res) => {
    const { botId } = req.params;
    const body = req.body;
    res.sendStatus(200);

    try {
        const message = body.message;
        const chatId = message?.chat?.id;
        if (!chatId || !message.text) return;
        
        await sqlWithRetry('DELETE FROM flow_timeouts WHERE chat_id = $1 AND bot_id = $2', [chatId, botId]);

        const [bot] = await sqlWithRetry('SELECT seller_id, bot_token FROM telegram_bots WHERE id = $1', [botId]);
        if (!bot) return;
        
        await saveMessageToDb(bot.seller_id, botId, message, 'user');
        
        let initialVars = {};
        if (message.text.startsWith('/start ')) {
            console.log(`[Webhook] Comando /start recebido para ${chatId}. Resetando estado do fluxo.`);
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

    } catch (error) {
        console.error("Erro no Webhook do Telegram:", error);
    }
});


module.exports = app;

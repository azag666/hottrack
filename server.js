<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HotTrack SAAS</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        body {
            font-family: 'Inter', sans-serif; background-color: #020617; color: #e2e8f0;
            background-image: radial-gradient(circle at 1px 1px, rgba(56, 189, 248, 0.1) 1px, transparent 0);
            background-size: 20px 20px;
        }
        .card {
            background-color: rgba(15, 23, 42, 0.6); border: 1px solid rgba(56, 189, 248, 0.2);
            backdrop-filter: blur(12px); transition: all 0.3s ease;
        }
        .form-input, .form-select {
            background-color: rgba(30, 41, 59, 0.5); border: 1px solid #334155; color: #cbd5e1;
            transition: all 0.3s ease;
        }
        .form-input:focus, .form-select:focus {
            outline: none; border-color: #38bdf8;
            box-shadow: 0 0 15px rgba(56, 189, 248, 0.2);
        }
        .btn {
            background-color: #0ea5e9; color: white; transition: all 0.3s ease;
            box-shadow: 0 0 10px rgba(14, 165, 233, 0.3), inset 0 0 5px rgba(255, 255, 255, 0.1);
            border: 1px solid #38bdf8;
        }
        .btn:hover {
            background-color: #38bdf8; box-shadow: 0 0 20px rgba(56, 189, 248, 0.6);
            transform: translateY(-2px);
        }
        .btn:disabled { background-color: #334155; cursor: not-allowed; transform: none; box-shadow: none; }
        .btn-red { background-color: #7f1d1d; border-color: #b91c1c; box-shadow: 0 0 10px rgba(239, 68, 68, 0.3); }
        .btn-red:hover { background-color: #991b1b; box-shadow: 0 0 20px rgba(239, 68, 68, 0.6); }
        .btn-green { background-color: #047857; border-color: #059669; box-shadow: 0 0 10px rgba(16, 185, 129, 0.3); }
        .btn-green:hover { background-color: #059669; box-shadow: 0 0 20px rgba(16, 185, 129, 0.6); }
        .nav-link { color: #94a3b8; border-left: 3px solid transparent; cursor: pointer; transition: all 0.3s ease; }
        .nav-link:hover { background-color: rgba(56, 189, 248, 0.05); border-left-color: #38bdf8; color: #e2e8f0; }
        .nav-link.active { background-color: rgba(14, 165, 233, 0.1); border-left-color: #0ea5e9; color: white; font-weight: 600; }
        .modal { display: none; }
        .modal.active { display: flex; align-items: center; justify-content: center; position: fixed; z-index: 50; inset: 0; background-color: rgba(0,0,0,0.7); backdrop-filter: blur(8px); }
        .animate-fade-in { animation: fadeIn 0.5s ease-out; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .provider-selector input:checked + label {
            border-color: #38bdf8;
            box-shadow: 0 0 20px rgba(56, 189, 248, 0.4);
            transform: translateY(-2px);
        }
        .provider-selector input:checked + label h3 {
            color: #7dd3fc;
        }
        .table-custom th, .table-custom td { padding: 0.75rem; border-bottom: 1px solid #334155; text-align: left; }
    </style>
</head>
<body>
    <div id="app"></div>
    <div id="modal-container"></div>

    <script>
    const App = {
        state: {
            API_BASE_URL: 'https://hottrack.vercel.app',
            token: null,
            data: { pixels: [], bots: [], pressels: [], settings: {} },
            currentPage: 'dashboard'
        },

        async init() {
            if (window.location.origin.includes('localhost') || window.location.origin.includes('127.0.0.1')) {
                this.state.API_BASE_URL = 'http://localhost:3000';
            }
            
            this.state.token = localStorage.getItem('hottrack_token');
            const appContainer = document.getElementById('app');
            appContainer.innerHTML = `<div class="flex h-screen items-center justify-center"><p>Carregando...</p></div>`;
            if (this.state.token) {
                try {
                    this.state.data = await this.apiRequest('/api/dashboard/data');
                    this.renderLayout();
                } catch (e) { this.logout(); }
            } else {
                this.renderLogin();
            }
        },

        renderLogin(page = 'login') {
            document.getElementById('app').innerHTML = this.templates.auth(page);
            this.addAuthEventListeners();
        },

        renderLayout() {
            document.getElementById('app').innerHTML = this.templates.layout();
            this.navigateTo(this.state.currentPage);
            this.addDashboardEventListeners();
        },
        
        templates: {
            auth(page = 'login') {
                return `<div class="flex items-center justify-center min-h-screen p-4"><div id="auth-forms-container" class="w-full max-w-md">${page === 'login' ? this.loginForm() : this.registerForm()}</div></div>`;
            },
            loginForm() {
                return `
                <div class="card p-8 rounded-2xl shadow-lg animate-fade-in">
                    <h1 class="text-3xl font-bold text-center text-white">Acessar Plataforma</h1>
                    <form id="loginForm" class="space-y-6 mt-8">
                        <div><label class="text-sm font-medium text-gray-400">E-mail</label><input name="email" type="email" required class="form-input w-full p-3 mt-1 rounded-md"></div>
                        <div><label class="text-sm font-medium text-gray-400">Senha</label><input name="password" type="password" required class="form-input w-full p-3 mt-1 rounded-md"></div>
                        <button type="submit" class="btn w-full font-semibold py-3 rounded-md">Entrar</button>
                    </form>
                    <div class="text-center mt-6"><a href="#" id="showRegister" class="text-sm text-sky-400 hover:text-sky-300">Não tem uma conta? Cadastre-se</a></div>
                </div>`;
            },
            registerForm() {
                return `
                <div class="card p-8 rounded-2xl shadow-lg animate-fade-in">
                    <h1 class="text-3xl font-bold text-center text-white">Criar Conta</h1>
                    <form id="registerForm" class="space-y-6 mt-8">
                        <div><label class="text-sm font-medium text-gray-400">Nome</label><input name="name" type="text" required class="form-input w-full p-3 mt-1 rounded-md"></div>
                        <div><label class="text-sm font-medium text-gray-400">E-mail</label><input name="email" type="email" required class="form-input w-full p-3 mt-1 rounded-md"></div>
                        <div><label class="text-sm font-medium text-gray-400">Senha</label><input name="password" type="password" required minlength="8" class="form-input w-full p-3 mt-1 rounded-md"></div>
                        <button type="submit" class="btn w-full font-semibold py-3 rounded-md">Criar Conta</button>
                    </form>
                    <div class="text-center mt-6"><a href="#" id="showLogin" class="text-sm text-sky-400 hover:text-sky-300">Já tem uma conta? Faça Login</a></div>
                </div>`;
            },
            layout() {
                return `
                <div class="flex h-screen">
                    <aside class="w-64 card p-4 flex flex-col">
                        <div class="text-center mb-10 flex items-center justify-center gap-2">
                            <svg class="h-8 w-8 text-sky-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" /></svg>
                            <h1 class="text-2xl font-bold text-white">HotTrack</h1>
                        </div>
                        <nav id="sidebarNav" class="flex flex-col space-y-2">
                            <div data-target="dashboard" class="nav-link p-3 rounded-lg flex items-center gap-3">
                                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 10v11h18V10M3 10l9-7 9 7M3 10h18" /></svg>
                                Dashboard
                            </div>
                            <div data-target="transactions" class="nav-link p-3 rounded-lg flex items-center gap-3">
                                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 10v11h18V10M3 10l9-7 9 7M3 10h18" /></svg>
                                Transações
                            </div>
                            <div data-target="pressels" class="nav-link p-3 rounded-lg flex items-center gap-3"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>Criador de Pressel</div>
                            <div data-target="pixels" class="nav-link p-3 rounded-lg flex items-center gap-3"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6.429 9.75L2.25 12l4.179 2.25m0-4.5l5.571 3 5.571-3m-11.142 0L2.25 12l4.179 2.25M6.429 9.75l5.571 3 5.571-3m0 0l4.179-2.25L12 5.25 7.821 7.5" /></svg>Gerenciar Pixels</div>
                            <div data-target="bots" class="nav-link p-3 rounded-lg flex items-center gap-3"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>Gerenciar Bots</div>
                            <div data-target="settings" class="nav-link p-3 rounded-lg flex items-center gap-3"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" /></svg>API PIX</div>
                            <div data-target="documentation" class="nav-link p-3 rounded-lg flex items-center gap-3"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" /></svg>Documentação</div>
                        </nav>
                        <div class="mt-auto"><button id="logoutButton" class="w-full text-gray-400 hover:bg-red-900/50 hover:text-white font-semibold py-2 px-4 rounded-md flex items-center justify-center gap-2"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>Sair</button></div>
                    </aside>
                    <main id="content" class="flex-1 p-8 overflow-y-auto"></main>
                </div>`;
            },
            dashboard() {
                return `
                <div class="animate-fade-in">
                    <div class="flex justify-between items-center mb-6">
                        <h1 class="text-3xl font-bold text-white">Painel de Métricas</h1>
                        <div class="flex items-center space-x-2">
                            <label class="text-sm font-medium text-gray-400">De:</label>
                            <input type="date" id="startDate" class="form-input p-2 rounded-md">
                            <label class="text-sm font-medium text-gray-400">Até:</label>
                            <input type="date" id="endDate" class="form-input p-2 rounded-md">
                            <button id="refreshDashboardBtn" class="btn text-sm py-2 px-3">
                                <svg class="h-4 w-4 inline-block mr-1" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001m0 0h-4.992m4.992 0L21 9.348M16.023 9.348A10.038 10.038 0 0112 19.5 10.038 10.038 0 012.98 9.348" /></svg>
                                Atualizar
                            </button>
                        </div>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6 mb-8">
                        <div class="card p-6 rounded-lg text-center">
                            <h3 class="text-sm text-gray-400">Cliques na Página</h3>
                            <p id="metric-clicks" class="text-4xl font-bold text-sky-400 mt-2">...</p>
                        </div>
                        <div class="card p-6 rounded-lg text-center">
                            <h3 class="text-sm text-gray-400">PIX Gerados</h3>
                            <p id="metric-generated" class="text-4xl font-bold text-yellow-400 mt-2">...</p>
                        </div>
                        <div class="card p-6 rounded-lg text-center">
                            <h3 class="text-sm text-gray-400">Faturamento Total</h3>
                            <p id="metric-total-revenue" class="text-4xl font-bold text-sky-400 mt-2">...</p>
                        </div>
                        <div class="card p-6 rounded-lg text-center">
                            <h3 class="text-sm text-gray-400">PIX Pagos</h3>
                            <p id="metric-paid" class="text-4xl font-bold text-green-400 mt-2">...</p>
                        </div>
                        <div class="card p-6 rounded-lg text-center">
                            <h3 class="text-sm text-gray-400">Faturamento Pago</h3>
                            <p id="metric-paid-revenue" class="text-4xl font-bold text-green-400 mt-2">...</p>
                        </div>
                    </div>
                    
                    <div class="grid grid-cols-1 gap-8 md:grid-cols-2">
                        <div class="card p-6 rounded-lg">
                            <h2 class="text-xl font-semibold text-white mb-4">Desempenho por Bot</h2>
                            <div id="bots-performance-table-container" class="overflow-x-auto">
                                <table class="table-custom w-full text-sm">
                                    <thead><tr><th>Bot</th><th>Cliques</th><th>Vendas</th><th>Faturamento</th></tr></thead>
                                    <tbody id="bots-performance-table"><tr><td colspan="4" class="text-center text-gray-500">Carregando...</td></tr></tbody>
                                </table>
                            </div>
                        </div>
                        <div class="card p-6 rounded-lg">
                             <h2 class="text-xl font-semibold text-white mb-4">Tráfego por Estado</h2>
                            <div id="traffic-by-state-table-container" class="overflow-x-auto">
                                <table class="table-custom w-full text-sm">
                                    <thead><tr><th>Estado</th><th>Cliques</th></tr></thead>
                                    <tbody id="traffic-by-state-table"><tr><td colspan="2" class="text-center text-gray-500">Carregando...</td></tr></tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>`;
            },
            transactions() {
                return `
                <div class="animate-fade-in">
                    <div class="flex justify-between items-center mb-6">
                        <h1 class="text-3xl font-bold text-white">Transações Recentes</h1>
                        <div class="flex items-center space-x-4">
                            <label class="text-sm font-medium text-gray-400">De:</label>
                            <input type="date" id="startDateTrans" class="form-input p-2 rounded-md">
                            <label class="text-sm font-medium text-gray-400">Até:</label>
                            <input type="date" id="endDateTrans" class="form-input p-2 rounded-md">
                            <button id="refreshTransactionsBtn" class="btn text-sm py-2 px-3">
                                <svg class="h-4 w-4 inline-block mr-1" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001m0 0h-4.992m4.992 0L21 9.348M16.023 9.348A10.038 10.038 0 0112 19.5 10.038 10.038 0 012.98 9.348" /></svg>
                                Atualizar
                            </button>
                        </div>
                    </div>
                    <div class="card p-6 rounded-lg">
                        <div class="overflow-x-auto">
                            <table class="table-custom w-full text-sm">
                                <thead>
                                    <tr>
                                        <th>ID da Transação</th>
                                        <th>Valor</th>
                                        <th>Status</th>
                                        <th>Bot</th>
                                        <th>Click ID</th>
                                        <th>Data</th>
                                    </tr>
                                </thead>
                                <tbody id="transactions-table">
                                    <tr><td colspan="6" class="text-center text-gray-500">Carregando...</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>`;
            },
            pixels() {
                const pixelListHTML = App.state.data.pixels.map(p => `<div class="p-2 bg-slate-900/50 rounded flex justify-between items-center"><span class="text-sm">${p.account_name}</span><button data-id="${p.id}" class="delete-pixel-btn btn btn-red text-xs py-1 px-2">Excluir</button></div>`).join('');
                return `
                <div class="animate-fade-in">
                    <h1 class="text-3xl font-bold text-white mb-6">Gerenciar Pixels</h1>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
                        <div class="card p-6 rounded-lg">
                            <h2 class="text-xl font-semibold mb-4 text-white">Adicionar Pixel</h2>
                            <form id="pixelForm" class="space-y-3">
                                <input name="account_name" placeholder="Nome do Pixel (Ex: Produto Y)" class="form-input w-full p-2 rounded-md" required>
                                <input name="pixel_id" placeholder="ID do Pixel da Meta" class="form-input w-full p-2 rounded-md" required>
                                <textarea name="meta_api_token" placeholder="Token da API de Conversões" class="form-input w-full p-2 rounded-md" rows="2" required></textarea>
                                <button type="submit" class="btn w-full p-2 rounded-md">Adicionar Pixel</button>
                            </form>
                        </div>
                        <div class="card p-6 rounded-lg">
                            <h2 class="text-xl font-semibold text-white mb-4">Pixels Salvos</h2>
                            <div id="pixel-list" class="space-y-2">${pixelListHTML.length ? pixelListHTML : '<p class="text-gray-500 text-sm">Nenhum pixel salvo.</p>'}</div>
                        </div>
                    </div>
                </div>`;
            },
            bots() {
                 const botListHTML = App.state.data.bots.map(b => `
                    <div class="p-3 bg-slate-900/50 rounded flex justify-between items-center">
                        <span class="text-sm font-medium">${b.bot_name}</span>
                        <div class="space-x-2">
                           <button data-id="${b.id}" class="manage-flow-btn btn text-xs py-1 px-2">Gerenciar Fluxo</button>
                           <button data-id="${b.id}" class="delete-bot-btn btn btn-red text-xs py-1 px-2">Excluir</button>
                        </div>
                    </div>`).join('');
                return `
                <div class="animate-fade-in">
                    <h1 class="text-3xl font-bold text-white mb-6">Gerenciar Bots</h1>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
                        <div class="card p-6 rounded-lg">
                            <h2 class="text-xl font-semibold mb-4 text-white">Adicionar Bot</h2>
                            <form id="botForm" class="space-y-3">
                                <input name="bot_name" placeholder="Username do Bot (sem @)" class="form-input w-full p-2 rounded-md" required>
                                <input name="bot_token" placeholder="Token do Bot (do BotFather)" class="form-input w-full p-2 rounded-md" required>
                                <button type="submit" class="btn w-full p-2 rounded-md">Adicionar Bot</button>
                            </form>
                        </div>
                        <div class="card p-6 rounded-lg">
                            <h2 class="text-xl font-semibold text-white mb-4">Bots Salvos</h2>
                            <div id="bot-list" class="space-y-2">${botListHTML.length ? botListHTML : '<p class="text-gray-500 text-sm">Nenhum bot salvo.</p>'}</div>
                        </div>
                    </div>
                </div>`;
            },
            pressels() {
                const { pixels, bots, pressels } = App.state.data;
                const botOptions = bots.map(b => `<option value="${b.id}">${b.bot_name}</option>`).join('');
                const pixelCheckboxes = pixels.map(p => `<label class="flex items-center space-x-2 text-gray-400 hover:text-white cursor-pointer"><input type="checkbox" name="pixel_ids" value="${p.id}" class="h-4 w-4 bg-slate-700 border-slate-500 rounded text-sky-500 focus:ring-sky-500"><span>${p.account_name}</span></label>`).join('');
                const presselList = pressels.map(pr => `
                    <div class="p-3 card flex justify-between items-center text-sm">
                        <div><p class="font-semibold">${pr.name}</p><p class="text-xs text-gray-400">Bot: ${pr.bot_name}</p></div>
                        <div class="space-x-2">
                           <button data-id="${pr.id}" class="generate-code-btn btn text-xs py-1 px-2">Ver Código</button>
                           <button data-id="${pr.id}" class="delete-pressel-btn btn btn-red text-xs py-1 px-2">Excluir</button>
                        </div>
                    </div>`).join('');
                return `
                <div class="animate-fade-in">
                    <h1 class="text-3xl font-bold text-white mb-6">Criador de Pressel</h1>
                    <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                        <div class="card p-6 rounded-lg">
                            <h2 class="text-xl font-bold mb-4 text-white">Criar Nova Pressel</h2>
                            <form id="presselForm" class="space-y-4">
                                <input name="name" placeholder="Nome da Pressel (Ex: Campanha Black Friday)" class="form-input w-full p-2 rounded-md" required>
                                <input name="white_page_url" type="url" placeholder="URL da Página Branca (Fallback)" class="form-input w-full p-2 rounded-md" required>
                                <select name="bot_id" class="form-input w-full p-2 rounded-md" required><option value="">Selecione um Bot</option>${botOptions}</select>
                                <div class="card p-3"><p class="font-semibold mb-2">Selecione os Pixels:</p><div class="space-y-2">${pixelCheckboxes.length ? pixelCheckboxes : '<p class="text-gray-500 text-sm">Cadastre um pixel primeiro.</p>'}</div></div>
                                <button type="submit" class="btn w-full p-3 rounded-md text-base font-bold">Salvar e Gerar Código</button>
                            </form>
                        </div>
                        <div class="card p-6 rounded-lg">
                            <h2 class="text-xl font-bold mb-4 text-white">Pressels Criadas</h2>
                            <div id="pressel-list" class="space-y-3">${presselList.length ? presselList : '<p class="text-gray-500 text-sm">Nenhuma pressel criada.</p>'}</div>
                        </div>
                    </div>
                </div>`;
            },
            settings() {
                const { settings } = App.state.data;
                const isChecked = (provider) => (settings.active_pix_provider === provider) || (!settings.active_pix_provider && provider === 'pushinpay') ? 'checked' : '';

                return `
                <div class="animate-fade-in">
                    <h1 class="text-3xl font-bold text-white mb-6">API PIX</h1>
                    <form id="pixSettingsForm" class="space-y-8 max-w-3xl">
                        <div class="card p-6 rounded-lg">
                            <h2 class="text-xl font-semibold mb-2 text-white">Provedor de PIX Ativo</h2>
                            <p class="text-sm text-gray-400 mb-4">Selecione o provedor de pagamento que será usado para todas as suas transações.</p>
                            <div class="grid grid-cols-1 md:grid-cols-3 gap-4 provider-selector">
                                <input type="radio" id="provider_pushinpay" name="active_pix_provider" value="pushinpay" class="hidden" ${isChecked('pushinpay')}>
                                <label for="provider_pushinpay" class="card p-4 text-center cursor-pointer border-2 border-slate-700 hover:border-sky-500 transition-all duration-200">
                                    <h3 class="text-lg font-bold text-white">PushinPay</h3>
                                </label>
                                <input type="radio" id="provider_cnpay" name="active_pix_provider" value="cnpay" class="hidden" ${isChecked('cnpay')}>
                                <label for="provider_cnpay" class="card p-4 text-center cursor-pointer border-2 border-slate-700 hover:border-sky-500 transition-all duration-200">
                                    <h3 class="text-lg font-bold text-white">CN Pay</h3>
                                </label>
                                <input type="radio" id="provider_oasyfy" name="active_pix_provider" value="oasyfy" class="hidden" ${isChecked('oasyfy')}>
                                <label for="provider_oasyfy" class="card p-4 text-center cursor-pointer border-2 border-slate-700 hover:border-sky-500 transition-all duration-200">
                                    <h3 class="text-lg font-bold text-white">Oasy.fy</h3>
                                </label>
                            </div>
                        </div>

                        <div class="card p-6 rounded-lg">
                            <h2 class="text-xl font-semibold mb-4 text-white">Credenciais</h2>
                            <div class="space-y-6">
                                <div>
                                    <h3 class="text-lg font-medium text-sky-400 mb-2">PushinPay</h3>
                                    <label class="block mb-2 text-sm text-gray-400">Bearer Token</label>
                                    <input name="pushinpay_token" type="password" value="${settings.pushinpay_token || ''}" class="form-input w-full p-2 rounded-md">
                                </div>
                                <hr class="border-slate-700">
                                <div>
                                    <h3 class="text-lg font-medium text-sky-400 mb-2">CN Pay</h3>
                                    <label class="block mb-2 text-sm text-gray-400">Chave Pública (public-key)</label>
                                    <input name="cnpay_public_key" type="password" value="${settings.cnpay_public_key || ''}" class="form-input w-full p-2 rounded-md">
                                    <label class="block mt-4 mb-2 text-sm text-gray-400">Chave Privada (secret-key)</label>
                                    <input name="cnpay_secret_key" type="password" value="${settings.cnpay_secret_key || ''}" class="form-input w-full p-2 rounded-md">
                                </div>
                                 <hr class="border-slate-700">
                                <div>
                                    <h3 class="text-lg font-medium text-sky-400 mb-2">Oasy.fy</h3>
                                    <label class="block mb-2 text-sm text-gray-400">Chave Pública (public-key)</label>
                                    <input name="oasyfy_public_key" type="password" value="${settings.oasyfy_public_key || ''}" class="form-input w-full p-2 rounded-md">
                                    <label class="block mt-4 mb-2 text-sm text-gray-400">Chave Privada (secret-key)</label>
                                    <input name="oasyfy_secret_key" type="password" value="${settings.oasyfy_secret_key || ''}" class="form-input w-full p-2 rounded-md">
                                </div>
                            </div>
                        </div>

                        <div>
                            <button type="submit" class="btn w-full p-3 font-bold rounded-md">Salvar Configurações</button>
                        </div>
                    </form>
                </div>`;
            },
            documentation() {
                return `
                <div class="animate-fade-in">
                    <h1 class="text-3xl font-bold text-white mb-6">Documentação e Chave de API</h1>
                    <div class="grid grid-cols-1 gap-8 max-w-2xl">
                        <div class="card p-6 rounded-lg">
                            <h2 class="text-xl font-semibold mb-4 text-white">Sua Chave de API HotTrack</h2>
                            <p class="text-sm text-gray-400 mb-4">Use esta chave para autenticar suas requisições na API HotTrack (ex: gerar PIX, consultar status).</p>
                            <div class="flex items-center gap-2">
                                <input id="hottrack-api-key" type="password" readonly value="${App.state.data.settings.api_key || ''}" class="form-input flex-grow p-2 rounded-md">
                                <button type="button" class="toggle-visibility-btn p-2 text-gray-400 hover:text-white" data-target="#hottrack-api-key">
                                    <svg class="pointer-events-none h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                                </button>
                                <button type="button" class="copy-btn btn text-sm py-2 px-3" data-target="#hottrack-api-key">Copiar</button>
                            </div>
                        </div>
                        <div class="card p-8 rounded-lg">
                            <h2 class="text-xl font-semibold mb-4 text-white">Documentação Completa</h2>
                            <p class="text-gray-400 mb-4">Acesse nosso guia detalhado com o passo a passo completo para integrar o HotTrack com o ManyChat e outras ferramentas.</p>
                            <a href="https://documentacaohot.netlify.app/" target="_blank" rel="noopener noreferrer" class="btn inline-flex items-center gap-2">
                                Acessar Documentação
                                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                            </a>
                        </div>
                    </div>
                </div>`;
            },
            modal(title, content) {
                return `<div id="modal" class="modal active"><div class="card p-6 rounded-lg w-full max-w-2xl animate-fade-in"><div class="flex justify-between items-center mb-4"><h2 class="text-xl font-bold">${title}</h2><button id="closeModalBtn" class="text-gray-400 hover:text-white text-2xl">&times;</button></div>${content}</div></div>`;
            },
            botFlowModal(bot) {
                const modalContent = `
                    <p class="text-sm text-gray-400 mb-6">Configure a mensagem que o bot <strong>@${bot.bot_name}</strong> enviará ao receber o comando /start.</p>
                    <form id="botFlowForm" data-bot-id="${bot.id}" class="space-y-4">
                        <div>
                            <label class="text-sm font-medium text-gray-400 block mb-1">URL da Imagem</label>
                            <input name="flow_image_url" placeholder="https://exemplo.com/imagem.png" class="form-input w-full p-2 rounded-md" required>
                        </div>
                        
                        <div>
                            <label class="text-sm font-medium text-gray-400 block mb-1">Valor do PIX (Ex: 9.90)</label>
                            <input name="flow_pix_value" type="number" step="0.01" placeholder="9.90" class="form-input w-full p-2 rounded-md" required>
                        </div>

                        <div>
                            <label class="text-sm font-medium text-gray-400 block mb-1">Texto da Mensagem</label>
                            <textarea name="flow_text" placeholder="Digite o texto que aparecerá junto com a imagem." class="form-input w-full p-2 rounded-md" rows="4" required></textarea>
                        </div>
                        <div class="grid grid-cols-2 gap-4">
                            <div>
                                <label class="text-sm font-medium text-gray-400 block mb-1">Texto Botão PIX</label>
                                <input name="flow_button_pix_text" value="✅ Gerar PIX" class="form-input w-full p-2 rounded-md" required>
                            </div>
                            <div>
                                <label class="text-sm font-medium text-gray-400 block mb-1">Texto Botão Consultar</label>
                                <input name="flow_button_check_text" value="🔎 Consultar PIX" class="form-input w-full p-2 rounded-md" required>
                            </div>
                        </div>
                        <div class="flex justify-end gap-4 pt-4">
                            <button type="button" id="setWebhookBtn" data-bot-id="${bot.id}" class="btn btn-green">Ativar/Atualizar Bot</button>
                            <button type="submit" class="btn">Salvar Fluxo</button>
                        </div>
                    </form>
                `;
                return this.modal(`Gerenciar Fluxo de @${bot.bot_name}`, modalContent);
            }
        },

        addAuthEventListeners() {
            const container = document.getElementById('app');
            container.addEventListener('click', (e) => {
                if (e.target.id === 'showRegister') { e.preventDefault(); this.renderLogin('register'); }
                if (e.target.id === 'showLogin') { e.preventDefault(); this.renderLogin('login'); }
            });
            container.addEventListener('submit', async (e) => {
                e.preventDefault();
                const form = e.target;
                const data = Object.fromEntries(new FormData(form).entries());
                if (form.id === 'loginForm') await this.login(data.email, data.password);
                if (form.id === 'registerForm') await this.register(data.name, data.email, data.password);
            });
        },
        
        addDashboardEventListeners() {
            document.addEventListener('click', async (e) => {
                if (e.target.id === 'logoutButton') this.logout();
                if (e.target.id === 'closeModalBtn') document.getElementById('modal-container').innerHTML = '';
                
                const sidebarLink = e.target.closest('.nav-link');
                if (sidebarLink) this.navigateTo(sidebarLink.dataset.target);
                
                // Event listeners para os novos botões de atualização com filtro
                if (e.target.id === 'refreshDashboardBtn') this.fetchDashboardMetrics();
                if (e.target.id === 'refreshTransactionsBtn') this.fetchTransactions();

                const copyBtn = e.target.closest('.copy-btn');
                if (copyBtn) {
                    const targetInput = document.querySelector(copyBtn.dataset.target);
                    if(targetInput && targetInput.value) {
                        navigator.clipboard.writeText(targetInput.value).then(() => {
                            const originalText = copyBtn.textContent;
                            copyBtn.textContent = 'Copiado!';
                            setTimeout(() => { copyBtn.textContent = originalText; }, 2000);
                        });
                    }
                }
                
                const toggleBtn = e.target.closest('.toggle-visibility-btn');
                if (toggleBtn) {
                    const targetInput = document.querySelector(toggleBtn.dataset.target);
                    const isPassword = targetInput.type === 'password';
                    targetInput.type = isPassword ? 'text' : 'password';
                    toggleBtn.innerHTML = isPassword 
                        ? `<svg class="pointer-events-none h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.243 4.243L6.228 6.228" /></svg>` 
                        : `<svg class="pointer-events-none h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>`;
                }

                if (e.target.classList.contains('generate-code-btn')) {
                    const presselId = e.target.dataset.id;
                    const pressel = this.state.data.pressels.find(p => p.id == presselId);
                    if (pressel) this.generatePresselCode(pressel);
                }

                if (e.target.classList.contains('manage-flow-btn')) {
                    const botId = e.target.dataset.id;
                    const bot = this.state.data.bots.find(b => b.id == botId);
                    if (bot) this.openBotFlowModal(bot);
                }

                if (e.target.id === 'setWebhookBtn') {
                    const botId = e.target.dataset.botId;
                    const button = e.target;
                    const originalText = button.textContent;
                    button.textContent = 'Ativando...';
                    button.disabled = true;
                    try {
                        const result = await this.apiRequest(`/api/bots/${botId}/set-webhook`, 'POST');
                        this.showToast(result.message, 'success');
                    } catch(err) {}
                    finally {
                        button.textContent = originalText;
                        button.disabled = false;
                    }
                }

                if (e.target.classList.contains('delete-pixel-btn') || e.target.classList.contains('delete-bot-btn') || e.target.classList.contains('delete-pressel-btn')) {
                    const id = e.target.dataset.id;
                    let type = '', endpoint = '';
                    if (e.target.classList.contains('delete-pixel-btn')) { type = 'pixels'; endpoint = 'pixels'; }
                    if (e.target.classList.contains('delete-bot-btn')) { type = 'bots'; endpoint = 'bots'; }
                    if (e.target.classList.contains('delete-pressel-btn')) { type = 'pressels'; endpoint = 'pressels'; }

                    if (confirm(`Tem certeza que deseja excluir este item?`)) {
                        try {
                            await this.apiRequest(`/api/${endpoint}/${id}`, 'DELETE');
                            this.state.data[type] = this.state.data[type].filter(item => item.id != id);
                            this.navigateTo(this.state.currentPage);
                            this.showToast('Item excluído com sucesso!', 'success');
                        } catch(err) {}
                    }
                }
            });

            document.addEventListener('submit', async (e) => {
                const form = e.target.closest('form');
                if (!form) return;
                
                e.preventDefault();
                const button = form.querySelector('button[type="submit"]');
                const originalButtonText = button.innerHTML;
                button.innerHTML = 'Salvando...';
                button.disabled = true;

                let data = Object.fromEntries(new FormData(form).entries());
                try {
                    let shouldShowSuccess = true;
                    if (form.id === 'pixSettingsForm') {
                        await this.apiRequest('/api/settings/pix', 'POST', data);
                        App.state.data.settings = { ...App.state.data.settings, ...data };
                        this.showToast('Configurações salvas com sucesso!', 'success');
                        shouldShowSuccess = false;
                    }
                    else if (form.id === 'pixelForm') {
                        const newPixel = await this.apiRequest('/api/pixels', 'POST', data);
                        if (newPixel) { this.state.data.pixels.unshift(newPixel); this.navigateTo('pixels'); }
                    }
                    else if (form.id === 'botForm') {
                        const newBot = await this.apiRequest('/api/bots', 'POST', data);
                        if (newBot) { this.state.data.bots.unshift(newBot); this.navigateTo('bots'); }
                    }
                    else if (form.id === 'presselForm') {
                        const pixel_ids = Array.from(form.querySelectorAll('input[name="pixel_ids"]:checked')).map(cb => cb.value);
                        if (pixel_ids.length === 0) {
                             this.showToast('Selecione ao menos um pixel.', 'error');
                             shouldShowSuccess = false;
                        } else {
                            const payload = { ...data, pixel_ids };
                            const newPressel = await this.apiRequest('/api/pressels', 'POST', payload);
                            if (newPressel) {
                                this.state.data.pressels.unshift(newPressel);
                                this.navigateTo('pressels');
                                this.generatePresselCode(newPressel);
                            }
                        }
                    }
                    else if (form.id === 'botFlowForm') {
                        const botId = form.dataset.botId;
                        // ATUALIZADO: Converte o valor do PIX para centavos antes de enviar
                        const pixValueFloat = parseFloat(data.flow_pix_value.replace(',', '.'));
                        const payload = {
                            ...data,
                            flow_pix_value_cents: Math.round(pixValueFloat * 100)
                        };
                        delete payload.flow_pix_value; // Remove o campo antigo

                        await this.apiRequest(`/api/bots/${botId}/flow`, 'POST', payload);
                        this.showToast('Fluxo salvo com sucesso!', 'success');
                        shouldShowSuccess = false;
                    }

                    if (shouldShowSuccess) this.showToast('Salvo com sucesso!', 'success');
                } catch(e) { /* O apiRequest já mostra a notificação de erro */ }
                finally {
                    if(button) {
                        button.innerHTML = originalButtonText;
                        button.disabled = false;
                    }
                }
            });
        },

        async apiRequest(endpoint, method = 'GET', body = null) {
            try {
                const headers = { 'Content-Type': 'application/json' };
                if (this.state.token) { headers['Authorization'] = `Bearer ${this.state.token}`; }
                const options = { method, headers };
                if (body) { options.body = JSON.stringify(body); }
                
                const response = await fetch(`${this.state.API_BASE_URL}${endpoint}`, options);
                
                if (response.status === 204) return null;
                const data = await response.json();
                if (!response.ok) throw new Error(data.message || 'Erro');
                return data;
            } catch (error) {
                this.showToast(error.message, 'error');
                if (error.message.includes('inválido') || error.message.includes('Token')) this.logout();
                throw error;
            }
        },
        
        async login(email, password) {
            try {
                const data = await this.apiRequest('/api/sellers/login', 'POST', { email, password });
                this.state.token = data.token;
                localStorage.setItem('hottrack_token', data.token);
                await this.init();
            } catch (e) {}
        },
        
        async register(name, email, password) {
            try {
                const data = await this.apiRequest('/api/sellers/register', 'POST', { name, email, password });
                this.showToast(data.message || 'Cadastro realizado! Faça o login.', 'success');
                this.renderLogin('login');
            } catch (e) {}
        },

        logout() {
            this.state.token = null;
            localStorage.removeItem('hottrack_token');
            this.init();
        },

        navigateTo(page) {
            this.state.currentPage = page;
            const contentContainer = document.getElementById('content');
            if (contentContainer && this.templates[page]) {
                contentContainer.innerHTML = this.templates[page]();
                if (page === 'dashboard') {
                    this.setupDateFilters('dashboard');
                    this.fetchDashboardMetrics();
                } else if (page === 'transactions') {
                    this.setupDateFilters('transactions');
                    this.fetchTransactions();
                }
                document.querySelectorAll('.nav-link').forEach(item => {
                    item.classList.toggle('active', item.dataset.target === page);
                });
            }
        },
        
        setupDateFilters(page) {
            const today = new Date().toISOString().split('T')[0];
            const startDateEl = document.getElementById(page === 'dashboard' ? 'startDate' : 'startDateTrans');
            const endDateEl = document.getElementById(page === 'dashboard' ? 'endDate' : 'endDateTrans');
            if (startDateEl) startDateEl.value = today;
            if (endDateEl) endDateEl.value = today;
        },

        async fetchDashboardMetrics() {
            try {
                const startDate = document.getElementById('startDate').value;
                const endDate = document.getElementById('endDate').value;
                let endpoint = '/api/dashboard/metrics';
                if (startDate && endDate) {
                    endpoint += `?startDate=${startDate}&endDate=${endDate}`;
                }
        
                const metrics = await this.apiRequest(endpoint);
                
                document.getElementById('metric-clicks').textContent = metrics.total_clicks || '0';
                document.getElementById('metric-generated').textContent = metrics.total_pix_generated || '0';
                document.getElementById('metric-paid').textContent = metrics.total_pix_paid || '0';
                document.getElementById('metric-total-revenue').textContent = `R$ ${(metrics.total_revenue || 0).toFixed(2).replace('.', ',')}`;
                document.getElementById('metric-paid-revenue').textContent = `R$ ${(metrics.paid_revenue || 0).toFixed(2).replace('.', ',')}`;
        
                const botsTableBody = document.getElementById('bots-performance-table');
                if (metrics.bots_performance && metrics.bots_performance.length > 0) {
                    botsTableBody.innerHTML = metrics.bots_performance.map(b => `
                        <tr class="hover:bg-slate-800/50">
                            <td>${b.bot_name}</td>
                            <td>${b.total_clicks || '0'}</td>
                            <td>${b.total_pix_paid || '0'}</td>
                            <td>R$ ${(b.paid_revenue || 0).toFixed(2).replace('.', ',')}</td>
                        </tr>
                    `).join('');
                } else {
                    botsTableBody.innerHTML = '<tr><td colspan="4" class="text-center text-gray-500">Nenhum resultado encontrado.</td></tr>';
                }
        
                const trafficTableBody = document.getElementById('traffic-by-state-table');
                if (metrics.clicks_by_state && metrics.clicks_by_state.length > 0) {
                    trafficTableBody.innerHTML = metrics.clicks_by_state.map(s => `
                        <tr class="hover:bg-slate-800/50">
                            <td>${s.state}</td>
                            <td>${s.total_clicks}</td>
                        </tr>
                    `).join('');
                } else {
                    trafficTableBody.innerHTML = '<tr><td colspan="2" class="text-center text-gray-500">Nenhum resultado encontrado.</td></tr>';
                }
                
            } catch (e) {
                console.error("Erro ao carregar métricas do painel:", e);
                this.showToast("Não foi possível carregar as métricas do painel.", 'error');
            }
        },
        
        async fetchTransactions() {
            try {
                const startDate = document.getElementById('startDateTrans').value;
                const endDate = document.getElementById('endDateTrans').value;
                let endpoint = '/api/transactions';
                if (startDate && endDate) {
                    endpoint += `?startDate=${startDate}&endDate=${endDate}`;
                }

                const transactions = await this.apiRequest(endpoint);
                const transactionsTableBody = document.getElementById('transactions-table');
                
                if (transactions && transactions.length > 0) {
                    transactionsTableBody.innerHTML = transactions.map(t => {
                        const statusColor = t.status === 'paid' ? 'text-green-400' : 'text-yellow-400';
                        return `
                            <tr class="hover:bg-slate-800/50">
                                <td>${t.pix_id.substring(0, 8)}...</td>
                                <td>R$ ${t.pix_value.toFixed(2).replace('.', ',')}</td>
                                <td class="${statusColor}">${t.status === 'paid' ? 'Pago' : 'Pendente'}</td>
                                <td>${t.bot_name || 'N/A'}</td>
                                <td>${t.click_id || 'N/A'}</td>
                                <td>${new Date(t.created_at).toLocaleString('pt-BR')}</td>
                            </tr>
                        `;
                    }).join('');
                } else {
                    transactionsTableBody.innerHTML = '<tr><td colspan="6" class="text-center text-gray-500">Nenhuma transação encontrada.</td></tr>';
                }
            } catch (e) {
                console.error("Erro ao carregar transações:", e);
                this.showToast("Não foi possível carregar as transações.", 'error');
                document.getElementById('transactions-table').innerHTML = '<tr><td colspan="6" class="text-center text-red-400">Erro ao carregar transações.</td></tr>';
            }
        },

        generatePresselCode(pressel) {
            const { settings, pixels } = this.state.data;
            const sellerApiKey = settings.api_key;
            if (!sellerApiKey) {
                return this.showToast("Erro: API Key do vendedor não encontrada. Tente recarregar a página.", 'error');
            }
            const selectedPixels = pixels.filter(p => (pressel.pixel_ids || []).some(id => id == p.id));
            const pixelsToTrackString = JSON.stringify(selectedPixels.map(p => ({ id: p.pixel_id })), null, 2);
            const noscriptPixelsString = selectedPixels.map(p => `<img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${p.pixel_id}&ev=PageView&noscript=1"/>`).join('\\n    ');
            const code = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${pressel.name}</title>
    <script>
        const API_BASE_URL = '${this.state.API_BASE_URL}';
        const SELLER_API_KEY = '${sellerApiKey}';
        const PRESSEL_ID = ${pressel.id};
        const TELEGRAM_USERNAME = '${pressel.bot_name}';
        const WHITE_PAGE_URL = '${pressel.white_page_url}';
        const PIXELS_TO_TRACK = ${pixelsToTrackString};
        
        const isBot=()=>/bot|facebook|crawler|spider|preview/i.test(navigator.userAgent),isMobile=()=>/android|iphone|ipad|ipod/i.test(navigator.userAgent);
        async function handleRedirect(){if(isBot()||!isMobile()){window.location.replace(WHITE_PAGE_URL);return}
        try{const t=new URLSearchParams(window.location.search),e=await fetch(\`\${API_BASE_URL}/api/registerClick\`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sellerApiKey:SELLER_API_KEY,presselId:PRESSEL_ID,referer:document.referrer||null,fbclid:t.get("fbclid")||null,fbp:document.cookie.match(/_fbp=([^;]+)/)?.[1]||null,fbc:document.cookie.match(/_fbc=([^;]+)/)?.[1]||null,user_agent:navigator.userAgent})}),a=await e.json();e.ok&&"success"===a.status?window.location.replace(\`https://t.me/\${TELEGRAM_USERNAME}?start=\${a.click_id}\`):window.location.replace(WHITE_PAGE_URL)}catch(t){window.location.replace(WHITE_PAGE_URL)}}
        handleRedirect();
    <\/script>
    <script>
        !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src='https://connect.facebook.net/en_US/fbevents.js';s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script');
        PIXELS_TO_TRACK.forEach(p => { fbq('init', p.id); });
        fbq('track', 'PageView');
    <\/script>
    <noscript>${noscriptPixelsString}</noscript>
</head>
<body><p>Redirecionando...</p></body>
</html>`;
            const modalContainer = document.getElementById('modal-container');
            const encodedCode = code.trim().replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const modalContent = `
                <textarea id="presselCode" readonly class="form-input w-full h-64 text-xs bg-slate-900/50">${encodedCode}</textarea>
                <div class="mt-4 flex justify-end">
                    <button id="copyCodeBtn" class="btn">Copiar Código</button>
                </div>`;
            modalContainer.innerHTML = this.templates.modal('Código da Pressel Gerado', modalContent);
        },

        showToast(message, type = 'success') {
            const toast = document.createElement('div');
            toast.textContent = message;
            const bgColor = type === 'error' ? 'bg-red-600' : 'bg-green-600';
            toast.className = `fixed bottom-5 right-5 text-white py-3 px-5 rounded-lg shadow-lg ${bgColor} animate-fade-in z-50`;
            document.body.appendChild(toast);
            setTimeout(() => {
                toast.style.opacity = 0;
                toast.style.transition = 'all 0.3s ease-out';
                toast.style.transform = 'translateY(20px)';
                setTimeout(() => toast.remove(), 300);
            }, 3000);
        },

        async openBotFlowModal(bot) {
            const modalContainer = document.getElementById('modal-container');
            modalContainer.innerHTML = this.templates.botFlowModal(bot);
            
            try {
                const flowData = await this.apiRequest(`/api/bots/${bot.id}/flow`);
                const form = document.getElementById('botFlowForm');
                if(form && flowData) {
                    form.elements.flow_image_url.value = flowData.flow_image_url || '';
                    form.elements.flow_text.value = flowData.flow_text || '';
                    form.elements.flow_button_pix_text.value = flowData.flow_button_pix_text || '✅ Gerar PIX';
                    form.elements.flow_button_check_text.value = flowData.flow_button_check_text || '🔎 Consultar PIX';
                    // ATUALIZADO: Converte centavos para Reais para exibir no campo
                    if (flowData.flow_pix_value_cents) {
                        form.elements.flow_pix_value.value = (flowData.flow_pix_value_cents / 100).toFixed(2);
                    } else {
                        form.elements.flow_pix_value.value = '';
                    }
                }
            } catch (err) {
                 this.showToast('Não foi possível carregar os dados do fluxo.', 'error');
                 modalContainer.innerHTML = '';
            }
        }
    };

    App.init();

    document.addEventListener('contextmenu', event => event.preventDefault());
    document.addEventListener('keydown', function(e) {
        if (e.key === 'F12' || 
           (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C')) || 
           (e.ctrlKey && e.key === 'U') ||
           (e.metaKey && e.altKey && (e.key === 'I' || e.key === 'J' || e.key === 'C'))) {
            e.preventDefault();
        }
    });
    </script>
</body>
</html>

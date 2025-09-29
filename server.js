<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Hotbot - Plataforma de Gestão Avançada</title>

  <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <script src="https://unpkg.com/reactflow@11/dist/umd/index.js"></script>
  <script src="https://unpkg.com/axios/dist/axios.min.js"></script>
  <link href="https://unpkg.com/reactflow@11/dist/style.css" rel="stylesheet">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">

  <style>
    :root {
        --bg-primary: #111111; --bg-secondary: #1A1A1A; --bg-tertiary: #242424;
        --border-color: #2D2D2D; --text-primary: #E5E5E5; --text-secondary: #A3A3A3;
        --brand-primary: #00F5A0; --brand-secondary: #00B372;
        --danger-bg: #441C24; --danger-text: #F87171; --danger-border: #7f1d1d;
        --danger-hover-bg: #7f1d1d; --danger-hover-text: white;
        --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html,body,#root { height: 100%; font-family: var(--font-sans); }
    body { background: var(--bg-primary); color: var(--text-primary); -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
    * { scrollbar-width: thin; scrollbar-color: var(--border-color) var(--bg-primary); }
    *::-webkit-scrollbar { width: 8px; } *::-webkit-scrollbar-track { background: var(--bg-primary); }
    *::-webkit-scrollbar-thumb { background-color: var(--border-color); border-radius: 10px; border: 2px solid var(--bg-primary); }
    .app-container { display: flex; height: 100vh; }
    .main-content {
        flex: 1; height: 100vh; overflow-y: auto;
        background-image: radial-gradient(var(--border-color) 1px, transparent 1px);
        background-size: 2rem 2rem;
    }
    .page-container { animation: fadeIn 0.5s ease-in-out; height: 100%; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    .sidebar { width: 80px; background: var(--bg-secondary); border-right: 1px solid var(--border-color); padding: 1.5rem 0; display: flex; flex-direction: column; align-items: center; transition: width 0.3s ease-in-out; z-index: 20; }
    .sidebar:hover { width: 240px; }
    .sidebar .logo { font-size: 1.8rem; margin-bottom: 3.5rem; color: var(--text-primary); font-weight: 800; letter-spacing: 1px; }
    .sidebar .logo span { color: var(--brand-primary); }
    .sidebar .logo .logo-text { opacity: 0; transition: opacity 0.3s ease-in-out; }
    .sidebar:hover .logo .logo-text { opacity: 1; }
    .nav-menu { display: flex; flex-direction: column; gap: 0.75rem; width: 100%; }
    .nav-item { display: flex; align-items: center; justify-content: flex-start; gap: 1rem; padding: 1rem 1.75rem; cursor: pointer; transition: all 0.2s ease-in-out; border-left: 4px solid transparent; color: var(--text-secondary); }
    .nav-item:hover { background: linear-gradient(90deg, rgba(0, 245, 160, 0.1), transparent); color: var(--text-primary); }
    .nav-item.active { color: var(--brand-primary); border-left: 4px solid var(--brand-primary); }
    .nav-item .nav-text { opacity: 0; white-space: nowrap; transform: translateX(-10px); transition: opacity 0.2s ease-in-out, transform 0.2s ease-in-out; font-weight: 600; }
    .sidebar:hover .nav-text { opacity: 1; transform: translateX(0); }
    .nav-item svg { min-width: 24px; min-height: 24px; transition: all 0.2s ease-in-out; }
    .nav-item.active svg { filter: drop-shadow(0 0 8px var(--brand-primary)); }
    .sidebar .logout-btn { margin-top: auto; width: 100%; }
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2.5rem; }
    .page-header h2 { font-size: 2.25rem; font-weight: 800; }
    .card { background: var(--bg-secondary); padding: 2rem; border-radius: 12px; border: 1px solid var(--border-color); box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
    .form-group { margin-bottom: 1.5rem; }
    .form-group label { display: block; margin-bottom: 0.75rem; font-weight: 600; color: var(--text-secondary); font-size: 0.9rem; }
    .form-input, .form-select, .form-textarea { width: 100%; padding: 0.85rem 1.1rem; border-radius: 8px; border: 1px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary); font-size: 1rem; transition: border-color 0.2s, box-shadow 0.2s; }
    .form-input:focus, .form-select:focus, .form-textarea:focus { outline: none; border-color: var(--brand-primary); box-shadow: 0 0 0 4px rgba(0, 245, 160, 0.2); }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; padding: 0.8rem 1.6rem; border-radius: 8px; border: none; cursor: pointer; font-weight: 700; transition: all 0.2s ease-in-out; text-transform: uppercase; letter-spacing: 0.8px; font-size: 0.9rem; }
    .btn:hover { transform: translateY(-3px); box-shadow: 0 6px 20px rgba(0,0,0,0.3); }
    .btn:disabled { background-color: var(--bg-tertiary); color: var(--text-secondary); cursor: not-allowed; transform: none; box-shadow: none; }
    .btn-primary { background: var(--brand-primary); color: #000; box-shadow: 0 4px 15px rgba(0, 245, 160, 0.2); }
    .btn-danger { background-color: var(--danger-bg); color: var(--danger-text); border: 1px solid var(--danger-border);}
    .btn-danger:hover { background-color: var(--danger-hover-bg); color: var(--danger-hover-text); }
    .btn-secondary { background-color: var(--bg-tertiary); color: var(--text-secondary); border: 1px solid var(--border-color); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 2rem; }
    .bot-card { background: var(--bg-secondary); border-radius: 12px; border: 1px solid var(--border-color); padding: 1.5rem; display: flex; flex-direction: column; transition: all 0.2s ease-in-out; }
    .bot-card:hover { transform: translateY(-5px); border-color: var(--brand-primary); box-shadow: 0 8px 30px rgba(0, 245, 160, 0.1); }
    .bot-card-header { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; }
    .bot-card-header .icon { background: var(--bg-primary); padding: 0.75rem; border-radius: 8px; }
    .bot-card-header h3 { font-size: 1.25rem; font-weight: 700; }
    .bot-card-actions { margin-top: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
    .login-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 100; backdrop-filter: blur(10px); }
    .login-box { background: var(--bg-secondary); padding: 3rem; border-radius: 12px; width: 420px; border: 1px solid var(--border-color); }
    .chat-page-layout { height: 100%; padding: 0; }
    .chat-container { display: flex; height: calc(100vh - 8.5rem); background: var(--bg-secondary); border-radius: 12px; border: 1px solid var(--border-color); overflow: hidden; }
    .conversations-panel { width: 320px; border-right: 1px solid var(--border-color); display: flex; flex-direction: column; }
    .conversations-header { padding: 1rem; border-bottom: 1px solid var(--border-color); }
    .conversations-list { flex: 1; overflow-y: auto; }
    .conversation-item { padding: 1rem; cursor: pointer; border-bottom: 1px solid var(--border-color); border-left: 4px solid transparent; }
    .conversation-item:hover { background: var(--bg-tertiary); }
    .conversation-item.active { background: var(--bg-primary); border-left-color: var(--brand-primary); }
    .conversation-item-name { font-weight: 600; color: var(--text-primary); }
    .conversation-item-preview { font-size: 0.9rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chat-window { flex: 1; display: flex; flex-direction: column; }
    .chat-header { padding: 1rem; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color); background: var(--bg-secondary); }
    .chat-header h3 { font-size: 1.1rem; }
    .message-list { flex: 1; padding: 1.5rem; overflow-y: auto; display: flex; flex-direction: column; gap: 1rem; }
    .message-bubble { max-width: 70%; padding: 0.75rem 1.25rem; border-radius: 18px; line-height: 1.5; word-wrap: break-word; }
    .message-bubble strong { display: block; margin-bottom: 0.25rem; font-size: 0.8rem; }
    .message-bubble-time { font-size: 0.75rem; opacity: 0.7; margin-top: 0.5rem; text-align: right; }
    .message-user { background: var(--bg-tertiary); align-self: flex-start; border-bottom-left-radius: 4px; }
    .message-operator { background: var(--brand-primary); color: #000; align-self: flex-end; border-bottom-right-radius: 4px; }
    .chat-input-area { border-top: 1px solid var(--border-color); padding: 1rem; background: var(--bg-secondary); }
    .chat-input-form { display: flex; align-items: center; gap: 1rem; }
    .chat-input { flex: 1; }
    .contact-panel { width: 320px; border-left: 1px solid var(--border-color); background: var(--bg-primary); padding: 1.5rem; overflow-y: auto; }
    .contact-panel h3 { margin-bottom: 1.5rem; font-size: 1.2rem; }
    .contact-detail { margin-bottom: 1.25rem; }
    .contact-detail label { font-size: 0.8rem; color: var(--text-secondary); font-weight: 600; margin-bottom: 0.25rem; display: block; }
    .contact-detail p { font-size: 0.95rem; color: var(--text-primary); word-wrap: break-word; }
    .centered-placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; color: var(--text-secondary); }
    .centered-placeholder svg { margin-bottom: 1rem; }
    .flow-editor-page { display: flex; flex-direction: column; height: 100vh; background: #fff; color: #333; }
    .flow-editor-container { flex: 1; display: flex; overflow: hidden; }
    .reactflow-wrapper { flex-grow: 1; position: relative; background-color: #f8f9fa; background-image: radial-gradient(#dee2e6 1px, transparent 0); background-size: 30px 30px;}
    .flow-header { padding: 1rem 1.5rem; background: white; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e9ecef; z-index: 11; }
    .flow-sidebar { width: 280px; background: white; border-right: 1px solid #e9ecef; padding: 1rem; overflow-y: auto; }
    .flow-sidebar h3 { margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid #e9ecef; font-size: 1.1rem; }
    .node-button { display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem; border-radius: 8px; border: 1px solid #dee2e6; text-align: left; cursor: grab; margin-bottom: 0.75rem; transition: all 0.2s; color: #495057; }
    .node-button:hover { border-color: var(--brand-primary); color: var(--brand-secondary); background: #f1f3f5; }
    .editor-panel { position: absolute; top: 0; right: 0; width: 350px; height: 100%; background: white; z-index: 10; padding: 1.5rem; border-left: 1px solid #e9ecef; overflow-y: auto; }
    .react-flow__node { background: white; border: 1px solid #adb5bd; border-radius: 8px; padding: 0; width: 280px; font-family: var(--font-sans); box-shadow: 0 4px 10px rgba(0,0,0,0.05); color: #343a40; }
    .react-flow__node.selected { border: 2px solid var(--brand-primary); box-shadow: 0 0 15px rgba(0, 245, 160, 0.5); }
    .node-header { display: flex; align-items: center; gap: 0.75rem; font-weight: 600; padding: 0.75rem 1rem; border-bottom: 1px solid #e9ecef; }
    .node-content { padding: 1rem; font-size: 0.9rem; color: #6c757d; }
    .react-flow__handle { width: 12px; height: 12px; background: white; border: 2px solid #adb5bd; }
    .react-flow__handle:hover { border-color: var(--brand-primary); }
    .node-header { color: #212529; }
    .react-flow__node-trigger .node-header { background: #e7f5ff; }
    .react-flow__node-message .node-header { background: #e6fcf5; }
    .react-flow__node-image .node-header { background: #f3e8ff; }
    .react-flow__node-video .node-header { background: #f3e8ff; }
    .react-flow__node-audio .node-header { background: #f3e8ff; }
    .react-flow__node-delay .node-header { background: #fff9db; }
    .react-flow__node-action_pix .node-header { background: #dcfce7; }
    .react-flow__node-action_check_pix .node-header { background: #ffedd5; }
    .react-flow__node-action_city .node-header { background: #e0f2fe; }
    .react-flow__node-forward_flow .node-header { background: #eef2ff; }
    .handle-label { position: absolute; font-size: 11px; color: #6c757d; background: white; padding: 2px 6px; border-radius: 4px; bottom: -24px; border: 1px solid #e9ecef; }
  </style>
</head>
<body>
  <div id="root"></div>

  <script type="text/babel">
    const { useState, useCallback, useEffect, useRef, memo } = React;
    const { ReactFlowProvider, ReactFlow, useNodesState, useEdgesState, addEdge, Background, Controls, Handle, Position, MarkerType } = window.ReactFlow;
    
    const API_BASE_URL = 'https://hottrack.vercel.app/api';

    const api = axios.create({ baseURL: API_BASE_URL });
    
    api.interceptors.request.use(
      config => {
        const token = localStorage.getItem('authToken');
        if (token) {
          config.headers['Authorization'] = `Bearer ${token}`;
        }
        return config;
      },
      error => {
        return Promise.reject(error);
      }
    );
    
    const Icons = {
        bots: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8V4H8"/><rect x="4" y="12" width="16" height="8" rx="2"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M17 12v-2a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>,
        flows: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12h3"/><path d="M7 12h3"/><path d="M12 12h3"/><path d="M17 12h3"/><path d="M5 7v10"/><path d="M10 7v10"/><path d="M15 7v10"/><path d="M20 7v10"/><path d="M5 12a5 5 0 0 0 5 5"/><path d="M10 12a5 5 0 0 1 5 5"/><path d="M15 12a5 5 0 0 0 5-5"/></svg>,
        chat: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
        disparos: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>,
        logout: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
        send: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>,
        text: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 6.1H3"/><path d="M21 12.1H3"/><path d="M15.1 18H3"/></svg>,
        image: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>,
        video: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2" ry="2"/></svg>,
        audio: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5v14M7 5v14"/></svg>,
        delay: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>,
        pix: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 15a5 5 0 1 1 5-5 5 5 0 0 1-5 5z"/><path d="M12 8.5v7"/></svg>,
        forward: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>
    };

    function App() {
      const [isAuthenticated, setIsAuthenticated] = useState(false);
      const [isLoading, setIsLoading] = useState(true);
      const [apiError, setApiError] = useState(null); // Estado para erro de API
      const [currentPage, setCurrentPage] = useState('bots');
      const [editingFlow, setEditingFlow] = useState(null);

      useEffect(() => {
        const token = localStorage.getItem('authToken');
        if (token) {
          api.get('/dashboard/data')
            .then(() => setIsAuthenticated(true))
            .catch((err) => {
              localStorage.removeItem('authToken');
              setIsAuthenticated(false);
              if (err.code === "ERR_NETWORK") {
                setApiError("Não foi possível conectar à API. Verifique se o servidor backend está no ar e acessível.");
              }
            })
            .finally(() => setIsLoading(false));
        } else {
          setIsLoading(false);
        }
      }, []);
      
      const handleLogin = (token) => { 
          localStorage.setItem('authToken', token); 
          setIsAuthenticated(true); 
          setApiError(null); // Limpa erros anteriores ao logar
      };
      const handleLogout = () => { 
          localStorage.removeItem('authToken'); 
          setIsAuthenticated(false); 
      };

      const navigateToFlowEditor = (flow) => { setEditingFlow(flow); setCurrentPage('flow-editor'); };

      if (isLoading) {
        return <div style={{display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh'}}><svg style={{width: '50px', height: '50px', animation: 'spin 1s linear infinite'}} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="var(--brand-primary)" strokeWidth="4" fill="none" strokeDasharray="15 80"></circle></svg></div>;
      }

      if (apiError) {
        return <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', padding: '2rem', textAlign: 'center'}}>
            <h2 style={{color: 'var(--danger-text)', fontSize: '1.5rem'}}>Erro de Conexão</h2>
            <p style={{color: 'var(--text-secondary)', marginTop: '1rem'}}>{apiError}</p>
            <button className="btn btn-primary" style={{marginTop: '2rem'}} onClick={() => window.location.reload()}>Tentar Novamente</button>
        </div>;
      }

      if (!isAuthenticated) { 
        return <LoginScreen onLogin={handleLogin} />; 
      }

      const PageComponent = {
        bots: <BotsPage />,
        flows: <FlowsListPage onEditFlow={navigateToFlowEditor} />,
        chat: <LiveChatPage />,
        disparos: <DisparosPage />,
        'flow-editor': <FlowEditorPage flow={editingFlow} onBack={() => setCurrentPage('flows')} />
      }[currentPage];

      return (
        <div className="app-container">
          <Sidebar currentPage={currentPage} setCurrentPage={setCurrentPage} onLogout={handleLogout} />
          <main className="main-content" style={{padding: 0, height: '100vh', width: '100%', overflow: 'hidden'}}>
            <div className="page-container" style={{height: '100%'}}>
                {PageComponent}
            </div>
          </main>
        </div>
      );
    }
    
    function Sidebar({ currentPage, setCurrentPage, onLogout }) {
        const pages = { bots: 'Bots', flows: 'Fluxos', chat: 'Chat ao Vivo', disparos: 'Disparos' };
        return (
            <aside className="sidebar">
                <div className="logo">H<span className="logo-text">otbot</span></div>
                <nav className="nav-menu">
                    {Object.entries(pages).map(([key, value]) => (
                        <div key={key} className={`nav-item ${currentPage === key ? 'active' : ''}`} onClick={() => setCurrentPage(key)} title={value}>
                            {Icons[key]} <span className="nav-text">{value}</span>
                        </div>
                    ))}
                </nav>
                <div className="logout-btn nav-item" onClick={onLogout} title="Sair">
                    {Icons.logout} <span className="nav-text">Sair</span>
                </div>
            </aside>
        );
    }
    
    function BotsPage() {
      const [bots, setBots] = useState([]);
      const [newBotName, setNewBotName] = useState('');
      const fetchBots = async () => { try { const res = await api.get('/dashboard/data'); setBots(res.data.bots || []); } catch (e) { console.error("Erro", e); } };
      useEffect(() => { fetchBots(); }, []);
      const handleCreateBot = async (e) => { e.preventDefault(); if (!newBotName) return; try { await api.post('/bots', { bot_name: newBotName }); setNewBotName(''); fetchBots(); } catch (e) { alert('Erro: ' + (e.response?.data?.message || '')); } };
      const handleDeleteBot = async (id) => { if (confirm('Certeza?')) { try { await api.delete(`/bots/${id}`); fetchBots(); } catch (e) { alert('Erro'); } } };
      const handleUpdateToken = async (id) => { const token = prompt("Token:"); if (token) { try { await api.put(`/bots/${id}`, { bot_token: token }); alert("OK"); fetchBots(); } catch (e) { alert('Erro: ' + (e.response?.data?.message || '')); } } };
      const handleSetWebhook = async (id) => { try { const res = await api.post(`/bots/${id}/set-webhook`); alert(res.data.message); } catch (e) { alert('Falha.'); } };
      return (
          <div style={{padding: '2rem 3rem', height: '100%', overflowY: 'auto'}}>
            <div className="page-header"><h2>Gerenciamento de Bots</h2><button className="btn btn-primary" onClick={() => document.getElementById('botName').focus()}>+ Adicionar Bot</button></div>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '2rem', alignItems: 'start'}}>
                <div className="card"><h3 style={{color: 'var(--text-primary)'}}>Adicionar Novo Bot</h3><p style={{color: 'var(--text-secondary)', marginBottom: '1.5rem', fontSize: '0.9rem'}}>Crie e configure novos bots.</p><form onSubmit={handleCreateBot}><div className="form-group"><label htmlFor="botName">Nome de usuário</label><input id="botName" className="form-input" value={newBotName} onChange={(e) => setNewBotName(e.target.value)} placeholder="@meu_bot"/></div><button className="btn btn-primary" type="submit" style={{width: '100%'}}>Criar</button></form></div>
                <div>
                    <h3 style={{marginBottom: '1rem', fontSize: '1.5rem', color: 'var(--text-primary)'}}>Bots Ativos</h3>
                    <div className="grid">
                        {bots.map(bot => (<div key={bot.id} className="bot-card"><div className="bot-card-header"><div className="icon">{Icons.bots}</div><h3>{bot.bot_name}</h3></div><p style={{color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1.5rem', flexGrow: 1}}>Gerencie as configurações.</p><div className="bot-card-actions"><button className="btn btn-secondary btn-sm" onClick={() => handleSetWebhook(bot.id)}>Webhook</button><button className="btn btn-secondary btn-sm" onClick={() => handleUpdateToken(bot.id)}>Token</button><button className="btn btn-danger btn-sm" style={{gridColumn: '1 / -1'}} onClick={() => handleDeleteBot(bot.id)}>Excluir</button></div></div>))}
                        {bots.length === 0 && <p style={{color: 'var(--text-secondary)'}}>Nenhum bot criado.</p>}
                    </div>
                </div>
            </div>
          </div>
        );
    }
    
    function FlowsListPage({ onEditFlow }) {
        const [bots, setBots] = useState([]);
        const [selectedBotId, setSelectedBotId] = useState('');
        const [flows, setFlows] = useState([]);
        useEffect(() => { const fetch = async () => { try { const res = await api.get('/dashboard/data'); const d = res.data.bots || []; setBots(d); if(d.length > 0) setSelectedBotId(d[0].id); } catch(e){ console.error("Erro", e); } }; fetch(); }, []);
        const fetchFlows = useCallback(async () => { if (!selectedBotId) { setFlows([]); return; } try { const res = await api.get('/flows'); setFlows(res.data.filter(f => f.bot_id == selectedBotId)); } catch (e) { console.error("Erro", e); } }, [selectedBotId]);
        useEffect(() => { fetchFlows(); }, [fetchFlows]);
        const handleCreate = async () => { const n = prompt("Nome:"); if(n && selectedBotId) { try { await api.post('/flows', { name: n, botId: selectedBotId }); fetchFlows(); } catch (e) { alert("Erro"); } } };
        const handleDelete = async (id) => { if (confirm("Certeza?")) { try { await api.delete(`/flows/${id}`); fetchFlows(); } catch (e) { alert("Erro"); } } };
        return (
            <div style={{padding: '2rem 3rem', height: '100%', overflowY: 'auto'}}>
                <div className="page-header"><h2>Fluxos de Conversa</h2><button className="btn btn-primary" onClick={handleCreate} disabled={!selectedBotId}>+ Novo Fluxo</button></div>
                <div className="form-group" style={{maxWidth: '400px', marginBottom: '2rem'}}><label htmlFor="botSelect">Selecione um Bot</label><select id="botSelect" className="form-select" value={selectedBotId} onChange={e => setSelectedBotId(e.target.value)}><option value="">-- Selecione --</option>{bots.map(b => <option key={b.id} value={b.id}>{b.bot_name}</option>)}</select></div>
                <div className="grid">
                    {flows.map(flow => (
                        <div key={flow.id} className="bot-card">
                           <div className="bot-card-header"><div className="icon">{Icons.flows}</div><h3>{flow.name}</h3></div>
                           <p style={{color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1.5rem', flexGrow: 1}}>Modificado em: {new Date(flow.updated_at).toLocaleDateString()}</p>
                            <div className="bot-card-actions">
                                <button className="btn btn-primary btn-sm" onClick={() => onEditFlow(flow)}>Editor</button>
                                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(flow.id)}>Excluir</button>
                            </div>
                        </div>
                    ))}
                    {flows.length === 0 && selectedBotId && <p style={{color: 'var(--text-secondary)'}}>Nenhum fluxo para este bot.</p>}
                </div>
            </div>
        );
    }

    function DisparosPage() {
        const [bots, setBots] = useState([]);
        const [selectedBotIds, setSelectedBotIds] = useState([]);
        const [formData, setFormData] = useState({
            initialText: '',
            ctaButtonText: '',
            externalLink: '',
            imageUrl: ''
        });
        const [isSending, setIsSending] = useState(false);

        useEffect(() => {
            const fetchBots = async () => {
                try {
                    const res = await api.get('/dashboard/data');
                    setBots(res.data.bots || []);
                } catch (e) {
                    console.error("Erro ao buscar bots", e);
                }
            };
            fetchBots();
        }, []);

        const handleBotSelection = (botId) => {
            setSelectedBotIds(prev =>
                prev.includes(botId) ? prev.filter(id => id !== botId) : [...prev, botId]
            );
        };

        const handleInputChange = (e) => {
            const { name, value } = e.target;
            setFormData(prev => ({ ...prev, [name]: value }));
        };

        const handleSubmit = async (e) => {
            e.preventDefault();
            if (selectedBotIds.length === 0 || !formData.initialText || !formData.ctaButtonText || !formData.externalLink) {
                alert('Por favor, preencha todos os campos obrigatórios e selecione ao menos um bot.');
                return;
            }
            setIsSending(true);
            try {
                const payload = {
                    botIds: selectedBotIds,
                    ...formData
                };
                const response = await api.post('/bots/mass-send', payload);
                alert(response.data.message);
            } catch (error) {
                alert('Erro ao enviar disparo: ' + (error.response?.data?.message || error.message));
            } finally {
                setIsSending(false);
            }
        };

        return (
            <div style={{ padding: '2rem 3rem', height: '100%', overflowY: 'auto' }}>
                <div className="page-header">
                    <h2>Disparo em Massa</h2>
                </div>
                <div className="card" style={{ maxWidth: '800px', margin: '0 auto' }}>
                    <form onSubmit={handleSubmit}>
                        <div className="form-group">
                            <label>Selecione os Bots de Destino</label>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
                                {bots.map(bot => (
                                    <label key={bot.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                                        <input
                                            type="checkbox"
                                            checked={selectedBotIds.includes(bot.id)}
                                            onChange={() => handleBotSelection(bot.id)}
                                        />
                                        {bot.bot_name}
                                    </label>
                                ))}
                            </div>
                        </div>

                        <div className="form-group">
                            <label htmlFor="initialText">Texto da Mensagem</label>
                            <textarea id="initialText" name="initialText" className="form-textarea" rows="4" value={formData.initialText} onChange={handleInputChange} required />
                        </div>

                        <div className="form-group">
                            <label htmlFor="imageUrl">URL da Imagem (Opcional)</label>
                            <input id="imageUrl" name="imageUrl" type="url" className="form-input" value={formData.imageUrl} onChange={handleInputChange} placeholder="https://exemplo.com/imagem.png" />
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                            <div className="form-group">
                                <label htmlFor="ctaButtonText">Texto do Botão</label>
                                <input id="ctaButtonText" name="ctaButtonText" type="text" className="form-input" value={formData.ctaButtonText} onChange={handleInputChange} required />
                            </div>
                            <div className="form-group">
                                <label htmlFor="externalLink">URL do Botão</label>
                                <input id="externalLink" name="externalLink" type="url" className="form-input" value={formData.externalLink} onChange={handleInputChange} required />
                            </div>
                        </div>

                        <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={isSending}>
                            {isSending ? 'Enviando...' : 'Iniciar Disparo'}
                        </button>
                    </form>
                </div>
            </div>
        );
    }
    
    function LiveChatPage() {
        const [bots, setBots] = useState([]);
        const [selectedBotId, setSelectedBotId] = useState('');
        const [users, setUsers] = useState([]);
        const [filteredUsers, setFilteredUsers] = useState([]);
        const [selectedChat, setSelectedChat] = useState(null);
        const [messages, setMessages] = useState([]);
        const [newMessage, setNewMessage] = useState('');
        const [searchTerm, setSearchTerm] = useState('');
        const messagesEndRef = useRef(null);
        useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
        useEffect(() => { const fetch = async () => { const { data } = await api.get('/dashboard/data'); setBots(data.bots || []); if (data.bots && data.bots.length > 0) { setSelectedBotId(data.bots[0].id); } }; fetch(); }, []);
        const fetchUsers = useCallback(async () => { if (!selectedBotId) return; setUsers([]); setFilteredUsers([]); setMessages([]); setSelectedChat(null); try { const { data } = await api.get(`/chats/${selectedBotId}`); setUsers(data); setFilteredUsers(data); } catch (e) { console.error("Erro", e); } }, [selectedBotId]);
        useEffect(() => { fetchUsers(); }, [fetchUsers]);
        const fetchMessages = useCallback(async () => { if (!selectedBotId || !selectedChat?.chat_id) return; try { const { data } = await api.get(`/chats/${selectedBotId}/${selectedChat.chat_id}`); setMessages(data); } catch (e) { console.error("Erro", e); setMessages([]); } }, [selectedBotId, selectedChat]);
        useEffect(() => { if (selectedChat) { fetchMessages(); } }, [fetchMessages, selectedChat]);
        useEffect(() => { const res = users.filter(u => ((u.first_name || '') + ' ' + (u.last_name || '')).toLowerCase().includes(searchTerm.toLowerCase()) || (u.chat_id || '').toString().includes(searchTerm) || (u.click_id || '').toLowerCase().includes(searchTerm.toLowerCase())); setFilteredUsers(res); }, [searchTerm, users]);
        const handleSend = async (e) => { e.preventDefault(); const txt = newMessage.trim(); if (!txt || !selectedChat) return; const opt = { message_id: Date.now(), first_name: "Você", sender_type: 'operator', message_text: txt, created_at: new Date().toISOString() }; setMessages(p => [...p, opt]); setNewMessage(''); try { await api.post(`/chats/${selectedBotId}/send-message`, { chatId: selectedChat.chat_id, text: txt }); fetchMessages(); } catch (e) { console.error("Erro", e); alert('Erro.'); setMessages(p => p.filter(m => m.message_id !== opt.message_id)); } };
        const handleDelete = async (id) => { if (confirm(`Certeza?`)) { try { await api.delete(`/chats/${selectedBotId}/${id}`); alert('OK'); fetchUsers(); if (selectedChat?.chat_id === id) { setSelectedChat(null); } } catch (e) { alert('Erro'); } } };
        const getDisplayName = (u) => { if (!u) return ''; if (u.click_id) return u.click_id.replace('/start ', ''); return `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'Desconhecido'; };
        return (
            <div className="chat-page-layout">
                <div style={{display: 'flex', flexDirection: 'column', height: '100%'}}>
                    <div className="page-header" style={{padding: '2rem 3rem 2rem 3rem', margin: 0}}><h2>Chat ao Vivo</h2><div className="form-group" style={{ marginBottom: 0, minWidth: '300px' }}><select id="botSelectChat" className="form-select" value={selectedBotId} onChange={e => setSelectedBotId(e.target.value)}><option value="">-- Selecione um Bot --</option>{bots.map(b => <option key={b.id} value={b.id}>{b.bot_name}</option>)}</select></div></div>
                    <div className="chat-container" style={{height: 'calc(100vh - 8.5rem)', margin: '0 3rem 2rem 3rem'}} >
                        <div className="conversations-panel"><div className="conversations-header"><input type="text" className="form-input" placeholder="Buscar..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} /></div><div className="conversations-list">{filteredUsers.map(u => (<div key={u.chat_id} className={`conversation-item ${selectedChat?.chat_id === u.chat_id ? 'active' : ''}`} onClick={() => setSelectedChat(u)}><div className="conversation-item-name">{getDisplayName(u)}</div><p className="conversation-item-preview">{u.message_text}</p></div>))}</div></div>
                        <div className="chat-window">{selectedChat ? (<><div className="chat-header"><h3>{getDisplayName(selectedChat)}</h3><button className="btn btn-danger btn-sm" onClick={() => handleDelete(selectedChat.chat_id)}>Excluir</button></div><div className="message-list">{messages.map((m, i) => (<div key={m.message_id || i} className={`message-bubble ${m.sender_type === 'operator' ? 'message-operator' : 'message-user'}`}><strong>{m.sender_type === 'operator' ? 'Você' : m.first_name}</strong>{m.message_text}<div className="message-bubble-time">{new Date(m.created_at).toLocaleTimeString()}</div></div>))}<div ref={messagesEndRef} /></div><div className="chat-input-area"><form onSubmit={handleSend} className="chat-input-form"><input className="form-input chat-input" value={newMessage} onChange={e => setNewMessage(e.target.value)} placeholder="Digite..." /><button className="btn btn-primary" type="submit">{Icons.send}</button></form></div></>) : (<div className="centered-placeholder">{Icons.chat}<h3>Selecione uma conversa</h3><p>Escolha um contato à esquerda.</p></div>)}</div>
                        <div className="contact-panel">{selectedChat ? (<><h3>Detalhes</h3><div className="contact-detail"><label>Nome</label><p>{`${selectedChat.first_name || ''} ${selectedChat.last_name || ''}`.trim() || 'Não informado'}</p></div><div className="contact-detail"><label>Username</label><p>{selectedChat.username ? `@${selectedChat.username}` : 'Nenhum'}</p></div><div className="contact-detail"><label>Chat ID</label><p>{selectedChat.chat_id}</p></div><div className="contact-detail"><label>Click ID</label><p>{selectedChat.click_id ? selectedChat.click_id.replace('/start ', '') : 'Nenhum'}</p></div></>) : (<div className="centered-placeholder"><h3>Informações</h3><p>Detalhes do contato aqui.</p></div>)}</div>
                    </div>
                </div>
            </div>
        );
    }
    
    const initialNodes = [{ id: 'start', type: 'trigger', position: { x: 250, y: 50 }, data: {}, deletable: false }];
    const CustomNode = ({ id, type, data, isConnectable }) => {
        const nodeInfo = {
            trigger: { icon: '🚀', name: 'Gatilho Inicial', content: 'Início do fluxo com click_id.' },
            message: { icon: '💬', name: 'Enviar Mensagem', content: data.text ? `"${data.text.substring(0, 50)}..."` : 'Configure o texto.' },
            image: { icon: '🖼️', name: 'Enviar Imagem', content: data.imageUrl ? 'URL configurada.' : 'Configure a URL.' },
            video: { icon: '🎬', name: 'Enviar Vídeo', content: data.videoUrl ? 'URL configurada.' : 'Configure a URL.' },
            audio: { icon: '🎵', name: 'Enviar Áudio', content: data.audioUrl ? 'URL configurada.' : 'Configure a URL.' },
            delay: { icon: '⏱️', name: 'Atraso', content: `Aguardar por ${data.delayInSeconds || 1}s.` },
            action_pix: { icon: '💳', name: 'Gerar PIX', content: `Valor: R$ ${((data.valueInCents || 0) / 100).toFixed(2)}.` },
            action_check_pix: { icon: '🔍', name: 'Consultar PIX', content: 'Verifica se o PIX foi pago.' },
            action_city: { icon: '📍', name: 'Consultar Cidade', content: 'Salva a cidade em {{city}}.' },
            forward_flow: { icon: '↪️', name: 'Encaminhar Fluxo', content: data.targetFlowName ? `Ir para: ${data.targetFlowName}` : 'Selecione um fluxo.' }
        };
        const info = nodeInfo[type] || { icon: '❓', name: 'Nó' };
        return (
            <>
                {type !== 'trigger' && <Handle type="target" position={Position.Top} isConnectable={isConnectable} />}
                <div className={`node-header react-flow__node-${type}`}>{info.icon} {info.name}</div>
                <div className="node-content">{info.content}</div>
                {type === 'trigger' && <Handle type="source" position={Position.Bottom} id="a" isConnectable={isConnectable} />}
                {type === 'message' && !data.waitForReply && <Handle type="source" position={Position.Bottom} id="a" isConnectable={isConnectable} />}
                {type === 'message' && data.waitForReply && (<><div className="handle-label" style={{ left: '25%', transform: 'translateX(-50%)' }}>Com Resp.</div><Handle type="source" position={Position.Bottom} id="a" style={{ left: '25%' }} isConnectable={isConnectable} /><div className="handle-label" style={{ left: '75%', transform: 'translateX(-50%)' }}>Sem Resp.</div><Handle type="source" position={Position.Bottom} id="b" style={{ left: '75%' }} isConnectable={isConnectable} /></>)}
                {type === 'action_check_pix' && (<><div className="handle-label" style={{ left: '25%', transform: 'translateX(-50%)' }}>Pago</div><Handle type="source" position={Position.Bottom} id="a" style={{ left: '25%' }} isConnectable={isConnectable} /><div className="handle-label" style={{ left: '75%', transform: 'translateX(-50%)' }}>Pendente</div><Handle type="source" position={Position.Bottom} id="b" style={{ left: '75%' }} isConnectable={isConnectable} /></>)}
                {['delay', 'action_pix', 'action_city', 'image', 'video', 'audio', 'forward_flow'].includes(type) && <Handle type="source" position={Position.Bottom} id="a" isConnectable={isConnectable} />}
            </>
        );
    };
    const nodeTypes = { trigger: CustomNode, message: CustomNode, image: CustomNode, video: CustomNode, audio: CustomNode, delay: CustomNode, action_pix: CustomNode, action_check_pix: CustomNode, action_city: CustomNode, forward_flow: CustomNode };
    
    function EditorPanel({ selectedNode, setNodes, setSelectedNode, availableFlows }) {
        const [nodeData, setNodeData] = useState(selectedNode.data || {});
        useEffect(() => { setNodeData(selectedNode.data || {}) }, [selectedNode]);
        const handleChange = (e) => { const { name, value, type, checked } = e.target; const final = type === 'checkbox' ? checked : (type === 'number' ? parseInt(value, 10) || 0 : value); setNodeData(p => ({...p, [name]: final })); };
        const handleFlowChange = (e) => { const flowId = e.target.value; const flow = availableFlows.find(f => f.id == flowId); setNodeData(p => ({ ...p, targetFlowId: flowId, targetFlowName: flow ? flow.name : '' })); };
        const onSave = () => { setNodes(nodes => nodes.map(n => n.id === selectedNode.id ? {...n, data: nodeData} : n)); setSelectedNode(null); };
        const onDelete = () => { setNodes(nodes => nodes.filter(n => n.id !== selectedNode.id)); setSelectedNode(null); };
        const renderPanel = () => {
            switch (selectedNode.type) {
                case 'message': return (<><div className="form-group"><label>Texto (use {"{{city}}"})</label><textarea name="text" className="form-textarea" rows="5" value={nodeData.text || ''} onChange={handleChange} /></div><div className="form-group"><label><input name="showTyping" type="checkbox" checked={!!nodeData.showTyping} onChange={handleChange} style={{marginRight:'0.5rem'}} /> Mostrar "Digitando..."</label></div><div className="form-group"><label><input name="waitForReply" type="checkbox" checked={!!nodeData.waitForReply} onChange={handleChange} style={{marginRight:'0.5rem'}} /> Aguardar Resposta</label></div>{nodeData.waitForReply && (<div className="form-group"><label>Tempo de espera (min)</label><input name="replyTimeout" type="number" className="form-input" value={nodeData.replyTimeout || 5} onChange={handleChange} /></div>)}</>);
                case 'image': return (<><div className="form-group"><label>URL da Imagem</label><input name="imageUrl" type="text" className="form-input" value={nodeData.imageUrl || ''} onChange={handleChange} placeholder="https://exemplo.com/img.png"/></div><div className="form-group"><label>Legenda</label><textarea name="caption" className="form-textarea" rows="3" value={nodeData.caption || ''} onChange={handleChange} /></div></>);
                case 'video': return (<><div className="form-group"><label>URL do Vídeo</label><input name="videoUrl" type="text" className="form-input" value={nodeData.videoUrl || ''} onChange={handleChange} placeholder="https://exemplo.com/video.mp4"/></div><div className="form-group"><label>Legenda</label><textarea name="caption" className="form-textarea" rows="3" value={nodeData.caption || ''} onChange={handleChange} /></div></>);
                case 'audio': return (<><div className="form-group"><label>URL do Áudio</label><input name="audioUrl" type="text" className="form-input" value={nodeData.audioUrl || ''} onChange={handleChange} placeholder="https://exemplo.com/audio.mp3"/></div><div className="form-group"><label>Legenda</label><textarea name="caption" className="form-textarea" rows="3" value={nodeData.caption || ''} onChange={handleChange} /></div></>);
                case 'delay': return (<div className="form-group"><label>Atraso (segundos)</label><input name="delayInSeconds" type="number" className="form-input" value={nodeData.delayInSeconds || 1} onChange={handleChange} /></div>);
                case 'action_pix': return (<div className="form-group"><label>Valor (centavos)</label><input name="valueInCents" type="number" className="form-input" value={nodeData.valueInCents || 0} onChange={handleChange} /></div>);
                case 'forward_flow': return (<div className="form-group"><label>Encaminhar para o fluxo</label><select className="form-select" value={nodeData.targetFlowId || ''} onChange={handleFlowChange}><option value="">-- Selecione --</option>{availableFlows.map(f => (<option key={f.id} value={f.id}>{f.name}</option>))}</select></div>);
                default: return <p style={{color: '#6c757d'}}>Sem configurações.</p>;
            }
        };
        return (<div className="editor-panel"><h3 style={{marginBottom: '1.5rem'}}>Editar Nó</h3>{renderPanel()}<div style={{marginTop: '2rem'}}><button className="btn btn-primary" style={{color: 'var(--bg-primary)', background: 'var(--brand-secondary)'}} onClick={onSave}>Salvar</button>{selectedNode.type !== 'trigger' && <button className="btn btn-danger" style={{width: '100%', marginTop: '1rem'}} onClick={onDelete}>Excluir</button>}</div></div>);
    }
    
    function FlowEditorPage({ flow, onBack }) {
        const reactFlowWrapper = useRef(null);
        const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
        const [edges, setEdges, onEdgesChange] = useEdgesState([]);
        const [selectedNode, setSelectedNode] = useState(null);
        const [reactFlowInstance, setReactFlowInstance] = useState(null);
        const [availableFlows, setAvailableFlows] = useState([]);
        useEffect(() => { if(flow?.nodes) { const c = typeof flow.nodes === 'string' ? JSON.parse(flow.nodes) : flow.nodes; setNodes(c.nodes || initialNodes); setEdges(c.edges || []); } }, [flow]);
        useEffect(() => { const fetch = async () => { if (flow?.bot_id) { try { const res = await api.get('/flows'); setAvailableFlows(res.data.filter(f => f.bot_id == flow.bot_id && f.id != flow.id)); } catch (e) { console.error("Erro", e); } } }; fetch(); }, [flow]);
        const onConnect = useCallback((p) => setEdges((eds) => addEdge({ ...p, type: 'smoothstep', animated: true, markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--brand-primary)' }, style: { stroke: 'var(--brand-primary)', strokeWidth: 2 } }, eds)), []);
        const onNodeClick = useCallback((_, n) => setSelectedNode(n), []);
        const onPaneClick = useCallback(() => setSelectedNode(null), []);
        const onDragOver = useCallback((e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }, []);
        const onDrop = useCallback((e) => { e.preventDefault(); const bounds = reactFlowWrapper.current.getBoundingClientRect(); const type = e.dataTransfer.getData('application/reactflow'); if (!type) return; const pos = reactFlowInstance.project({ x: e.clientX - bounds.left, y: e.clientY - bounds.top }); const newNode = { id: `${type}-${Date.now()}`, type, position: pos, data: { text: '', delayInSeconds: 1, valueInCents: 1000, showTyping: true, waitForReply: false, replyTimeout: 5, imageUrl: '', videoUrl: '', audioUrl: '', caption: '', targetFlowId: '', targetFlowName: '' } }; setNodes((nds) => nds.concat(newNode)); }, [reactFlowInstance, setNodes]);
        const handleSave = async () => { try { await api.put(`/flows/${flow.id}`, { name: flow.name, nodes: JSON.stringify({ nodes, edges }) }); alert("Salvo!"); } catch(e) { alert("Erro."); } };
        const onDragStart = (e, type) => { e.dataTransfer.setData('application/reactflow', type); e.dataTransfer.effectAllowed = 'move'; };
        return (
            <div className="flow-editor-page">
                <div className="flow-header"><h3>Editando: {flow.name}</h3><div><button className="btn btn-secondary" style={{marginRight: '0.5rem'}} onClick={onBack}>Voltar</button><button className="btn btn-primary" onClick={handleSave}>Salvar</button></div></div>
                <div className="flow-editor-container">
                    <div className="flow-sidebar">
                        <h3>Componentes</h3>
                        <div className="node-button" onDragStart={(e) => onDragStart(e, 'message')} draggable>{Icons.text}<div>Mensagem</div></div>
                        <div className="node-button" onDragStart={(e) => onDragStart(e, 'image')} draggable>{Icons.image}<div>Imagem</div></div>
                        <div className="node-button" onDragStart={(e) => onDragStart(e, 'video')} draggable>{Icons.video}<div>Vídeo</div></div>
                        <div className="node-button" onDragStart={(e) => onDragStart(e, 'audio')} draggable>{Icons.audio}<div>Áudio</div></div>
                        <div className="node-button" onDragStart={(e) => onDragStart(e, 'delay')} draggable>{Icons.delay}<div>Atraso</div></div>
                        <h3>Ações</h3>
                        <div className="node-button" onDragStart={(e) => onDragStart(e, 'action_pix')} draggable>{Icons.pix}<div>Gerar PIX</div></div>
                        <div className="node-button" onDragStart={(e) => onDragStart(e, 'action_check_pix')} draggable>🔍 Consultar PIX</div>
                        <div className="node-button" onDragStart={(e) => onDragStart(e, 'action_city')} draggable>📍 Consultar Cidade</div>
                        <div className="node-button" onDragStart={(e) => onDragStart(e, 'forward_flow')} draggable>{Icons.forward}<div>Encaminhar Fluxo</div></div>
                    </div>
                    <div className="reactflow-wrapper" ref={reactFlowWrapper}>
                        <ReactFlowProvider>
                            <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={onNodeClick} onPaneClick={onPaneClick} onInit={setReactFlowInstance} onDrop={onDrop} onDragOver={onDragOver} nodeTypes={nodeTypes} fitView>
                                <Background variant="dots" gap={24} size={1} />
                                <Controls />
                            </ReactFlow>
                        </ReactFlowProvider>
                        {selectedNode && <EditorPanel selectedNode={selectedNode} setNodes={setNodes} setSelectedNode={setSelectedNode} availableFlows={availableFlows} />}
                    </div>
                </div>
            </div>
        );
    }
    
    function LoginScreen({ onLogin }) {
        const [isLogin, setIsLogin] = useState(true);

        const [loginEmail, setLoginEmail] = useState('');
        const [loginPassword, setLoginPassword] = useState('');
        const handleLoginSubmit = async (e) => {
            e.preventDefault();
            try {
                const res = await api.post(`/sellers/login`, { email: loginEmail, password: loginPassword });
                onLogin(res.data.token);
            } catch (e) {
                alert('Falha no login: ' + (e.response?.data?.message || ''));
            }
        };

        const [regName, setRegName] = useState('');
        const [regEmail, setRegEmail] = useState('');
        const [regPassword, setRegPassword] = useState('');
        const handleRegisterSubmit = async (e) => {
            e.preventDefault();
            try {
                await api.post(`/sellers/register`, { name: regName, email: regEmail, password: regPassword });
                alert('Cadastro realizado com sucesso! Você já pode fazer o login.');
                setIsLogin(true);
            } catch (e) {
                alert('Falha no cadastro: ' + (e.response?.data?.message || ''));
            }
        };

        if (isLogin) {
            return (
                <div className="login-overlay">
                    <div className="login-box">
                        <h2 style={{textAlign: 'center', marginBottom: '1.5rem', fontWeight: 800}}>Acessar Plataforma</h2>
                        <form onSubmit={handleLoginSubmit}>
                            <div className="form-group">
                                <label>Email</label>
                                <input className="form-input" type="email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} placeholder="seu@email.com" required />
                            </div>
                            <div className="form-group">
                                <label>Senha</label>
                                <input className="form-input" type="password" value={loginPassword} onChange={e => setLoginPassword(e.target.value)} placeholder="••••••••" required />
                            </div>
                            <button className="btn btn-primary" type="submit" style={{width: '100%'}}>Entrar</button>
                        </form>
                        <p style={{textAlign: 'center', marginTop: '1.5rem', fontSize: '0.9rem'}}>
                            Não tem uma conta? <a href="#" onClick={(e) => { e.preventDefault(); setIsLogin(false); }} style={{color: 'var(--brand-primary)', fontWeight: '600'}}>Cadastre-se</a>
                        </p>
                    </div>
                </div>
            );
        } else {
            return (
                 <div className="login-overlay">
                    <div className="login-box">
                        <h2 style={{textAlign: 'center', marginBottom: '1.5rem', fontWeight: 800}}>Criar Conta</h2>
                        <form onSubmit={handleRegisterSubmit}>
                            <div className="form-group">
                                <label>Nome</label>
                                <input className="form-input" type="text" value={regName} onChange={e => setRegName(e.target.value)} placeholder="Seu nome completo" required />
                            </div>
                            <div className="form-group">
                                <label>Email</label>
                                <input className="form-input" type="email" value={regEmail} onChange={e => setRegEmail(e.target.value)} placeholder="seu@email.com" required />
                            </div>
                            <div className="form-group">
                                <label>Senha</label>
                                <input className="form-input" type="password" value={regPassword} onChange={e => setRegPassword(e.target.value)} placeholder="Mínimo 8 caracteres" required minLength="8" />
                            </div>
                            <button className="btn btn-primary" type="submit" style={{width: '100%'}}>Criar Conta</button>
                        </form>
                         <p style={{textAlign: 'center', marginTop: '1.5rem', fontSize: '0.9rem'}}>
                            Já tem uma conta? <a href="#" onClick={(e) => { e.preventDefault(); setIsLogin(true); }} style={{color: 'var(--brand-primary)', fontWeight: '600'}}>Faça Login</a>
                        </p>
                    </div>
                </div>
            );
        }
    }

    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(<App />);
  </script>
</body>
</html>


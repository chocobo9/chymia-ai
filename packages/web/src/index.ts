// @choco/web — public barrel for the M9 React app (root + stores + lib).

export { App } from './App.js';
export { ThreadList } from './components/ThreadList.js';
export { ChatContainer } from './components/ChatContainer.js';
export { ChatInput } from './components/ChatInput.js';
export { AgentMessage } from './components/AgentMessage.js';
export { AgentStatus } from './components/AgentStatus.js';
export { useChatStore } from './stores/chat-store.js';
export { useAgentStore, selectAgentStatus } from './stores/agent-store.js';
export { useSocket, registerSocketListeners, CLIENT_EVENTS, SERVER_EVENTS } from './hooks/useSocket.js';
export { ApiClient, apiClient, ApiError } from './lib/api.js';
export { resolveConfig, webConfig } from './lib/config.js';

// User state management for navigation and settings
const userStates = new Map();

export function getUserState(chatId) {
  if (!userStates.has(chatId)) {
    userStates.set(chatId, {
      currentMenu: 'main',
      lastSnipeSettings: null,
      antiRugMode: false,
      autoSnipeMode: false,
      afkMode: false,
      stealthMode: false,
      // New settings toggles
      degenMode: false,
      buyProtection: false,
      expertMode: false,
      privatePnl: false,
      positions: [],
      limitOrders: [],
      watchedWallets: [],
      menuHistory: ['main'],
      // Defaults for quick actions
      defaultBuySol: 0.05,
      defaultSnipeSol: 0.05,
      // Snipe-specific configuration
      autoSnipeOnPaste: false, // Auto-start snipe without confirmation on address paste
      snipeSlippage: 100, // Custom slippage for snipe operations (in BPS)
      maxSnipeGasPrice: 200000, // Max priority fee for snipe operations (lamports)
      snipePollInterval: 2000, // Polling interval for liquidity checks (ms)
      enableJitoForSnipes: true, // Use Jito bundling for snipes by default
      snipeRetryCount: 3, // Number of retry attempts on failed snipe
      // For text input flows
      pendingInput: null // e.g., { type: 'IMPORT_WALLET', data: {...} }
    });
  }
  return userStates.get(chatId);
}

export function setUserMenu(chatId, menu) {
  const state = getUserState(chatId);
  if (state.currentMenu !== menu) {
    state.menuHistory.push(menu);
    if (state.menuHistory.length > 10) {
      state.menuHistory = state.menuHistory.slice(-10);
    }
  }
  state.currentMenu = menu;
}

export function goBack(chatId) {
  const state = getUserState(chatId);
  if (state.menuHistory.length > 1) {
    state.menuHistory.pop(); // Remove current
    const previousMenu = state.menuHistory[state.menuHistory.length - 1];
    state.currentMenu = previousMenu;
    return previousMenu;
  }
  return 'main';
}

export function updateUserSetting(chatId, key, value) {
  const state = getUserState(chatId);
  state[key] = value;
}

export function addPosition(chatId, position) {
  const state = getUserState(chatId);
  state.positions.push({
    ...position,
    timestamp: Date.now(),
    id: Date.now().toString()
  });
}

export function addLimitOrder(chatId, order) {
  const state = getUserState(chatId);
  state.limitOrders.push({
    ...order,
    timestamp: Date.now(),
    id: Date.now().toString(),
    status: 'active'
  });
}

export function addWatchedWallet(chatId, walletAddress, label = '') {
  const state = getUserState(chatId);
  state.watchedWallets.push({
    address: walletAddress,
    label,
    timestamp: Date.now(),
    id: Date.now().toString()
  });
}

export function setPendingInput(chatId, pending) {
  const state = getUserState(chatId);
  state.pendingInput = pending; // or null to clear
}
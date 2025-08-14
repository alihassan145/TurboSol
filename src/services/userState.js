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
      menuHistory: ['main']
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
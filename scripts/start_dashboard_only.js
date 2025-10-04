import { startDashboardServer } from "../src/services/dashboard.js";

const port = Number(process.env.DASHBOARD_PORT || process.env.PORT || 3000);
(async () => {
  try {
    await startDashboardServer(port);
    console.log(`Dashboard-only server started at http://localhost:${port}/`);
  } catch (e) {
    console.error("Failed to start dashboard-only server:", e?.message || e);
    process.exit(1);
  }
})();
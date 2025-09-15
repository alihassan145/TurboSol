import request from "supertest";
import app from "../src/services/dashboard.js";

describe("/rpc/status summary", () => {
  it("should include summary with active and fastest keys", async () => {
    const resp = await request(app).get("/rpc/status").expect(200);
    expect(resp.body).toHaveProperty("activeUrl");
    expect(resp.body).toHaveProperty("endpoints");
    expect(resp.body).toHaveProperty("summary");
    expect(resp.body.summary).toHaveProperty("active");
    expect(resp.body.summary).toHaveProperty("fastest");
    expect(resp.body.summary).toHaveProperty("fastestP50");
    expect(resp.body.summary).toHaveProperty("fastestP95");
  });
});
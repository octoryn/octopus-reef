export function GET() {
  return globalThis.Response.json({ status: "ready", component: "frontend" });
}

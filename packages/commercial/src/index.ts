export type ReefEdition = "community" | "commercial";

export const COMMERCIAL_COMMAND = "reef.openCommercial";
export const COMMERCIAL_COMMAND_TITLE = "Reef: Commercial";
export const GATEWAY_PROVIDER_NAME = "gateway";

export interface EntitlementStatus {
  readonly state: "licensed" | "missing";
  readonly source: "local-env" | "not-configured";
  readonly summary: string;
}

export interface CommercialSurfaceStatus {
  readonly edition: "commercial";
  readonly entitlement: EntitlementStatus;
  readonly surfaces: readonly {
    readonly id: string;
    readonly title: string;
    readonly gated: boolean;
    readonly reason: string;
  }[];
}

export function resolveEntitlementStatus(options: {
  readonly licenseToken?: string;
} = {}): EntitlementStatus {
  const token =
    clean(options.licenseToken) ??
    clean(process.env.REEF_LICENSE_TOKEN) ??
    clean(process.env.REEF_ENTITLEMENT_TOKEN);
  if (token === undefined) {
    return {
      state: "missing",
      source: "not-configured",
      summary: "No local license token configured.",
    };
  }
  return {
    state: "licensed",
    source: "local-env",
    summary: "Local license token is configured.",
  };
}

export function commercialSurfaceStatus(options: {
  readonly licenseToken?: string;
} = {}): CommercialSurfaceStatus {
  const entitlement = resolveEntitlementStatus(options);
  const gated = entitlement.state !== "licensed";
  return {
    edition: "commercial",
    entitlement,
    surfaces: [
      {
        id: "hosted-bedrock-gateway",
        title: "Hosted Bedrock Gateway",
        gated,
        reason: gated
          ? "Entitlement is missing; gateway routing is disabled."
          : "Entitlement is present; gateway routing may be used.",
      },
      {
        id: "commercial-governance",
        title: "Commercial Governance",
        gated,
        reason: gated
          ? "Commercial workflows are visible but locked until entitlement verifies."
          : "Commercial workflows are unlocked for this licensed session.",
      },
    ],
  };
}

export function commercialWebviewHtml(
  cspSource: string,
  status: CommercialSurfaceStatus = commercialSurfaceStatus(),
): string {
  const entitlementClass =
    status.entitlement.state === "licensed" ? "ok" : "locked";
  const rows = status.surfaces
    .map(
      (surface) => `<article class="surface ${surface.gated ? "locked" : "ok"}">
  <div>
    <h2>${escapeHtml(surface.title)}</h2>
    <p>${escapeHtml(surface.reason)}</p>
  </div>
  <span>${surface.gated ? "Gated OFF" : "Available"}</span>
</article>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${cspSource} 'unsafe-inline';" />
<style>
  :root{--deep:#091315;--panel:#0f1d20;--panel2:#132529;--line:#214044;--ink:#edf6f4;--muted:#86a5a5;--signal:#3de0be;--warn:#ffd166;--mono:ui-monospace,Menlo,monospace}
  body{margin:0;background:var(--deep);color:var(--ink);font-family:var(--mono);font-size:13px}
  header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
  header b{color:var(--signal)}
  main{padding:16px;display:grid;gap:12px}
  .entitlement{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:12px;display:flex;justify-content:space-between;gap:12px}
  .entitlement strong{color:var(--ink)}
  .entitlement span,.surface span{white-space:nowrap;border:1px solid var(--line);border-radius:999px;padding:3px 8px;color:var(--muted);align-self:start}
  .entitlement.ok span,.surface.ok span{color:var(--signal);border-color:rgba(61,224,190,.5)}
  .entitlement.locked span,.surface.locked span{color:var(--warn);border-color:rgba(255,209,102,.55)}
  .surface{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:12px;display:flex;justify-content:space-between;gap:12px}
  h2{font-size:13px;margin:0 0 6px;color:var(--ink)}
  p{margin:0;color:var(--muted);line-height:1.45}
</style>
</head>
<body>
<header><div><b>&#x259A; reef</b> commercial</div><div>${status.edition}</div></header>
<main>
  <section class="entitlement ${entitlementClass}">
    <div><strong>Entitlement</strong><p>${escapeHtml(status.entitlement.summary)}</p></div>
    <span>${status.entitlement.state === "licensed" ? "Licensed" : "Missing"}</span>
  </section>
  ${rows}
</main>
</body>
</html>`;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

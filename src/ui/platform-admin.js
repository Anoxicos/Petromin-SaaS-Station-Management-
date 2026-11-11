const el = id => document.getElementById(id);
const notice = (message, error = false) => { el("adminNotice").textContent = message; el("adminNotice").classList.toggle("error", error); };

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, credentials: "same-origin", headers: { "content-type": "application/json", ...(options.headers || {}) }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    el("adminSignIn").hidden = false;
    el("adminSignOut").hidden = true;
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function localDate() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`; }
function cell(row, value) { const td = document.createElement("td"); td.textContent = String(value ?? "—"); row.append(td); }
function table(container, headings, rows) {
  const grid = document.createElement("table"); grid.className = "data-table"; const head = document.createElement("thead"), top = document.createElement("tr");
  for (const item of headings) { const th = document.createElement("th"); th.textContent = item; top.append(th); } head.append(top); grid.append(head);
  const body = document.createElement("tbody"); for (const source of rows) { const tr = document.createElement("tr"); for (const item of source) cell(tr, item); body.append(tr); } grid.append(body); container.replaceChildren(grid);
}

function addStation() {
  const host = el("onboardingStations"); if (host.children.length >= 50) { notice("A client can have up to 50 stations in this onboarding batch.", true); return; }
  const group = document.createElement("div"); group.className = "entry-row platform-station";
  const fields = [
    ["Station code", "code", "text", "STATION-01"], ["Station name", "name", "text", "Station 1"],
  ];
  for (const [label, key, type, placeholder] of fields) { const wrap = document.createElement("label"); wrap.textContent = label; const input = document.createElement("input"); input.dataset.field = key; input.type = type; input.placeholder = placeholder; input.required = true; input.maxLength = 200; wrap.append(input); group.append(wrap); }
  const modeLabel = document.createElement("label"); modeLabel.textContent = "Meter mode"; const mode = document.createElement("select"); mode.dataset.field = "meterMode"; mode.required = true; mode.add(new Option("Choose a mode", "")); mode.add(new Option("Nozzle meters", "NOZZLE")); mode.add(new Option("Pump / totalizer", "PUMP_TOTALIZER")); modeLabel.append(mode); group.append(modeLabel);
  const cutoffLabel = document.createElement("label"); cutoffLabel.textContent = "Day cutoff"; const cutoff = document.createElement("input"); cutoff.type = "time"; cutoff.required = true; cutoff.dataset.field = "closingCutoff"; cutoffLabel.append(cutoff); group.append(cutoffLabel);
  const zoneLabel = document.createElement("label"); zoneLabel.textContent = "Time zone"; const zone = document.createElement("input"); zone.placeholder = "Enter station IANA time zone"; zone.required = true; zone.maxLength = 80; zone.dataset.field = "timeZone"; zoneLabel.append(zone); group.append(zoneLabel);
  const ruleLabel = document.createElement("label"); ruleLabel.textContent = "Cutoff day rule"; const rule = document.createElement("select"); rule.dataset.field = "closingDayRule"; rule.add(new Option("Leave undecided", "")); rule.add(new Option("Cutoff ends selected day", "CUTOFF_ENDS_DAY")); rule.add(new Option("Cutoff starts selected day", "CUTOFF_STARTS_DAY")); ruleLabel.append(rule); group.append(ruleLabel);
  host.append(group); el("addStation").disabled = host.children.length >= 50;
}

async function loadOverview() {
  const data = await api("/admin/platform/overview"); state.clients = data.clients;
  table(el("clientOverview"), ["Client", "Stations", "Users", "Plan", "Subscription", "Created"], data.clients.map(row => [
    `${row.code} · ${row.name}`, row.stationCount, row.userCount, row.planName || "—", row.subscriptionStatus || "Not configured", row.createdAt ? new Date(row.createdAt).toLocaleDateString() : "—",
  ]));
  const selector = el("subscriptionClient"), current = selector.value; selector.replaceChildren(new Option("Choose client", ""));
  for (const client of data.clients) selector.add(new Option(`${client.code} · ${client.name}`, client.clientId));
  if (data.clients.some(client => client.clientId === current)) selector.value = current;
  const onboardingSelect = el("onboardingClient"), onboardingCurrent = onboardingSelect.value; onboardingSelect.replaceChildren(new Option("Choose client", ""));
  for (const client of data.clients) onboardingSelect.add(new Option(`${client.code} · ${client.name}`, client.clientId));
  if (data.clients.some(client => client.clientId === onboardingCurrent)) onboardingSelect.value = onboardingCurrent;
  if (selector.value) await loadSubscriptions();
}

async function loadAdminOnboarding(clientId = el("onboardingClient").value) {
  const host = el("onboardingChecklist"); if (!clientId) { host.replaceChildren(); return; }
  const result = await api(`/admin/platform/clients/${encodeURIComponent(clientId)}/onboarding`);
  const section = document.createElement("div"); section.className = "history";
  const ready = document.createElement("p"); ready.className = "status"; ready.textContent = result.ready ? "Checklist complete" : "Setup is still in progress"; section.append(ready);
  for (const task of result.tasks) {
    const row = document.createElement("div"); row.className = "history-row onboarding-task";
    const title = document.createElement("strong"); title.textContent = `${task.title} · ${task.status}`;
    const detail = document.createElement("span"); detail.textContent = `${task.responsibleParty === "PROVIDER" ? "Provider" : `Client ${task.responsibleRole.toLowerCase()}`} · ${task.completionNote || task.description}`;
    row.append(title, detail);
    if (task.status === "PENDING") {
      if (task.responsibleParty === "PROVIDER") {
        const complete = document.createElement("button"); complete.type = "button"; complete.className = "button secondary"; complete.textContent = "Record provider completion";
        complete.addEventListener("click", async () => { const note = prompt("Add a short note or evidence reference:", ""); if (!note?.trim()) return; try { await api(`/admin/platform/clients/${clientId}/onboarding/${task.taskCode}`, { method: "PATCH", body: { status: "COMPLETED", note: note.trim() } }); await loadAdminOnboarding(clientId); } catch (error) { notice(error.message, true); } }); row.append(complete);
      }
      const waive = document.createElement("button"); waive.type = "button"; waive.className = "button secondary"; waive.textContent = "Waive with reason";
      waive.addEventListener("click", async () => { const note = prompt("Reason this required onboarding item is being waived:", ""); if (!note?.trim()) return; try { await api(`/admin/platform/clients/${clientId}/onboarding/${task.taskCode}`, { method: "PATCH", body: { status: "WAIVED", note: note.trim() } }); await loadAdminOnboarding(clientId); } catch (error) { notice(error.message, true); } }); row.append(waive);
    }
    section.append(row);
  }
  host.replaceChildren(section);
}

async function loadClientAudit(clientId = el("onboardingClient").value) {
  const host = el("clientAuditTable"); if (!clientId) { host.replaceChildren(); return; }
  const result = await api(`/admin/platform/clients/${encodeURIComponent(clientId)}/audit-events?limit=50`);
  table(host, ["When", "Action", "Record", "Actor", "Details"], result.events.map(event => [new Date(event.occurredAt).toLocaleString(), event.action, `${event.entityType} · ${event.entityId}`, event.actorId, JSON.stringify(event.details)]));
}

async function loadPlans() {
  const data = await api("/admin/platform/plans"); state.plans = data.plans;
  for (const id of ["ratePlan", "subscriptionPlan"]) { const select = el(id), current = select.value; select.replaceChildren(new Option("Choose plan", "")); for (const plan of data.plans.filter(item => item.isActive)) select.add(new Option(`${plan.code} · ${plan.name}`, plan.id)); if (data.plans.some(plan => plan.id === current)) select.value = current; }
  const rows = data.plans.flatMap(plan => (plan.rates || []).map(rate => [plan.code, plan.name, rate.effectiveFrom, rate.currencyCode, rate.monthlyBaseFee, rate.monthlyStationFee]));
  table(el("planTable"), ["Plan", "Name", "Rate from", "Currency", "Monthly base", "Per station"], rows);
}

async function loadSubscriptions() {
  const clientId = el("subscriptionClient").value; if (!clientId) { el("subscriptionTable").replaceChildren(); return; }
  const data = await api(`/admin/platform/clients/${encodeURIComponent(clientId)}/subscription`);
  const billing = el("billingSubscription"), selected = billing.value; billing.replaceChildren(new Option("Choose active subscription", ""));
  for (const item of data.subscriptions.filter(item => item.status === "ACTIVE")) billing.add(new Option(`${item.planCode} · ${item.effectiveFrom}`, item.id));
  if (data.subscriptions.some(item => item.id === selected && item.status === "ACTIVE")) billing.value = selected;
  const rows = data.subscriptions.map(subscription => {
    const tr = [subscription.planCode, subscription.status, subscription.effectiveFrom, subscription.contractReference || "No contract reference", `${subscription.billingDay} · ${subscription.billingTimeZone}`];
    return tr;
  });
  table(el("subscriptionTable"), ["Plan", "Status", "Starts", "Contract", "Billing schedule"], rows);
  el("subscriptionTable").dataset.subscriptions = JSON.stringify(data.subscriptions);
  renderSubscriptionActions(data.subscriptions);
  await loadBillingStatements();
}

async function loadBillingStatements() {
  const clientId = el("subscriptionClient").value; if (!clientId) return;
  const data = await api(`/admin/platform/clients/${encodeURIComponent(clientId)}/billing-statements`);
  const grid = document.createElement("table"); grid.className = "data-table"; const head = document.createElement("thead"), trh = document.createElement("tr");
  for (const name of ["Plan", "Period", "Stations", "Base", "Per station", "Before tax", "Status", "Review"]) { const th = document.createElement("th"); th.textContent = name; trh.append(th); } head.append(trh); grid.append(head);
  const body = document.createElement("tbody");
  for (const item of data.statements) {
    const row = document.createElement("tr"); for (const value of [item.planCode, `${item.periodStart} – ${item.periodEnd}`, item.stationCount, `${item.currencyCode} ${item.monthlyBaseFee}`, `${item.currencyCode} ${item.monthlyStationFee}`, `${item.currencyCode} ${item.amountBeforeTax}`, item.status, item.statusReason || "—"]) cell(row, value);
    const reviewCell = row.lastElementChild; reviewCell.textContent = item.statusReason || "—";
    if (item.status === "DRAFT") {
      const button = document.createElement("button"); button.className = "button secondary"; button.type = "button"; button.textContent = "Review and approve";
      button.addEventListener("click", async () => { try { await api(`/admin/platform/billing-statements/${item.id}`, { method: "PATCH", body: { status: "APPROVED", reason: prompt("Optional internal review note:", "") || null } }); notice("Statement approved for manual billing review; no invoice was issued."); await loadBillingStatements(); } catch (error) { notice(error.message, true); } }); reviewCell.replaceChildren(button);
      const voidButton = document.createElement("button"); voidButton.className = "button secondary"; voidButton.type = "button"; voidButton.textContent = "Void";
      voidButton.addEventListener("click", async () => { const reason = prompt("Reason for voiding this draft:", ""); if (!reason?.trim()) return; try { await api(`/admin/platform/billing-statements/${item.id}`, { method: "PATCH", body: { status: "VOID", reason: reason.trim() } }); await loadBillingStatements(); } catch (error) { notice(error.message, true); } }); reviewCell.append(voidButton);
    }
    body.append(row);
  }
  grid.append(body); el("billingTable").replaceChildren(grid);
}

function renderSubscriptionActions(subscriptions) {
  const host = el("subscriptionActions"); if (!host) return; host.replaceChildren();
  for (const subscription of subscriptions) {
    if (subscription.status === "CANCELLED") continue;
    const row = document.createElement("div"); row.className = "actions"; const label = document.createElement("strong"); label.textContent = `${subscription.planCode} · ${subscription.status}`; row.append(label);
    for (const status of subscription.status === "PENDING" ? ["ACTIVE", "CANCELLED"] : subscription.status === "ACTIVE" ? ["PAUSED", "CANCELLED"] : ["ACTIVE", "CANCELLED"]) {
      const button = document.createElement("button"); button.type = "button"; button.className = "button secondary"; button.textContent = status === "ACTIVE" ? "Activate after contract" : status === "PAUSED" ? "Pause" : "Cancel";
      button.addEventListener("click", async () => {
        try {
          const contractReference = status === "ACTIVE" ? prompt("Enter the signed contract reference before activation:", subscription.contractReference || "") : undefined;
          if (status === "ACTIVE" && !contractReference?.trim()) return;
          if (status !== "ACTIVE" && !confirm(`${status} this subscription?`)) return;
          await api(`/admin/platform/subscriptions/${subscription.id}`, { method: "PATCH", body: { status, ...(contractReference ? { contractReference: contractReference.trim() } : {}) } });
          notice(`Subscription updated: ${status}.`); await loadOverview();
        } catch (error) { notice(error.message, true); }
      }); row.append(button);
    }
    host.append(row);
  }
}

async function loadSupportInbox() {
  const [data, providerData] = await Promise.all([api("/admin/platform/support-requests"),api("/admin/platform/support-assignees")]);
  const assignee=el("supportAssignee"), selected=assignee.value;assignee.replaceChildren(new Option("Unassigned",""));
  for(const user of providerData.assignees)assignee.add(new Option(`${user.displayName} · ${user.email}`,user.id));
  if(providerData.assignees.some(user=>user.id===selected))assignee.value=selected;
  const host = el("supportInbox"); host.replaceChildren();
  for (const request of data.requests) {
    const row = document.createElement("div"); row.className = "history-row";
    const title = document.createElement("strong"); title.textContent = `${request.clientCode} · ${request.subject} · ${request.status}`;
    const detail = document.createElement("span"); detail.textContent = `${request.category.replaceAll("_", " ")} · ${new Date(request.updatedAt).toLocaleString()}`;
    const button = document.createElement("button"); button.type = "button"; button.className = "button secondary"; button.textContent = "Open"; button.addEventListener("click", () => void loadSupportDetail(request.id).catch(error => notice(error.message, true)));
    row.append(title, detail, button); host.append(row);
  }
  if (!data.requests.length) host.textContent = "No support requests.";
}

async function loadSupportDetail(id) {
  const data = await api(`/admin/platform/support-requests/${encodeURIComponent(id)}`); state.supportId = id; const host = el("supportDetail"); host.replaceChildren();
  const title = document.createElement("strong"); title.textContent = `${data.request.clientName} · ${data.request.subject} · ${data.request.status}`;
  const description = document.createElement("p"); description.textContent = data.request.description; host.append(title, description);
  for (const entry of data.messages) { const line = document.createElement("p"); line.textContent = `[${entry.visibility}] ${entry.message} · ${new Date(entry.createdAt).toLocaleString()}`; host.append(line); }
  el("supportControls").hidden = false; el("supportStatus").value = data.request.status; el("supportAssignee").value = data.request.assignedTo || ""; el("supportResolution").value = data.request.resolutionNote || "";
}

const state = { clients: [], plans: [], supportId: "" };
el("rateDate").value = localDate(); el("subscriptionDate").value = localDate(); el("billingMonth").value = localDate().slice(0,7); addStation();
el("addStation").addEventListener("click", addStation);
el("refreshOverview").addEventListener("click", async () => { try { await Promise.all([loadOverview(), loadPlans()]); notice("Platform overview refreshed."); } catch (error) { notice(error.message, true); } });
el("onboardClient").addEventListener("click", async () => {
  try {
    const stations = [...el("onboardingStations").children].map(group => Object.fromEntries([...group.querySelectorAll("[data-field]")].map(input => [input.dataset.field, input.value.trim() || null])));
    const result = await api("/admin/platform/onboard", { method: "POST", body: { clientName: el("clientName").value.trim(), clientCode: el("clientCode").value.trim(), ownerEmail: el("ownerEmail").value.trim(), stations } });
    notice(`Created ${result.client.code} with ${result.stations.length} stations and owner ${result.owner.email}.`); await loadOverview(); el("onboardingClient").value = result.client.id; await Promise.all([loadAdminOnboarding(result.client.id),loadClientAudit(result.client.id)]);
  } catch (error) { notice(error.message, true); }
});
el("createPlan").addEventListener("click", async () => {
  try { await api("/admin/platform/plans", { method: "POST", body: { code: el("planCode").value.trim(), name: el("planName").value.trim(), description: el("planDescription").value.trim() } }); notice("Subscription plan created. Add an explicit dated rate when ready."); await loadPlans(); }
  catch (error) { notice(error.message, true); }
});
el("saveRate").addEventListener("click", async () => {
  try { const planId = el("ratePlan").value; if (!planId) throw new Error("Choose a plan."); if (!el("baseFee").value || !el("stationFee").value) throw new Error("Enter both rate amounts explicitly; pricing is never guessed."); if (!el("rateCurrency").value.trim()) throw new Error("Enter the plan currency from the agreed commercial terms.");
    await api(`/admin/platform/plans/${planId}/rates`, { method: "POST", body: { effectiveFrom: el("rateDate").value, currencyCode: el("rateCurrency").value.trim(), monthlyBaseFee: el("baseFee").value, monthlyStationFee: el("stationFee").value } }); notice("Dated subscription rate saved."); await loadPlans(); }
  catch (error) { notice(error.message, true); }
});
el("createSubscription").addEventListener("click", async () => {
  try { const clientId = el("subscriptionClient").value, planId = el("subscriptionPlan").value; if (!clientId || !planId) throw new Error("Choose a client and plan.");
    if (!el("billingDay").value || !el("billingTimeZone").value.trim()) throw new Error("Enter the agreed billing day and time zone; no schedule is assumed.");
    await api(`/admin/platform/clients/${clientId}/subscription`, { method: "POST", body: { planId, effectiveFrom: el("subscriptionDate").value, contractReference: el("contractReference").value.trim() || null, billingDay: Number(el("billingDay").value), billingTimeZone: el("billingTimeZone").value.trim() } }); notice("Pending subscription created. Billing stays inactive until a signed contract is recorded."); await loadOverview(); }
  catch (error) { notice(error.message, true); }
});
el("createBillingStatement").addEventListener("click", async () => {
  try {
    const clientId = el("subscriptionClient").value, subscriptionId = el("billingSubscription").value, month = el("billingMonth").value;
    if (!clientId || !subscriptionId || !/^\d{4}-\d{2}$/.test(month)) throw new Error("Choose a client, active subscription, and billing month.");
    const [year, number] = month.split("-").map(Number); const periodStart = `${month}-01`; const periodEnd = new Date(Date.UTC(year, number, 0)).toISOString().slice(0,10);
    await api(`/admin/platform/clients/${clientId}/billing-statements`, { method: "POST", body: { subscriptionId, periodStart, periodEnd } });
    notice("Draft statement created from the signed plan rate and station count. It is pre-tax and is not an invoice."); await loadBillingStatements();
  } catch (error) { notice(error.message, true); }
});
el("subscriptionClient").addEventListener("change", () => void loadSubscriptions().catch(error => notice(error.message, true)));
el("loadOnboardingChecklist").addEventListener("click", () => void Promise.all([loadAdminOnboarding(),loadClientAudit()]).catch(error => notice(error.message, true)));
el("loadClientAudit").addEventListener("click", () => void loadClientAudit().catch(error => notice(error.message, true)));
el("onboardingClient").addEventListener("change", () => void Promise.all([loadAdminOnboarding(),loadClientAudit()]).catch(error => notice(error.message, true)));
el("refreshSupportInbox").addEventListener("click", () => void loadSupportInbox().catch(error => notice(error.message, true)));
el("saveSupportStatus").addEventListener("click", async () => {
  try { if (!state.supportId) return; await api(`/admin/platform/support-requests/${state.supportId}`, { method: "PATCH", body: { status: el("supportStatus").value, assignedTo: el("supportAssignee").value.trim() || null, resolutionNote: el("supportResolution").value.trim() || undefined } }); notice("Support request updated."); await Promise.all([loadSupportInbox(), loadSupportDetail(state.supportId)]); }
  catch (error) { notice(error.message, true); }
});
el("sendSupportMessage").addEventListener("click", async () => {
  try { if (!state.supportId) return; const message = el("supportMessage").value.trim(); if (!message) throw new Error("Enter a message."); await api(`/admin/platform/support-requests/${state.supportId}/messages`, { method: "POST", body: { visibility: el("supportVisibility").value, message } }); el("supportMessage").value = ""; notice("Support message added."); await Promise.all([loadSupportInbox(), loadSupportDetail(state.supportId)]); }
  catch (error) { notice(error.message, true); }
});
  Promise.all([loadOverview(), loadPlans(), loadSupportInbox()]).catch(error => notice(error.message, true));

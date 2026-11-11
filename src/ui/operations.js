const el = (id) => document.getElementById(id);
const state = { workspaces: [], clientId: "", station: null, equipment: [], products: [], saleProducts: [], tariffs: [], meterRows: [], dayInputs: null, daily: null, inventory: [], fuelVarianceThresholds: [], financialVarianceThreshold: null, importJob: null, importHistoryNextCursor: null, importHistoryQuery: "", importHistoryHasRows: false, supportRequestId: "", catalogProducts: [], stationProducts: [], setupEquipment: [], customers: [], sales: [], vouchers: [], invoiceProfile: null, suppliers: [], serviceRecipe: [] };
const stored = (key) => { try { return sessionStorage.getItem(key) || ""; } catch { return ""; } };
const save = (key, value) => { try { sessionStorage.setItem(key, value); } catch { /* optional convenience */ } };

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function message(text, error = false) {
  el("notice").textContent = text;
  el("notice").classList.toggle("error", error);
}

function requireSignIn() {
  el("signInLink").hidden=false;el("signOutLink").hidden=true;el("platformAdminLink").hidden=true;
  for(const panel of document.querySelectorAll("main > .panel, main > .context")){
    panel.hidden=true;
    for(const content of panel.querySelectorAll(".history,.table-wrap,.review,.summary-grid,.entry-list"))content.replaceChildren();
    for(const input of panel.querySelectorAll("input,textarea"))input.value="";
    for(const select of panel.querySelectorAll("select"))select.replaceChildren();
  }
  for(const [key,value] of Object.entries(state))state[key]=Array.isArray(value)?[]:typeof value==="string"?"":typeof value==="boolean"?false:null;
  el("clientSelect").replaceChildren(new Option("Sign in to load clients",""));el("clientSelect").disabled=true;
  el("stationSelect").replaceChildren(new Option("Choose a client first",""));el("stationSelect").disabled=true;
  message("Your sign-in has expired. Use Sign in to return to station operations.",true);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.clientId) headers.set("X-Client-Id", state.clientId);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers, credentials: "same-origin", body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) requireSignIn();
    if (response.status === 401 || response.status === 403) throw new ApiError(response.status, `${payload.error || "Your sign-in is no longer valid."} Sign in again or ask an owner to check your access.`);
    throw new ApiError(response.status, payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

function setStatus(id, text, kind = "") {
  const node = el(id);
  node.textContent = text;
  node.className = `status ${kind}`.trim();
}

function inputField(label, value, type = "number") {
  const wrapper = document.createElement("label");
  wrapper.className = "allocation";
  wrapper.textContent = label;
  const input = document.createElement("input");
  input.type = type;
  if (type === "number") { input.min = "0"; input.step = "0.001"; input.inputMode = "decimal"; }
  input.value = value ?? "";
  wrapper.append(input);
  return wrapper;
}

function decimalValue(input, places = 3) {
  const value = input.value.trim();
  const maxIntegerDigits = places === 2 ? 12 : 11;
  const pattern = new RegExp(`^(0|[1-9]\\d{0,${maxIntegerDigits - 1}})(\\.\\d{1,${places}})?$`);
  if (!pattern.test(value)) throw new Error(`Enter a non-negative number with at most ${places} decimal places in every required field.`);
  const [integer, fraction = ""] = value.split(".");
  return `${integer}.${fraction.padEnd(places, "0")}`;
}

function makeRow(equipment, prior, current) {
  const row = document.createElement("div");
  row.className = "entry-row";
  row.dataset.equipmentId = equipment.id;
  const title = document.createElement("div");
  title.className = "equipment";
  const label = document.createElement("strong");
  label.textContent = equipment.code;
  const sub = document.createElement("small");
  sub.textContent = equipment.kind === "NOZZLE" ? (equipment.product_name || "Fuel nozzle") : equipment.kind;
  title.append(label, sub);
  row.append(title, inputField("Opening index", current?.initial_index ?? prior?.reset_initial_index ?? prior?.final_index ?? ""), inputField("Closing index", current?.final_index ?? ""));
  if (state.station.meterMode === "PUMP_TOTALIZER") {
    const allocations = document.createElement("div");
    allocations.className = "allocations";
    for (const product of state.products) {
      const existing = current?.product_allocations?.find((item) => item.productId === product.id || item.product_id === product.id);
      const productField = inputField(`${product.name} · litres`, existing?.volume ?? "");
      productField.querySelector("input").dataset.product = product.id;
      allocations.append(productField);
    }
    const allocationRow = document.createElement("div");
    allocationRow.className = "entry-row allocation-row";
    const titleRow = document.createElement("h4");
    titleRow.textContent = `${equipment.code} product split`;
    allocationRow.append(titleRow, allocations);
    state.meterRows.push({ row, allocationRow });
  } else state.meterRows.push({ row, allocationRow: null });
  return row;
}

function renderReadings(readings) {
  const container = el("meterRows");
  container.replaceChildren();
  state.meterRows = [];
  const equipmentKind = state.station.meterMode === "NOZZLE" ? "NOZZLE" : ["PUMP", "METER"];
  const meters = state.equipment.filter((item) => (Array.isArray(equipmentKind) ? equipmentKind.includes(item.kind) : item.kind === equipmentKind));
  const batch = readings[0] || null;
  const currentByEquipment = new Map(readings.filter((item) => item.reading_id).map((item) => [item.equipment_id, item]));
  const all = [...state.allReadings].filter((item) => item.reading_id && item.business_date < el("businessDate").value);
  for (const meter of meters) {
    const prior = all.find((item) => item.equipment_id === meter.id);
    const current = currentByEquipment.get(meter.id);
    const row = makeRow(meter, prior, current);
    container.append(row);
    if (state.meterRows.at(-1).allocationRow) container.append(state.meterRows.at(-1).allocationRow);
  }
  const validated = batch?.status === "VALIDATED";
  for (const field of container.querySelectorAll("input")) field.disabled = validated;
  el("saveReadings").disabled = validated;
  el("validateReadings").hidden = !batch || validated;
  el("validateReadings").dataset.batchId = batch?.batch_id || "";
  setStatus("meterStatus", batch ? (validated ? "Validated and locked" : "Draft · needs validation") : "Not entered", validated ? "ready" : batch ? "waiting" : "");
  if (!meters.length) {
    const empty = document.createElement("p");
    empty.className = "help";
    empty.textContent = "No active meters match this station’s meter mode. Ask an owner to check the equipment setup.";
    container.append(empty);
  }
}

function renderTanks(tanks, day) {
  const container = el("tankRows");
  container.replaceChildren();
  for (const tank of tanks) {
    const current = day?.dips?.find((dip) => dip.tank_id === tank.id || dip.tankId === tank.id);
    const row = document.createElement("div");
    row.className = "entry-row";
    row.dataset.tankId = tank.id;
    const title = document.createElement("div");
    title.className = "equipment";
    const code = document.createElement("strong"); code.textContent = tank.code;
    const calibration = document.createElement("small"); calibration.textContent = tank.calibration_effective_from ? `Calibration from ${tank.calibration_effective_from}` : "No active calibration chart";
    title.append(code, calibration);
    row.append(title, inputField("Product depth · mm", current?.product_depth_mm ?? current?.productDepthMm ?? ""), inputField("Water depth · mm", current?.water_depth_mm ?? current?.waterDepthMm ?? ""));
    container.append(row);
  }
  const locked = day?.status === "VALIDATED";
  for (const field of container.querySelectorAll("input")) field.disabled = locked;
  el("cashTotal").value = day?.cash_total ?? "";
  el("cardTotal").value = day?.card_total ?? "";
  el("collectionsCurrency").value = day?.currencyCode ?? day?.currency_code ?? "";
  el("cashTotal").disabled = locked;
  el("cardTotal").disabled = locked;
  el("collectionsCurrency").disabled = locked;
  el("saveInputs").disabled = locked;
  el("validateInputs").hidden = !day || locked;
  setStatus("inputsStatus", day ? (locked ? "Validated and locked" : "Draft · needs validation") : "Not entered", locked ? "ready" : day ? "waiting" : "");
}

function renderReconciliation(history) {
  const container = el("reconHistory");
  container.replaceChildren();
  for (const row of history) {
    const item = document.createElement("div"); item.className = "history-row";
    const strong = document.createElement("strong"); strong.textContent = `Recount ${row.revision_number}`;
    const currency=row.currencyCode?` ${row.currencyCode}`:"";
    const cashCheck=row.cashWithinTolerance==null?"cash limit unset":row.cashWithinTolerance?`cash within ±${row.maxAbsCashVariance}${currency}`:`cash outside ±${row.maxAbsCashVariance}${currency}`;
    const cardCheck=row.cardWithinTolerance==null?"card limit unset":row.cardWithinTolerance?`card within ±${row.maxAbsCardVariance}${currency}`:`card outside ±${row.maxAbsCardVariance}${currency}`;
    item.append(strong, document.createTextNode(` · cash variance ${Number(row.cash_variance).toFixed(2)}${currency} · card variance ${Number(row.card_variance).toFixed(2)}${currency} · ${cashCheck} · ${cardCheck} · ${row.recorded_at ? new Date(row.recorded_at).toLocaleString() : ""}`));
    container.append(item);
  }
  const hasHistory = history.length > 0;
  setStatus("reconStatus", hasHistory ? `Latest: recount ${history.at(-1).revision_number}` : "Optional", hasHistory ? "ready" : "");
}

function renderDaily() {
  const daily = state.daily;
  const volume = daily.meterReadings.totalVolume ? `${Number(daily.meterReadings.totalVolume).toLocaleString()} L` : "—";
  const pricing = daily.salesPricing.totalSalesValue === null ? "Not calculated" : Number(daily.salesPricing.totalSalesValue).toFixed(2);
  const currency = daily.collectionsAndDips.currencyCode ? ` ${daily.collectionsAndDips.currencyCode}` : " · currency unset";
  const cards = [["Fuel volume", volume], ["Cash", `${daily.collectionsAndDips.cashTotal ?? "—"}${currency}`], ["Card", `${daily.collectionsAndDips.cardTotal ?? "—"}${currency}`], ["Estimated fuel value", pricing]];
  el("summary").replaceChildren(...cards.map(([title, value]) => {
    const card = document.createElement("div"); card.className = "summary-card";
    const name = document.createElement("span"); name.textContent = title;
    const amount = document.createElement("strong"); amount.textContent = String(value);
    card.append(name, amount); return card;
  }));
  const windowText = daily.closingWindow.endsAt ? new Date(daily.closingWindow.endsAt).toLocaleString() : "Set a cutoff rule in station settings";
  const items = [
    ["Meter readings", daily.meterReadings.status],
    ["Cash, card and dips", daily.collectionsAndDips.status],
    ["Cutoff", daily.closingWindow.status === "CUTOFF_PASSED" ? `Passed · ${windowText}` : `${daily.closingWindow.status} · ${windowText}`],
    ["Close", daily.closing ? "Already closed" : daily.readyToClose ? "Ready to close" : "Complete the steps above"],
  ];
  el("dayReview").replaceChildren(...items.map(([title, detail]) => {
    const item = document.createElement("div"); item.className = "review-item";
    const strong = document.createElement("strong"); strong.textContent = title;
    item.append(strong, document.createTextNode(detail)); return item;
  }));
  el("closeDay").disabled = !daily.readyToClose;
  setStatus("closeStatus", daily.closing ? "Closed" : daily.readyToClose ? "Ready" : "Not ready", daily.closing || daily.readyToClose ? "ready" : "waiting");
}

function renderInventory() {
  const container = el("inventoryTable");
  const table = document.createElement("table");
  table.className = "data-table";
  const head = document.createElement("thead");
  const header = document.createElement("tr");
  for (const label of ["Product", "Type", "Theoretical", "Dipped", "Variance", "Tolerance review"]) {
    const cell = document.createElement("th"); cell.textContent = label; header.append(cell);
  }
  head.append(header); table.append(head);
  const body = document.createElement("tbody");
  for (const item of state.inventory) {
    const row = document.createElement("tr");
    const values = [
      `${item.code} · ${item.name}`,
      item.productType,
      `${item.theoreticalStock} ${item.unitCode}`,
      item.actualDipStock == null ? (item.productType === "FUEL" ? "Needs validated dips and charts" : "—") : `${item.actualDipStock} ${item.unitCode}`,
      item.variance == null ? "—" : `${item.variance} ${item.unitCode}`,
      item.variance == null ? "Awaiting calibrated dips" : item.maxAbsVariance == null ? "No client tolerance set" : item.withinVarianceThreshold ? `Within ±${item.maxAbsVariance} ${item.unitCode}` : `Outside ±${item.maxAbsVariance} ${item.unitCode}`,
    ];
    for (const value of values) { const cell = document.createElement("td"); cell.textContent = String(value); row.append(cell); }
    body.append(row);
  }
  table.append(body); container.replaceChildren(table);
}

async function loadInventoryWorkspace() {
  if (!state.station || !state.clientId) return;
  const role = currentRole(); const canManage = ["OWNER", "MANAGER", "SUPER_ADMIN"].includes(role);
  el("stockManagementPanel").hidden = !canManage;
  if (!canManage) return;
  const stationId = state.station.stationId;
  const [suppliers, receipts, movements, thresholds] = await Promise.all([
    api("/suppliers"), api(`/stations/${stationId}/purchase-receipts`), api(`/stations/${stationId}/stock-movements`), api(`/stations/${stationId}/variance-thresholds`),
  ]);
  state.fuelVarianceThresholds = thresholds.thresholds;
  state.suppliers = suppliers.suppliers;
  el("receiptDate").value ||= el("businessDate").value || localDate();
  el("adjustDate").value ||= el("businessDate").value || localDate();
  financeOptions(el("receiptSupplier"), "Choose supplier", state.suppliers.filter(item => item.isActive), item => `${item.code} · ${item.name}`);
  const assigned = state.saleProducts.filter(item => item.product_type !== "SERVICE");
  const tanks = state.setupEquipment.filter(item => item.kind === "TANK" && !item.retired_at);
  for (const row of el("receiptLineRows").querySelectorAll(".receipt-line")) {
    const tank=row.querySelectorAll("select")[1]; const selected=tank.value; tank.replaceChildren(new Option("Choose receiving tank",""));
    for(const item of tanks)tank.add(new Option(item.code,item.id)); if(tanks.some(item=>item.id===selected))tank.value=selected;
  }
  financeOptions(el("adjustProduct"), "Choose assigned product", assigned, item => `${item.code} · ${item.name}`);
  financeOptions(el("serviceProduct"), "Choose service", state.saleProducts.filter(item => item.product_type === "SERVICE"), item => `${item.code} · ${item.name}`);
  financeOptions(el("serviceComponentProduct"), "Choose article", state.saleProducts.filter(item => item.product_type === "ARTICLE"), item => `${item.code} · ${item.name}`);
  financeOptions(el("fuelVarianceProduct"), "Choose fuel product", state.fuelVarianceThresholds, item => `${item.code} · ${item.name} (${item.unitCode})`);
  renderFuelVarianceThresholds();
  setupTable(el("supplierList"), ["Code", "Supplier", "Email", "Phone", "Status"], state.suppliers.map(item => [item.code,item.name,item.contactEmail || "—",item.contactPhone || "—",item.isActive ? "Active" : "Inactive"]));
  setupTable(el("receiptHistory"), ["Date", "Supplier", "Reference", "Currency", "Lines"], receipts.receipts.map(item => [item.businessDate,item.supplierName,item.supplierReference || "—",item.currencyCode,(item.lines || []).map(line => `${state.saleProducts.find(product => product.id === line.productId)?.name || "Product"}: ${line.quantity}`).join("; ")]));
  setupTable(el("stockMovementHistory"), ["Date", "Product", "Type", "Change", "Reason"], movements.movements.map(item => [item.businessDate,`${item.productCode} · ${item.productName}`,item.movementType,item.quantityDelta,item.reason || "—"]));
  if (!el("receiptLineRows").children.length) addReceiptLine();
}

function renderFuelVarianceThresholds() {
  const rows = state.fuelVarianceThresholds.map(item => [
    `${item.code} · ${item.name}`,
    item.maxAbsVariance == null ? "Not set" : `±${item.maxAbsVariance} ${item.unitCode}`,
    item.reason || "—",
  ]);
  setupTable(el("fuelVariancePolicyList"), ["Fuel product", "Maximum absolute variance", "Approval note"], rows);
  const selected = state.fuelVarianceThresholds.find(item => item.productId === el("fuelVarianceProduct").value);
  el("fuelVarianceLimit").value = selected?.maxAbsVariance ?? "";
  el("fuelVarianceReason").value = "";
}

function addReceiptLine() {
  const row=document.createElement("div"); row.className="receipt-line totals-grid";
  const product=createSelect("Product",state.saleProducts.filter(item=>item.product_type!=="SERVICE").map(item=>({value:item.id,label:`${item.code} · ${item.name}`})));
  const tank=createSelect("Receiving tank",state.setupEquipment.filter(item=>item.kind==="TANK"&&!item.retired_at).map(item=>({value:item.id,label:item.code})));
  const quantity=document.createElement("input"); quantity.type="number";quantity.min="0.001";quantity.step="0.001";quantity.setAttribute("aria-label","Receipt quantity");
  const unitCost=document.createElement("input");unitCost.type="number";unitCost.min="0";unitCost.step="0.0001";unitCost.setAttribute("aria-label","Receipt unit cost");
  const wrap=(label,control)=>{const outer=document.createElement("label");outer.textContent=label;outer.append(control);return outer;};
  const productWrap=wrap("Product",product),tankWrap=wrap("Tank (fuel only)",tank); tank.disabled=true;
  product.addEventListener("change",()=>{const selected=state.saleProducts.find(item=>item.id===product.value);const requires=selected?.product_type==="FUEL";tank.disabled=!requires;tank.required=requires;if(!requires)tank.value="";});
  const remove=document.createElement("button");remove.type="button";remove.className="button secondary";remove.textContent="Remove line";remove.addEventListener("click",()=>{if(el("receiptLineRows").children.length>1)row.remove();else message("A receipt needs at least one line.",true);});
  row.append(productWrap,tankWrap,wrap("Quantity",quantity),wrap("Unit cost",unitCost),remove);el("receiptLineRows").append(row);
}

async function loadServiceRecipe() {
  const serviceId = el("serviceProduct").value;
  if (!serviceId || !state.station) { state.serviceRecipe = []; renderServiceRecipe(); return; }
  const result = await api(`/stations/${state.station.stationId}/services/${serviceId}/components`);
  state.serviceRecipe = result.components.map(item => ({ productId: item.productId, quantityPerService: String(item.quantityPerService) }));
  renderServiceRecipe();
}

function renderServiceRecipe() {
  const host = el("serviceRecipeRows"); host.replaceChildren();
  if (!state.serviceRecipe.length) { host.textContent = "No components in this recipe."; return; }
  const table = document.createElement("table"); table.className = "data-table";
  for (const [index,item] of state.serviceRecipe.entries()) {
    const row = table.insertRow(); const product = state.saleProducts.find(value => value.id === item.productId);
    for (const value of [`${product?.code || ""} · ${product?.name || "Unknown article"}`, item.quantityPerService]) { const cell=row.insertCell(); cell.textContent=value; }
    const action=row.insertCell(); const remove=document.createElement("button"); remove.type="button"; remove.className="button secondary"; remove.textContent="Remove"; remove.addEventListener("click",()=>{state.serviceRecipe.splice(index,1);renderServiceRecipe();}); action.append(remove);
  }
  host.append(table);
}

function renderDailyReport(report) {
  const table = document.createElement("table");
  table.className = "data-table";
  const header = document.createElement("tr");
  for (const label of ["Station", "Meter", "Volumes", "Sales by currency", "Inputs", "Cash", "Card", "Collection currency", "Dips", "Close"]) {
    const cell = document.createElement("th"); cell.textContent = label; header.append(cell);
  }
  const head = document.createElement("thead"); head.append(header); table.append(head);
  const body = document.createElement("tbody");
  for (const station of report.stations) {
    const volumes = (station.volumes || []).map((item) => `${item.code}: ${item.volume ?? "—"} ${item.unitCode}`).join(" · ") || "—";
    const sales = (station.salesByCurrency || []).map((item) => `${item.currencyCode}: sales ${item.postedSalesToday}, credit ${item.creditSalesToday}, open now ${item.currentOpenCreditThroughDate}`).join(" · ") || "—";
    const values = [
      `${station.stationCode} · ${station.stationName}`,
      station.meterStatus,
      volumes,
      sales,
      station.inputsStatus,
      station.cashTotal ?? "—",
      station.cardTotal ?? "—",
      station.collectionsCurrencyCode ?? "Currency unset",
      station.dipStatus,
      station.isClosed ? "Closed" : "Open",
    ];
    const row = document.createElement("tr");
    for (const value of values) { const cell = document.createElement("td"); cell.textContent = String(value); row.append(cell); }
    body.append(row);
  }
  table.append(body);
  el("dailyReportTable").replaceChildren(table);
}

async function downloadCsv(path) {
  if (!state.clientId) throw new Error("Choose a client first.");
  const response = await fetch(path, { headers: { "X-Client-Id": state.clientId }, credentials: "same-origin" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Export failed (${response.status})`);
  }
  const file = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = file;
  anchor.download = path.split("/").at(-1).split("?")[0];
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(file), 30_000);
}

async function openPrintView(path) {
  if (!state.clientId) throw new Error("Choose a client first.");
  const tab = window.open("about:blank", "_blank");
  if (!tab) throw new Error("Allow a new tab to open the print view.");
  try {
    const response = await fetch(path,{headers:{"X-Client-Id":state.clientId},credentials:"same-origin"});
    if (!response.ok) {
      const payload=await response.json().catch(()=>({}));
      throw new Error(payload.error||`Print view failed (${response.status})`);
    }
    const blob=URL.createObjectURL(new Blob([await response.text()],{type:"text/html;charset=utf-8"}));
    tab.location.href=blob;
    setTimeout(()=>URL.revokeObjectURL(blob),60_000);
  } catch(error) { tab.close(); throw error; }
}

const { importRowsFromMatrix, csvRows } = window.stationImportParser;

async function importFileRows(file) {
  if (/\.xlsx$/i.test(file.name)) {
    if (typeof window.readXlsxFile !== "function") throw new Error("Excel workbook reader is unavailable; use CSV or reload the page.");
    const sheets = await window.readXlsxFile(file);
    if (!Array.isArray(sheets) || !sheets.length) throw new Error("Workbook has no worksheets.");
    return importRowsFromMatrix(sheets[0].data);
  }
  if (!/\.csv$/i.test(file.name)) throw new Error("Choose an .xlsx workbook or .csv file.");
  return csvRows(await file.text());
}

function importHeaders() {
  return ({
    HISTORICAL_RECORDS: ["recordDate", "recordType", "description", "amount", "currencyCode", "additionalData"],
    OPENING_STOCK: ["businessDate", "productCode", "quantity", "reason"],
    OPENING_RECEIVABLE: ["businessDate", "customerCode", "amount", "reason"],
  })[el("importKind").value];
}

function renderImport(job) {
  state.importJob = job;
  const table = document.createElement("table"); table.className = "data-table";
  const head = document.createElement("thead"), header = document.createElement("tr");
  for (const label of ["Row", "Status", "Data", "Issues"]) { const th = document.createElement("th"); th.textContent = label; header.append(th); } head.append(header); table.append(head);
  const body = document.createElement("tbody");
  for (const row of job.rows || []) { const tr = document.createElement("tr");
    for (const value of [row.rowNumber, row.status, JSON.stringify(row.normalizedData || row.rawData), (row.errors || []).join("; ") || (row.importedEntityId ? `Committed · ${row.importedEntityId}` : "—")]) { const td = document.createElement("td"); td.textContent = String(value); tr.append(td); }
    body.append(tr);
  }
  table.append(body); el("importPreview").replaceChildren(table);
  const meta = job.job; el("importStatus").textContent = `${meta.import_kind} · ${meta.status} · ${meta.valid_count} valid · ${meta.invalid_count} invalid · ${meta.row_count} rows`;
  el("commitImport").disabled = meta.status !== "VALIDATED" || Number(meta.invalid_count) !== 0 || Number(meta.valid_count) === 0;
}

async function loadImportJobs() {
  if (!state.clientId) return;
  const data = await api("/import-jobs"); const select = el("importJobSelect"); const current = select.value;
  select.replaceChildren(new Option("Choose a staged import", ""));
  for (const job of data.jobs) select.add(new Option(`${job.createdAt ? new Date(job.createdAt).toLocaleString() : "Import"} · ${job.importKind} · ${job.status} · ${job.validCount}/${job.rowCount}`, job.id));
  if (data.jobs.some(job => job.id === current)) select.value = current;
}

async function showImportJob(id = el("importJobSelect").value) {
  if (!id) { state.importJob = null; el("importPreview").replaceChildren(); el("commitImport").disabled = true; return; }
  renderImport(await api(`/import-jobs/${encodeURIComponent(id)}`));
}

function historyQuery(cursor = null) {
  const params=new URLSearchParams();
  for(const [key,value] of [["from",el("historyFrom").value],["to",el("historyTo").value],["stationId",el("historyStation").value],["recordType",el("historyRecordType").value.trim()]]) if(value) params.set(key,value);
  if(cursor) params.set("cursor",cursor);
  return params.toString();
}

async function loadImportedHistory({older=false}={}) {
  if(!state.clientId)return;
  const cursor=older?state.importHistoryNextCursor:null;
  if(older&&!cursor)return;
  const query=historyQuery(cursor);state.importHistoryQuery=query;
  const result=await api(`/import-history${query?`?${query}`:""}`);
  const rows=result.records.map(record=>[record.recordDate,record.stationCode||"Client-wide",record.recordType,record.description,record.amount==null?"":`${record.amount} ${record.currencyCode||""}`.trim(),JSON.stringify(record.additionalData||{}),new Date(record.importedAt).toLocaleString()]);
  if(older){
    const current=el("historyResults").querySelector("tbody");
    for(const values of rows){const tr=document.createElement("tr");for(const value of values){const td=document.createElement("td");td.textContent=String(value??"");tr.append(td);}current?.append(tr);}
  }else setupTable(el("historyResults"),["Date","Station","Type","Description","Amount","Additional data","Imported"],rows);
  state.importHistoryNextCursor=result.nextCursor;state.importHistoryHasRows=older?state.importHistoryHasRows||rows.length>0:rows.length>0;
  el("historyStatus").textContent=state.importHistoryHasRows?"Showing matching committed history. Use Load older records to continue.":"No committed history matches these filters.";
  el("loadOlderHistory").disabled=!result.nextCursor;el("exportHistoryPage").disabled=rows.length===0;
}

async function loadOnboardingChecklist() {
  if (!state.clientId) return;
  const result = await api(`/clients/${state.clientId}/onboarding`); const role = state.workspaces.find(item => item.clientId === state.clientId)?.role;
  el("onboardingReadiness").textContent = result.ready ? "Checklist complete" : "In progress";
  el("onboardingReadiness").className = `status ${result.ready ? "ready" : "waiting"}`;
  const host = el("clientOnboardingTasks"); host.replaceChildren();
  for (const task of result.tasks) {
    const item = document.createElement("div"); item.className = "history-row onboarding-task";
    const title = document.createElement("strong"); title.textContent = `${task.title} · ${task.status}`;
    const detail = document.createElement("span"); detail.textContent = `${task.description} Assigned to ${task.responsibleParty === "PROVIDER" ? "the provider" : `client ${task.responsibleRole.toLowerCase()}`}.${task.completionNote ? ` Note: ${task.completionNote}` : ""}`;
    item.append(title, detail);
    const canComplete = task.status === "PENDING" && (role === "SUPER_ADMIN" || task.responsibleParty === "CLIENT" && role === task.responsibleRole);
    if (canComplete) { const button = document.createElement("button"); button.type = "button"; button.className = "button secondary"; button.textContent = "Record completion"; button.addEventListener("click", async () => { const note = prompt("Add a short note or reference confirming this item:", ""); if (!note?.trim()) return; try { await api(`/clients/${state.clientId}/onboarding/${task.taskCode}`, { method: "PATCH", body: { status: "COMPLETED", note: note.trim() } }); await loadOnboardingChecklist(); } catch (error) { message(error.message, true); } }); item.append(button); }
    host.append(item);
  }
}

async function loadClientSupport() {
  if (!state.clientId) return;
  const result = await api("/client/support-requests"); const host = el("clientSupportRequests"); host.replaceChildren();
  for (const request of result.requests) {
    const item = document.createElement("div"); item.className = "history-row";
    const title = document.createElement("strong"); title.textContent = `${request.subject} · ${request.status}`;
    const detail = document.createElement("span"); detail.textContent = `${request.category.replaceAll("_", " ")} · ${new Date(request.createdAt).toLocaleString()} · ${request.description}`;
    const button = document.createElement("button"); button.type = "button"; button.className = "button secondary"; button.textContent = "Open conversation"; button.addEventListener("click", () => void loadSupportConversation(request.id).catch(error => message(error.message, true)));
    item.append(title, detail, button); host.append(item);
  }
  if (!result.requests.length) host.textContent = "No support requests yet.";
}

function setupTable(host, headings, rows) {
  const table = document.createElement("table"); table.className = "data-table";
  const head = document.createElement("thead"), header = document.createElement("tr");
  for (const label of headings) { const th = document.createElement("th"); th.textContent = label; header.append(th); }
  head.append(header); table.append(head); const body = document.createElement("tbody");
  for (const values of rows) { const tr = document.createElement("tr"); for (const value of values) { const td = document.createElement("td"); td.textContent = String(value ?? "—"); tr.append(td); } body.append(tr); }
  table.append(body); host.replaceChildren(table);
}

function setOptions(select, options, firstLabel) {
  const current = select.value; select.replaceChildren(new Option(firstLabel, ""));
  for (const item of options) select.add(new Option(item.label, item.value));
  if (options.some(item => item.value === current)) select.value = current;
}

async function loadStationSetup() {
  if (!state.station || !state.clientId) return;
  const [catalog, assigned, equipment] = await Promise.all([
    api(`/clients/${state.clientId}/products`), api(`/stations/${state.station.stationId}/products`), api(`/stations/${state.station.stationId}/equipment`),
  ]);
  state.catalogProducts = catalog.products; state.stationProducts = assigned.products; state.setupEquipment = equipment.equipment;
  const assignedIds = new Set(state.stationProducts.map(item => item.id));
  setOptions(el("assignProduct"), state.catalogProducts.filter(item => !assignedIds.has(item.id)).map(item => ({ label: `${item.code} · ${item.name} (${item.product_type})`, value: item.id })), "Choose product");
  const fuels = state.stationProducts.filter(item => item.product_type === "FUEL");
  const fuelOptions = fuels.map(item => ({ label: `${item.code} · ${item.name}`, value: item.id }));
  setOptions(el("tariffProduct"), fuelOptions, "Choose assigned fuel"); setOptions(el("setupEquipmentProduct"), fuelOptions, "Choose fuel product");
  const pumps = state.setupEquipment.filter(item => item.kind === "PUMP" && !item.retired_at).map(item => ({ label: `${item.code} · Pump`, value: item.id }));
  setOptions(el("setupEquipmentParent"), pumps, "Choose parent pump");
  const tanks = state.setupEquipment.filter(item => item.kind === "TANK" && !item.retired_at).map(item => ({ label: `${item.code} · ${state.catalogProducts.find(p => p.id === item.product_id)?.name || "Tank"}`, value: item.id }));
  const nozzles = state.setupEquipment.filter(item => item.kind === "NOZZLE" && !item.retired_at).map(item => ({ label: item.code, value: item.id }));
  setOptions(el("calibrationTank"), tanks, "Choose tank"); setOptions(el("setupAssignmentTank"), tanks, "Choose tank");
  setOptions(el("setupAssignmentNozzle"), nozzles, "Choose nozzle");
  const meters = state.setupEquipment.filter(item => ["NOZZLE", "PUMP", "METER"].includes(item.kind) && !item.retired_at).map(item => ({ label: `${item.code} · ${item.kind}`, value: item.id }));
  setOptions(el("resetEquipment"), meters, "Choose meter");
  setupTable(el("setupProductList"), ["Code", "Product", "Type", "Unit", "Station"], state.catalogProducts.map(item => [item.code, item.name, item.product_type, item.unit_code, assignedIds.has(item.id) ? "Assigned" : "Not assigned"]));
  setupTable(el("setupEquipmentList"), ["Code", "Kind", "Fuel product", "Parent pump", "Serial"], state.setupEquipment.map(item => [item.code, item.kind, state.catalogProducts.find(p => p.id === item.product_id)?.name || "—", state.setupEquipment.find(parent => parent.id === item.parent_equipment_id)?.code || "—", item.serial_number || "—"]));
  await Promise.all([loadStationTariffs(), loadCalibrationHistory(), loadTankAssignmentHistory(), loadMeterResetHistory()]);
  await loadInventoryWorkspace();
}

function currentRole() { return state.workspaces.find(item => item.clientId === state.clientId)?.role || ""; }
function financeOptions(select, placeholder, items, label) {
  setOptions(select, items.map(item => ({ value: item.id, label: label(item) })), placeholder);
}

async function loadFinanceWorkspace() {
  if (!state.station || !state.clientId) return;
  const role = currentRole(); const canManage = ["OWNER", "MANAGER", "SUPER_ADMIN"].includes(role);
  const canReview = ["OWNER", "MANAGER", "ACCOUNTANT", "SUPER_ADMIN"].includes(role);
  el("financePanel").hidden = !["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER", "SUPER_ADMIN"].includes(role);
  el("creditAdminControls").hidden = !canManage; el("voucherAdminControls").hidden = !canManage;
  el("paymentControls").hidden = !canReview; el("invoiceProfileControls").hidden = !["OWNER", "MANAGER", "ACCOUNTANT", "SUPER_ADMIN"].includes(role);
  el("invoiceProfileSaveControls").hidden = !canManage; el("invoiceApprovalControls").hidden = role !== "ACCOUNTANT";
  el("invoiceSalesControls").hidden = !canReview;
  const [customers, vouchers, profile, sales] = await Promise.all([
    api("/customers"), api("/vouchers"), ["OWNER", "MANAGER", "ACCOUNTANT", "SUPER_ADMIN"].includes(role) ? api("/client/invoice-profile") : Promise.resolve({ invoiceProfile: null }),
    canReview ? api(`/stations/${state.station.stationId}/sales`) : Promise.resolve({ sales: [] }),
  ]);
  state.customers = customers.customers; state.vouchers = vouchers.vouchers; state.invoiceProfile = profile.invoiceProfile; state.sales = sales.sales;
  const customerLabel = item => `${item.code} · ${item.displayName}`;
  financeOptions(el("creditCustomer"), "Choose customer", state.customers, customerLabel);
  financeOptions(el("saleCustomer"), "Walk-in / no customer", state.customers, customerLabel);
  financeOptions(el("paymentCustomer"), "Choose customer", state.customers, customerLabel);
  setupTable(el("financeCustomerList"), ["Code", "Customer", "Credit limit", "Outstanding", "Credit status"], state.customers.map(item => [item.code, item.displayName, item.creditLimit ?? "Not configured", Number(item.outstandingBalance || 0).toFixed(2), item.creditStatus || "No credit account"]));
  renderVoucherList(); renderFinanceSales(); loadCreditNoteOptions();
  if (state.invoiceProfile) {
    el("invoiceLegalConfiguration").value = JSON.stringify(state.invoiceProfile.legalConfiguration, null, 2);
    el("invoicePrefix").value = state.invoiceProfile.invoicePrefix || ""; el("creditPrefix").value = state.invoiceProfile.creditNotePrefix || "";
    el("invoiceProfileStatus").textContent = `${state.invoiceProfile.status}${state.invoiceProfile.approvedAt ? ` · accountant approved ${new Date(state.invoiceProfile.approvedAt).toLocaleString()}` : " · approval required before invoice issuance"}`;
  } else { el("invoiceLegalConfiguration").value = ""; el("invoicePrefix").value = ""; el("creditPrefix").value = ""; el("invoiceProfileStatus").textContent = "No invoice profile configured. Obtain the accountant's supplied rules before drafting it."; }
  if (!el("saleLineRows").children.length) addSaleLine();
  if (!el("saleTenderRows").children.length) addSaleTender();
  el("saleBusinessDate").value ||= el("businessDate").value || localDate();
  updateSalePreview();
}

function createSelect(label, options, value = "") {
  const select = document.createElement("select"); select.setAttribute("aria-label", label);
  select.add(new Option(`Choose ${label.toLowerCase()}`, ""));
  for (const item of options) select.add(new Option(item.label, item.value));
  select.value = value; return select;
}

function addSaleLine() {
  const row = document.createElement("div"); row.className = "entry-row sale-line";
  const products = state.saleProducts.map(item => ({ label: `${item.code} · ${item.name}`, value: item.id }));
  const product = createSelect("product", products); product.dataset.field = "productId"; product.insertBefore(new Option("Manual line", ""), product.options[1]);
  const description = document.createElement("input"); description.placeholder = "Description"; description.maxLength = 300; description.dataset.field = "description"; description.setAttribute("aria-label", "Line description");
  const unit = document.createElement("input"); unit.placeholder = "Unit"; unit.maxLength = 16; unit.dataset.field = "unitCode"; unit.setAttribute("aria-label", "Unit code");
  const quantity = document.createElement("input"); quantity.type = "number"; quantity.min = "0.001"; quantity.step = "0.001"; quantity.placeholder = "Quantity"; quantity.dataset.field = "quantity"; quantity.setAttribute("aria-label", "Quantity");
  const price = document.createElement("input"); price.type = "number"; price.min = "0"; price.step = "0.0001"; price.placeholder = "Unit price"; price.dataset.field = "unitPrice"; price.setAttribute("aria-label", "Unit price");
  const taxCode = document.createElement("input"); taxCode.placeholder = "Tax code (if supplied)"; taxCode.maxLength = 40; taxCode.dataset.field = "taxCode"; taxCode.setAttribute("aria-label", "Tax code");
  const taxRate = document.createElement("input"); taxRate.type = "number"; taxRate.min = "0"; taxRate.max = "100"; taxRate.step = "0.0001"; taxRate.placeholder = "Tax rate %"; taxRate.dataset.field = "taxRatePercent"; taxRate.setAttribute("aria-label", "Tax rate percent");
  const remove = document.createElement("button"); remove.type = "button"; remove.className = "button secondary"; remove.textContent = "Remove"; remove.addEventListener("click", () => { row.remove(); updateSalePreview(); });
  product.addEventListener("change", () => {
    const selected = state.saleProducts.find(item => item.id === product.value);
    if (!selected) return updateSalePreview();
    description.value = selected.name; unit.value = selected.unit_code;
    price.value = "";
    if (selected.product_type === "FUEL") {
      const now = Date.now(); const tariff = state.tariffs.find(item => item.product_id === selected.id && new Date(item.valid_from).valueOf() <= now && (!item.valid_until || new Date(item.valid_until).valueOf() > now));
      if (tariff) price.value = tariff.unit_price;
      else message(`No effective tariff is available for ${selected.name} now.`, true);
    }
    updateSalePreview();
  });
  for (const input of [description, unit, quantity, price, taxCode, taxRate]) input.addEventListener("input", updateSalePreview);
  row.append(product, description, unit, quantity, price, taxCode, taxRate, remove); el("saleLineRows").append(row);
}

function addSaleTender() {
  const row = document.createElement("div"); row.className = "entry-row sale-tender";
  const kind = createSelect("payment type", [{label:"Cash",value:"CASH"},{label:"Card",value:"CARD"},{label:"Credit",value:"CREDIT"},{label:"Voucher",value:"VOUCHER"}]); kind.dataset.field="type";
  const amount = document.createElement("input"); amount.type="number"; amount.min="0"; amount.step="0.01"; amount.placeholder="Amount"; amount.dataset.field="amount"; amount.setAttribute("aria-label","Tender amount");
  const reference = document.createElement("input"); reference.maxLength=160; reference.placeholder="Reference (optional)"; reference.dataset.field="reference"; reference.setAttribute("aria-label","Tender reference");
  const voucherOptions = state.vouchers.filter(item => item.status === "ACTIVE" && Number(item.remainingBalance) > 0).map(item => ({label:`${item.code} · ${item.remainingBalance} ${item.currencyCode}`,value:item.id}));
  const voucher = createSelect("voucher", voucherOptions); voucher.dataset.field="voucherId"; voucher.hidden=true;
  const remove = document.createElement("button"); remove.type="button"; remove.className="button secondary"; remove.textContent="Remove"; remove.addEventListener("click",()=>{row.remove();updateSalePreview();});
  kind.addEventListener("change",()=>{voucher.hidden=kind.value!=="VOUCHER";updateSalePreview();}); amount.addEventListener("input",updateSalePreview);
  row.append(kind,amount,reference,voucher,remove); el("saleTenderRows").append(row);
}

function addSaleScheduleInstallment() {
  const row=document.createElement("div");row.className="entry-row credit-installment";
  const dueDate=document.createElement("input");dueDate.type="date";dueDate.dataset.field="dueDate";dueDate.setAttribute("aria-label","Installment due date");
  const amount=document.createElement("input");amount.type="number";amount.min="0.01";amount.step="0.01";amount.placeholder="Amount";amount.dataset.field="amount";amount.setAttribute("aria-label","Installment amount");
  const remove=document.createElement("button");remove.type="button";remove.className="button secondary";remove.textContent="Remove installment";remove.addEventListener("click",()=>row.remove());
  row.append(dueDate,amount,remove);el("saleScheduleRows").append(row);
}

function updateSalePreview() {
  const lineRows=[...el("saleLineRows").querySelectorAll(".sale-line")]; let total=0;
  for(const row of lineRows){const q=Number(row.querySelector('[data-field="quantity"]').value||0),p=Number(row.querySelector('[data-field="unitPrice"]').value||0),r=Number(row.querySelector('[data-field="taxRatePercent"]').value||0);const sub=Math.round(q*p*100)/100;total+=sub+Math.round(sub*r)/100;}
  total=Math.round(total*100)/100; const paid=[...el("saleTenderRows").querySelectorAll('[data-field="amount"]')].reduce((sum,input)=>sum+Number(input.value||0),0);
  el("saleTotalPreview").textContent=`Sale total preview: ${total.toFixed(2)} · tendered: ${paid.toFixed(2)} · difference: ${(paid-total).toFixed(2)}. The database remains authoritative for rounding and balanced tenders.`;
}

function renderVoucherList() {
  const host=el("voucherList");host.replaceChildren();
  for(const voucher of state.vouchers){
    const row=document.createElement("div");row.className="history-row";
    const detail=document.createElement("span");
    detail.textContent=`${voucher.code} · ${voucher.status} · remaining ${voucher.remainingBalance} ${voucher.currencyCode}${voucher.expiresAt?` · expires ${new Date(voucher.expiresAt).toLocaleString()}`:""}${voucher.cancellationReason?` · cancellation: ${voucher.cancellationReason}`:""}`;
    row.append(detail);
    if(["OWNER","MANAGER","SUPER_ADMIN"].includes(currentRole())&&["ACTIVE","SUSPENDED"].includes(voucher.status)){
      const button=document.createElement("button");button.type="button";button.className="button secondary";button.textContent=voucher.status==="ACTIVE"?"Suspend":"Activate";
      button.addEventListener("click",async()=>{try{await api(`/vouchers/${voucher.id}/status`,{method:"PATCH",body:{status:voucher.status==="ACTIVE"?"SUSPENDED":"ACTIVE"}});await loadFinanceWorkspace();}catch(error){message(error.message,true);}});row.append(button);
      const cancel=document.createElement("button");cancel.type="button";cancel.className="button secondary";cancel.textContent="Cancel voucher";
      cancel.addEventListener("click",async()=>{const reason=window.prompt(`Reason for cancelling ${voucher.code}. Remaining balance ${voucher.remainingBalance} ${voucher.currencyCode} will be reconciled.`);if(reason===null)return;if(!reason.trim()){message("A cancellation reason is required.",true);return;}try{await api(`/vouchers/${voucher.id}/cancel`,{method:"POST",body:{reason:reason.trim()}});await loadFinanceWorkspace();}catch(error){message(error.message,true);}});row.append(cancel);
    }
    host.append(row);
  }
  if(!state.vouchers.length)host.textContent="No vouchers issued.";
}

function renderFinanceSales() {
  const host=el("financeSalesList");host.replaceChildren();
  for(const sale of state.sales){const row=document.createElement("div");row.className="history-row";const summary=document.createElement("strong");summary.textContent=`${sale.businessDate} · ${sale.customerName||"Walk-in"} · ${sale.total} ${sale.currencyCode}`;const meta=document.createElement("span");const invoiceStatus=sale.invoiceNumber?`Invoice ${sale.invoiceNumber}`:Number(sale.creditBalance)>0?`Unpaid credit ${sale.creditBalance} ${sale.currencyCode}`:"No invoice issued";const schedule=Array.isArray(sale.creditSchedule)?sale.creditSchedule:[];const dueStatus=schedule.length?` · installments: ${schedule.map((item,index)=>{const paid=Number(sale.creditInstallmentPaid?.[String(index+1)]||0);return `${item.dueDate} ${item.amount} (paid ${paid.toFixed(2)}, remaining ${Math.max(0,Number(item.amount)-paid).toFixed(2)})`;}).join(", ")}`:sale.creditTermsDays==null?"":` · payment due ${sale.creditDueDate} (${sale.creditTermsDays} days)`;meta.textContent=invoiceStatus+dueStatus;row.append(summary,meta);
    if(["OWNER","MANAGER","ACCOUNTANT","SUPER_ADMIN"].includes(currentRole())){
      if(!sale.invoiceId){const issue=document.createElement("button");issue.type="button";issue.className="button secondary";issue.textContent="Issue invoice";issue.addEventListener("click",async()=>{try{const result=await api(`/stations/${state.station.stationId}/sales/${sale.id}/invoice`,{method:"POST",body:{}});message(`Issued ${result.invoice.invoiceNumber}. Invoice issuance requires the approved client profile.`);await loadFinanceWorkspace();}catch(error){message(error.message,true);}});row.append(issue);}
      if(sale.invoiceId){const print=document.createElement("button");print.type="button";print.className="button secondary";print.textContent="Print invoice";print.addEventListener("click",()=>{el("invoiceIdToPrint").value=sale.invoiceId;el("printInvoice").click();});row.append(print);const notes=document.createElement("button");notes.type="button";notes.className="button secondary";notes.textContent="View credit notes";notes.addEventListener("click",async()=>{el("creditNoteInvoice").value=sale.invoiceId;await loadCreditNotes();});row.append(notes);}
    }
    host.append(row);
  }
  if(!state.sales.length)host.textContent="No accessible sales on this station.";
}

function loadCreditNoteOptions() {
  const invoices=state.sales.filter(item=>item.invoiceId);financeOptions(el("creditNoteInvoice"),"Choose issued invoice",invoices,item=>`${item.invoiceNumber} · ${item.customerName||"Walk-in"} · ${item.total} ${item.currencyCode}`);
}

async function loadCreditNotes() {
  const invoiceId=el("creditNoteInvoice").value;const host=el("creditNoteList");host.replaceChildren();if(!invoiceId)return;
  const result=await api(`/invoices/${invoiceId}/credit-notes`);for(const note of result.creditNotes){const row=document.createElement("div");row.className="history-row";const summary=document.createElement("span");summary.textContent=`${note.creditNoteNumber} · ${note.amount} · receivable adjustment ${note.receivableAdjustment} · ${note.reason}`;const print=document.createElement("button");print.type="button";print.className="button secondary";print.textContent="Print credit note";print.addEventListener("click",()=>openCreditNotePrint(note.id));row.append(summary,print);host.append(row);}if(!result.creditNotes.length)host.textContent="No credit notes for this invoice.";
}

function openCreditNotePrint(creditNoteId) {
  if (!state.clientId) { message("Choose a client first so the credit note stays within that workspace.", true); return; }
  const printTab=window.open("about:blank","_blank");if(!printTab){message("Allow a new tab to open the credit note print view.",true);return;}
  void (async()=>{try{const response=await fetch(`/credit-notes/${encodeURIComponent(creditNoteId)}/print`,{headers:{"X-Client-Id":state.clientId},credentials:"same-origin"});if(!response.ok){const payload=await response.json().catch(()=>({}));throw new Error(payload.error||`Could not load credit note (${response.status})`);}const printable=URL.createObjectURL(new Blob([await response.text()],{type:"text/html;charset=utf-8"}));printTab.location.href=printable;setTimeout(()=>URL.revokeObjectURL(printable),60_000);message("Credit note print view opened. Use Print or save as PDF in the new tab.");}catch(error){printTab.close();message(error.message,true);}})();
}

function addPaymentAllocation() {
  const customerId=el("paymentCustomer").value;const available=state.sales.filter(item=>item.customerId===customerId&&Number(item.creditBalance)>0);
  const row=document.createElement("div");row.className="entry-row payment-allocation";const sale=createSelect("outstanding credit sale",available.map(item=>({label:`${item.businessDate} · ${item.total} ${item.currencyCode} · outstanding ${item.creditBalance}`,value:item.id})));sale.dataset.field="saleId";
  const installment=createSelect("sale balance or installment",[]);installment.dataset.field="installmentNumber";installment.hidden=true;
  const updateInstallments=()=>{const selected=available.find(item=>item.id===sale.value);const schedule=Array.isArray(selected?.creditSchedule)?selected.creditSchedule:[];installment.replaceChildren();const hasInstallmentPayments=Object.keys(selected?.creditInstallmentPaid||{}).length>0;const saleLevelOnly=Number(selected?.creditSaleLevelPaid||0)>0||selected?.creditNoteAdjusted===true;installment.hidden=!schedule.length||saleLevelOnly;if(installment.hidden)return;installment.add(new Option("Choose allocation method",""));if(!hasInstallmentPayments)installment.add(new Option("Sale balance (not tied to an installment)","SALE"));for(const [index,item] of schedule.entries()){const paid=Number(selected.creditInstallmentPaid?.[String(index+1)]||0);const remaining=Math.max(0,Number(item.amount)-paid);const option=new Option(`${item.dueDate} · remaining ${remaining.toFixed(2)} ${selected.currencyCode}`,String(index+1));option.disabled=remaining<=0;installment.add(option);}};sale.addEventListener("change",updateInstallments);updateInstallments();
  const amount=document.createElement("input");amount.type="number";amount.min="0.01";amount.step="0.01";amount.placeholder="Allocation";amount.dataset.field="amount";amount.setAttribute("aria-label","Payment allocation amount");const remove=document.createElement("button");remove.type="button";remove.className="button secondary";remove.textContent="Remove";remove.addEventListener("click",()=>row.remove());row.append(sale,installment,amount,remove);el("paymentAllocationRows").append(row);
}

async function loadStationTariffs() {
  if (!state.station) return; const result = await api(`/stations/${state.station.stationId}/tariffs`); const host = el("setupTariffList"); host.replaceChildren();
  for (const tariff of result.tariffs) { const row = document.createElement("div"); row.className = "history-row"; const product = state.catalogProducts.find(item => item.id === tariff.product_id); const strong = document.createElement("strong"); strong.textContent = `${product?.name || tariff.product_id} · ${tariff.unit_price}`; const detail = document.createElement("span"); detail.textContent = `${new Date(tariff.valid_from).toLocaleString()} to ${tariff.valid_until ? new Date(tariff.valid_until).toLocaleString() : "no end date"}`; row.append(strong, detail); host.append(row); }
  if (!result.tariffs.length) host.textContent = "No fuel tariffs configured.";
}

async function loadCalibrationHistory() {
  const tankId = el("calibrationTank").value; const host = el("calibrationHistory"); host.replaceChildren(); if (!tankId || !state.station) return;
  const result = await api(`/stations/${state.station.stationId}/tanks/${tankId}/calibrations`);
  for (const calibration of result.calibrations) {
    const row = document.createElement("div"); row.className = "history-row"; const detail = document.createElement("span"); detail.textContent = `${calibration.status} · effective ${calibration.effective_from} · ${calibration.points.length} chart points`; row.append(detail);
    const chart = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "Review supplied points"; const list = document.createElement("ul");
    for (const point of calibration.points) { const line = document.createElement("li"); line.textContent = `${point.depthMm} mm → ${point.volumeLiters} L`; list.append(line); }
    chart.append(summary, list); row.append(chart);
    if (calibration.status === "DRAFT") { const button = document.createElement("button"); button.className = "button secondary"; button.type = "button"; button.textContent = "Activate"; button.addEventListener("click", async () => { if (!confirm("Activate this supplied tank calibration chart? It will affect dip volume calculations from its effective date.")) return; try { await api(`/stations/${state.station.stationId}/tanks/${tankId}/calibrations/${calibration.id}/activate`, { method: "POST", body: {} }); await loadCalibrationHistory(); await loadDay(); } catch (error) { message(error.message, true); } }); row.append(button); }
    host.append(row);
  }
  if (!result.calibrations.length) host.textContent = "No calibration charts recorded for this tank.";
}

async function loadTankAssignmentHistory() {
  const nozzleId = el("setupAssignmentNozzle").value; const host = el("setupAssignmentHistory"); host.replaceChildren(); if (!nozzleId || !state.station) return;
  const result = await api(`/stations/${state.station.stationId}/equipment/${nozzleId}/tank-assignments`);
  for (const item of result.assignments) { const row = document.createElement("div"); row.className = "history-row"; const tank = state.setupEquipment.find(value => value.id === item.tank_id); row.textContent = `${tank?.code || item.tank_id} · ${new Date(item.valid_from).toLocaleString()} to ${item.valid_until ? new Date(item.valid_until).toLocaleString() : "current"}`; host.append(row); }
  if (!result.assignments.length) host.textContent = "No tank assignment recorded.";
}

async function loadMeterResetHistory() {
  const equipmentId = el("resetEquipment").value; const host = el("meterResetHistory"); host.replaceChildren(); if (!equipmentId || !state.station) return;
  const result = await api(`/stations/${state.station.stationId}/equipment/${equipmentId}/meter-resets`);
  for (const reset of result.resets) { const row = document.createElement("div"); row.className = "history-row"; row.textContent = `${reset.business_date} · ${reset.previous_index} → ${reset.new_initial_index} · ${reset.reason}`; host.append(row); }
  if (!result.resets.length) host.textContent = "No resets recorded for this meter.";
}

async function loadSupportConversation(id) {
  state.supportRequestId = id; const result = await api(`/client/support-requests/${id}/messages`); const host = el("clientSupportConversation"); host.replaceChildren();
  for (const entry of result.messages) { const line = document.createElement("p"); line.textContent = `${entry.message} · ${new Date(entry.createdAt).toLocaleString()}`; host.append(line); }
  if (!result.messages.length) host.textContent = "No replies yet.";
  el("clientSupportReply").hidden = false;
}

async function loadDay() {
  const station = state.station;
  if (!station) return;
  const date = el("businessDate").value;
  if (!date) return message("Choose a business date first.", true);
  message("Loading station day…");
  el("dayPanel").hidden = false;
  try {
    const [daily, equipmentData, productData, tariffData, inputsData, readingsData, allData, reconciliationData, inventoryData, varianceThresholdData] = await Promise.all([
      api(`/stations/${station.stationId}/daily-state?date=${encodeURIComponent(date)}`),
      api(`/stations/${station.stationId}/equipment`),
      api(`/stations/${station.stationId}/products`),
      api(`/stations/${station.stationId}/tariffs`),
      api(`/stations/${station.stationId}/day-inputs?date=${encodeURIComponent(date)}`),
      api(`/stations/${station.stationId}/readings?date=${encodeURIComponent(date)}`),
      api(`/stations/${station.stationId}/readings?before=${encodeURIComponent(date)}`),
      api(`/stations/${station.stationId}/day-inputs/${date}/reconciliations`),
      api(`/stations/${station.stationId}/inventory?date=${encodeURIComponent(date)}`),
      api(`/stations/${station.stationId}/financial-variance-thresholds`),
    ]);
    state.daily = daily;
    state.inventory = inventoryData.inventory;
    state.financialVarianceThreshold=varianceThresholdData.threshold;
    const canManageVariance=["OWNER","MANAGER","SUPER_ADMIN"].includes(currentRole());
    el("financialVarianceAdminControls").hidden=!canManageVariance;
    el("financialVarianceCurrency").value=state.financialVarianceThreshold?.currencyCode??"";
    el("cashVarianceLimit").value=state.financialVarianceThreshold?.maxAbsCashVariance??"";
    el("cardVarianceLimit").value=state.financialVarianceThreshold?.maxAbsCardVariance??"";
    el("financialVarianceReason").value="";
    if(state.financialVarianceThreshold)el("reconCurrency").value=state.financialVarianceThreshold.currencyCode;
    state.equipment = equipmentData.equipment.filter((item) => !item.retired_at);
    state.products = productData.products.filter((item) => item.product_type === "FUEL");
    state.saleProducts = productData.products;
    state.tariffs = tariffData.tariffs;
    state.dayInputs = inputsData.dayInputs;
    if (state.dayInputs?.currencyCode) el("reconCurrency").value = state.dayInputs.currencyCode;
    state.allReadings = allData.readings;
    renderReadings(readingsData.readings);
    renderTanks(state.equipment.filter((item) => item.kind === "TANK"), inputsData.dayInputs);
    renderReconciliation(reconciliationData.reconciliations);
    renderDaily();
    el("inventoryPanel").hidden = false;
    renderInventory();
    await loadInventoryWorkspace();
    el("reportDate").value = date;
    if (state.dayInputs) { el("countedCash").value = state.dayInputs.cash_total; el("settledCard").value = state.dayInputs.card_total; }
    message(`Showing ${station.name} for ${date}.`);
  } catch (error) { message(error.message, true); }
}

async function loadWorkspaces() {
  try {
    const [data, me] = await Promise.all([api("/workspaces"), api("/me")]);
    el("signInLink").hidden = true; el("signOutLink").hidden = false; el("invoicePrintPanel").hidden = false; document.querySelector("main > .context").hidden=false;
    el("platformAdminLink").hidden = me.role !== "SUPER_ADMIN";
    state.workspaces = data.workspaces;
    const selector = el("clientSelect");
    selector.replaceChildren(new Option("Choose a client", ""));
    selector.disabled = false;
    for (const workspace of state.workspaces) selector.add(new Option(workspace.clientName, workspace.clientId));
    const preferred = state.workspaces.find((item) => item.clientId === stored("stationClient")) || state.workspaces[0];
    if (preferred) { selector.value = preferred.clientId; await chooseClient(preferred.clientId); }
    else message("No client workspaces are linked to your account. Ask an administrator for access.", true);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return;
    message(error.message, true);
  }
}

async function chooseClient(clientId) {
  state.clientId = clientId;
  state.importHistoryNextCursor=null;state.importHistoryQuery="";state.importHistoryHasRows=false;
  save("stationClient", clientId);
  state.station = null;
  state.catalogProducts = []; state.stationProducts = []; state.setupEquipment = []; state.saleProducts = []; state.tariffs = [];
  state.customers = []; state.sales = []; state.vouchers = []; state.invoiceProfile = null; state.supportRequestId = "";
  const selector = el("stationSelect");
  selector.replaceChildren(new Option("Loading stations…", ""));
  selector.disabled = true;
  el("dayPanel").hidden = true;
  el("settingsPanel").hidden = true; el("catalogPanel").hidden = true; el("financePanel").hidden = true;
  el("stockManagementPanel").hidden = true;
  el("clientSupportPanel").hidden = !clientId; el("clientSupportRequests").replaceChildren(); el("clientSupportConversation").replaceChildren(); el("clientSupportReply").hidden = true;
  el("financeCustomerList").replaceChildren(); el("financeSalesList").replaceChildren(); el("voucherList").replaceChildren(); el("creditNoteList").replaceChildren();
  el("inventoryPanel").hidden = true;
  el("reportPanel").hidden = !clientId;
  const role = state.workspaces.find(item => item.clientId === clientId)?.role;
  el("importPanel").hidden = !clientId || !["OWNER", "MANAGER", "ACCOUNTANT", "SUPER_ADMIN"].includes(role);
  el("onboardingPanel").hidden = !clientId || !["OWNER", "MANAGER", "ACCOUNTANT", "SUPER_ADMIN"].includes(role);
  el("clientSupportPanel").hidden = !clientId;
  const importStation = el("importStation"); importStation.replaceChildren(new Option("No station / client history", ""));
  const historyStation=el("historyStation");historyStation.replaceChildren(new Option("All stations",""));
  el("historyFrom").value="";el("historyTo").value="";el("historyRecordType").value="";
  for (const station of state.workspaces.find(item => item.clientId === clientId)?.stations ?? []) { importStation.add(new Option(`${station.code} · ${station.name}`, station.stationId)); historyStation.add(new Option(`${station.code} · ${station.name}`,station.stationId)); }
  el("importPreview").replaceChildren(); el("importStatus").textContent = "";
  el("historyResults").replaceChildren();el("historyStatus").textContent="";el("loadOlderHistory").disabled=true;el("exportHistoryPage").disabled=true;
  el("dailyReportTable").replaceChildren();
  const workspaceRole = state.workspaces.find((item) => item.clientId === clientId)?.role;
  el("accountingExportControls").hidden = !["OWNER", "MANAGER", "ACCOUNTANT", "SUPER_ADMIN"].includes(workspaceRole);
  if (!clientId) return;
  try {
    await Promise.all([loadImportJobs(), loadOnboardingChecklist(), loadClientSupport(),loadImportedHistory()]);
    const workspace = state.workspaces.find((item) => item.clientId === clientId);
    selector.replaceChildren(new Option("Choose a station", ""));
    for (const station of workspace?.stations ?? []) selector.add(new Option(`${station.code} · ${station.name}`, station.stationId));
    selector.disabled = false;
    const preferred = (workspace?.stations ?? []).find((station) => station.stationId === stored("stationStation")) || workspace?.stations?.[0];
    if (preferred) { selector.value = preferred.stationId; await chooseStation(preferred.stationId); }
    else message("This client has no stations assigned to your account.", true);
  } catch (error) { message(error.message, true); }
}

async function chooseStation(stationId) {
  const workspace = state.workspaces.find((item) => item.clientId === state.clientId);
  state.station = workspace?.stations.find((item) => item.stationId === stationId) ?? null;
  state.financialVarianceThreshold=null;
  el("reconCurrency").value="";
  save("stationStation", stationId);
  state.saleProducts=[];state.tariffs=[];state.sales=[];state.customers=[];state.vouchers=[];state.invoiceProfile=null;
  el("saleLineRows").replaceChildren();el("saleTenderRows").replaceChildren();el("saleScheduleRows").replaceChildren();el("financeSalesList").replaceChildren();el("financeCustomerList").replaceChildren();el("voucherList").replaceChildren();el("creditNoteList").replaceChildren();
  el("invoiceLegalConfiguration").value="";el("invoicePrefix").value="";el("creditPrefix").value="";el("saleCurrency").value="";el("paymentCurrency").value="";el("voucherCurrency").value="";
  const canManage = ["OWNER", "MANAGER", "SUPER_ADMIN"].includes(workspace?.role);
  el("settingsPanel").hidden = !state.station || !canManage;
  el("catalogPanel").hidden = !state.station || !canManage;
  el("stockManagementPanel").hidden = !state.station || !canManage;
  state.serviceRecipe = [];
  el("supplierList").replaceChildren(); el("receiptHistory").replaceChildren(); el("stockMovementHistory").replaceChildren(); el("serviceRecipeRows").replaceChildren();
  if (state.station) {
    el("settingCutoff").value = String(state.station.closingCutoff ?? "").slice(0, 5);
    el("settingTimeZone").value = state.station.timeZone ?? "";
    el("settingMeterMode").value = state.station.meterMode;
    el("settingDayRule").value = state.station.closingDayRule ?? "";
    await Promise.all([loadDay(), canManage ? loadStationSetup() : Promise.resolve()]);
    await loadFinanceWorkspace();
  }
}

el("saveSettings").addEventListener("click", async () => {
  if (!state.station) return;
  try {
    const response = await api(`/stations/${state.station.stationId}/settings`, {
      method: "PATCH",
      body: {
        meterMode: el("settingMeterMode").value,
        closingCutoff: el("settingCutoff").value,
        timeZone: el("settingTimeZone").value.trim(),
        closingDayRule: el("settingDayRule").value || null,
      },
    });
    Object.assign(state.station, {
      meterMode: response.station.meter_mode,
      closingCutoff: response.station.closing_cutoff,
      timeZone: response.station.time_zone,
      closingDayRule: response.station.closing_day_rule,
    });
    const workspace = state.workspaces.find((item) => item.clientId === state.clientId);
    const station = workspace?.stations.find((item) => item.stationId === state.station.stationId);
    if (station) Object.assign(station, state.station);
    message("Station setup saved. The settings change is recorded in the audit trail.");
    await loadDay();
  } catch (error) { message(error.message, true); }
});

el("refreshFinance").addEventListener("click", () => void loadFinanceWorkspace().catch(error => message(error.message, true)));
el("createFinanceCustomer").addEventListener("click", async () => {
  try { await api("/customers", { method: "POST", body: { code: el("financeCustomerCode").value.trim(), displayName: el("financeCustomerName").value.trim(), contactEmail: el("financeCustomerEmail").value.trim() || null, contactPhone: el("financeCustomerPhone").value.trim() || null } }); el("financeCustomerCode").value="";el("financeCustomerName").value="";el("financeCustomerEmail").value="";el("financeCustomerPhone").value="";message("Customer added.");await loadFinanceWorkspace(); }
  catch(error){message(error.message,true);}
});
el("creditCustomer").addEventListener("change",()=>{
  const customer=state.customers.find(item=>item.id===el("creditCustomer").value);el("creditLimit").value=customer?.creditLimit??"";el("creditTermsDays").value=customer?.paymentTermsDays??"";el("creditStatus").value=customer?.creditStatus||"ACTIVE";
});
el("saveCreditAccount").addEventListener("click",async()=>{
  try{const customerId=el("creditCustomer").value;if(!customerId)throw new Error("Choose a customer.");await api(`/customers/${customerId}/credit-account`,{method:"PUT",body:{creditLimit:el("creditLimit").value,paymentTermsDays:el("creditTermsDays").value===""?null:Number(el("creditTermsDays").value),status:el("creditStatus").value}});message("Credit account saved. Payment terms are the supplied client value.");await loadFinanceWorkspace();}
  catch(error){message(error.message,true);}
});
el("addSaleLine").addEventListener("click",addSaleLine);
el("addSaleTender").addEventListener("click",addSaleTender);
el("addSaleScheduleInstallment").addEventListener("click",addSaleScheduleInstallment);
el("postFinanceSale").addEventListener("click",async()=>{
  try{
    const lineNodes=[...el("saleLineRows").querySelectorAll(".sale-line")],tenderNodes=[...el("saleTenderRows").querySelectorAll(".sale-tender")];if(!lineNodes.length||!tenderNodes.length)throw new Error("A sale requires at least one line and one tender.");if(!el("saleCurrency").value.trim())throw new Error("Enter the sale currency from the client setup.");
    const difference=Math.round((Number(el("saleTotalPreview").textContent.match(/difference: (-?\d+\.\d+)/)?.[1]||0))*100)/100;if(difference!==0)throw new Error("Payment tenders must balance exactly to the displayed sale total.");
    const lines=lineNodes.map(row=>({productId:row.querySelector('[data-field="productId"]').value||null,description:row.querySelector('[data-field="description"]').value.trim(),unitCode:row.querySelector('[data-field="unitCode"]').value.trim(),quantity:row.querySelector('[data-field="quantity"]').value,unitPrice:row.querySelector('[data-field="unitPrice"]').value,taxCode:row.querySelector('[data-field="taxCode"]').value.trim()||null,taxRatePercent:row.querySelector('[data-field="taxRatePercent"]').value}));
    const tenders=[...el("saleTenderRows").querySelectorAll(".sale-tender")].map(row=>{const type=row.querySelector('[data-field="type"]').value;return{type,amount:row.querySelector('[data-field="amount"]').value,reference:row.querySelector('[data-field="reference"]').value.trim()||null,...(type==="VOUCHER"?{voucherId:row.querySelector('[data-field="voucherId"]').value}:{})};});
    const scheduleRows=[...el("saleScheduleRows").querySelectorAll(".credit-installment")];const paymentSchedule=scheduleRows.map(row=>({dueDate:row.querySelector('[data-field="dueDate"]').value,amount:row.querySelector('[data-field="amount"]').value}));
    const result=await api(`/stations/${state.station.stationId}/sales`,{method:"POST",body:{customerId:el("saleCustomer").value||null,businessDate:el("saleBusinessDate").value,currencyCode:el("saleCurrency").value.trim(),lines,tenders,...(paymentSchedule.length?{paymentSchedule}:{}),creditOverrideReason:el("creditOverrideReason").value.trim()||null}});
    const scheduleCount=result.sale.creditSchedule?.length||0;const scheduleNote=scheduleCount?`Saved ${scheduleCount} planned installment(s).`:(result.sale.creditTermsDays==null?"No due date is set; add a schedule or configure account terms.":"No custom schedule was needed.");message(`Sale posted · ${result.sale.total} ${result.sale.currencyCode}. ${scheduleNote} Later payments still apply to the sale balance.`);el("saleLineRows").replaceChildren();el("saleTenderRows").replaceChildren();el("saleScheduleRows").replaceChildren();addSaleLine();addSaleTender();await loadFinanceWorkspace();
  }catch(error){message(error.message,true);}
});
el("issueVoucher").addEventListener("click",async()=>{
  try{const expiry=el("voucherExpiry").value?new Date(el("voucherExpiry").value).toISOString():null;await api("/vouchers",{method:"POST",body:{code:el("voucherCode").value.trim(),faceValue:el("voucherValue").value,currencyCode:el("voucherCurrency").value.trim(),expiresAt:expiry}});el("voucherCode").value="";el("voucherValue").value="";el("voucherExpiry").value="";message("Voucher issued with a tracked remaining balance.");await loadFinanceWorkspace();}
  catch(error){message(error.message,true);}
});
el("paymentCustomer").addEventListener("change",()=>el("paymentAllocationRows").replaceChildren());
el("addPaymentAllocation").addEventListener("click",()=>{if(!el("paymentCustomer").value){message("Choose a customer before adding allocations.",true);return;}addPaymentAllocation();});
el("recordFinancePayment").addEventListener("click",async()=>{
  try{const rows=[...el("paymentAllocationRows").querySelectorAll(".payment-allocation")];const allocations=rows.map(row=>{const field=row.querySelector('[data-field="installmentNumber"]');if(!field.hidden&&!field.value)throw new Error("Choose sale balance or a remaining installment for each scheduled sale.");return{saleId:row.querySelector('[data-field="saleId"]').value,amount:row.querySelector('[data-field="amount"]').value,installmentNumber:field.value&&field.value!=="SALE"?Number(field.value):null};});await api("/customer-payments",{method:"POST",body:{customerId:el("paymentCustomer").value,amount:el("paymentAmount").value,currencyCode:el("paymentCurrency").value.trim(),paymentMethod:el("paymentMethod").value,reference:el("paymentReference").value.trim()||null,allocations}});message("Customer payment recorded separately from sales.");el("paymentAmount").value="";el("paymentReference").value="";el("paymentAllocationRows").replaceChildren();await loadFinanceWorkspace();}
  catch(error){message(error.message,true);}
});
el("saveInvoiceProfile").addEventListener("click",async()=>{
  try{let legalConfiguration;try{legalConfiguration=JSON.parse(el("invoiceLegalConfiguration").value);}catch{throw new Error("Legal configuration must be valid JSON.");}if(!legalConfiguration||typeof legalConfiguration!=="object"||Array.isArray(legalConfiguration))throw new Error("Legal configuration must be a JSON object.");if(!el("invoicePrefix").value.trim()||!el("creditPrefix").value.trim())throw new Error("Enter the prefixes supplied by the client accountant.");await api("/client/invoice-profile",{method:"PUT",body:{legalConfiguration,invoicePrefix:el("invoicePrefix").value.trim(),creditNotePrefix:el("creditPrefix").value.trim()}});message("Invoice profile saved as a draft. Accountant approval is required before invoice issuance.");await loadFinanceWorkspace();}
  catch(error){message(error.message,true);}
});
el("approveInvoiceProfile").addEventListener("click",async()=>{
  try{if(!confirm("Confirm that the accountant has reviewed the supplied invoice and tax configuration?"))return;await api("/client/invoice-profile/approve",{method:"POST",body:{approvalStatement:el("invoiceApprovalStatement").value.trim(),approvalReference:el("invoiceApprovalReference").value.trim()||null}});message("Accountant approval recorded against the supplied profile.");await loadFinanceWorkspace();}
  catch(error){message(error.message,true);}
});
el("creditNoteInvoice").addEventListener("change",()=>void loadCreditNotes().catch(error=>message(error.message,true)));
el("issueCreditNote").addEventListener("click",async()=>{
  try{const invoiceId=el("creditNoteInvoice").value;if(!invoiceId)throw new Error("Choose an issued invoice.");if(el("creditNoteReceivable").value==="")throw new Error("Enter the receivable adjustment supplied by the accountant.");await api(`/invoices/${invoiceId}/credit-notes`,{method:"POST",body:{amount:el("creditNoteAmount").value,receivableAdjustment:el("creditNoteReceivable").value,reason:el("creditNoteReason").value.trim()}});message("Credit note issued from the approved invoice profile.");el("creditNoteAmount").value="";el("creditNoteReceivable").value="";el("creditNoteReason").value="";await Promise.all([loadFinanceWorkspace(),loadCreditNotes()]);}
  catch(error){message(error.message,true);}
});

el("refreshStationSetup").addEventListener("click", () => void loadStationSetup().catch(error => message(error.message, true)));
el("createSupplier").addEventListener("click", async () => {
  try {
    await api("/suppliers", { method: "POST", body: { code: el("supplierCode").value.trim(), name: el("supplierName").value.trim(), contactEmail: el("supplierEmail").value.trim() || null, contactPhone: el("supplierPhone").value.trim() || null } });
    el("supplierCode").value = ""; el("supplierName").value = ""; el("supplierEmail").value = ""; el("supplierPhone").value = "";
    message("Supplier added to this client."); await loadInventoryWorkspace();
  } catch (error) { message(error.message, true); }
});
el("fuelVarianceProduct").addEventListener("change", renderFuelVarianceThresholds);
el("saveFuelVariance").addEventListener("click", async () => {
  try {
    const productId=el("fuelVarianceProduct").value;
    if(!productId)throw new Error("Choose an assigned fuel product.");
    const reason=el("fuelVarianceReason").value.trim();
    if(!reason)throw new Error("Enter the client approval note or reference.");
    const raw=el("fuelVarianceLimit").value.trim();
    await api(`/stations/${state.station.stationId}/variance-thresholds`,{method:"PATCH",body:{productId,maxAbsVariance:raw===""?null:decimalValue(el("fuelVarianceLimit"),3),reason}});
    message(raw===""?"Fuel variance tolerance cleared. Closing behavior is unchanged.":"Fuel variance tolerance saved. It will flag review only and will not block closing.");
    await Promise.all([loadInventoryWorkspace(),loadDay()]);
  } catch(error){message(error.message,true);}
});
el("addReceiptLine").addEventListener("click", addReceiptLine);
el("postReceipt").addEventListener("click", async () => {
  try {
    const lines=[...el("receiptLineRows").querySelectorAll(".receipt-line")].map(row=>{const controls=row.querySelectorAll("select,input");const product=state.saleProducts.find(item=>item.id===controls[0].value);if(!product)throw new Error("Choose a product for every receipt line.");if(product.product_type==="FUEL"&&!controls[1].value)throw new Error(`Choose the receiving tank for ${product.name}.`);if(!controls[2].value||!controls[3].value)throw new Error(`Enter quantity and unit cost for ${product.name}.`);return{productId:product.id,tankId:product.product_type==="FUEL"?controls[1].value:null,quantity:controls[2].value,unitCost:controls[3].value};});
    await api(`/stations/${state.station.stationId}/purchase-receipts`, { method: "POST", body: { supplierId: el("receiptSupplier").value, businessDate: el("receiptDate").value, currencyCode: el("receiptCurrency").value.trim(), supplierReference: el("receiptReference").value.trim() || null, lines } });
    el("receiptReference").value = ""; el("receiptLineRows").replaceChildren();addReceiptLine();
    message("Receipt posted. Stock ledger entries are immutable."); await Promise.all([loadInventoryWorkspace(), loadDay()]);
  } catch (error) { message(error.message, true); }
});
el("saveStockAdjustment").addEventListener("click", async () => {
  try {
    await api(`/stations/${state.station.stationId}/stock-adjustments`, { method: "POST", body: { productId: el("adjustProduct").value, movementType: el("adjustType").value, businessDate: el("adjustDate").value, quantityDelta: el("adjustQuantity").value, reason: el("adjustReason").value.trim() } });
    el("adjustQuantity").value = ""; el("adjustReason").value = ""; message("Stock movement recorded with an audit reason."); await Promise.all([loadInventoryWorkspace(), loadDay()]);
  } catch (error) { message(error.message, true); }
});
el("serviceProduct").addEventListener("change", () => void loadServiceRecipe().catch(error => message(error.message, true)));
el("addServiceComponent").addEventListener("click", () => {
  const productId = el("serviceComponentProduct").value; const quantityPerService = el("serviceComponentQuantity").value;
  if (!productId || !quantityPerService || Number(quantityPerService) <= 0) { message("Choose an article and enter a positive component quantity.", true); return; }
  if (state.serviceRecipe.some(item => item.productId === productId)) { message("This article is already in the recipe.", true); return; }
  state.serviceRecipe.push({ productId, quantityPerService }); el("serviceComponentQuantity").value = ""; renderServiceRecipe();
});
el("saveServiceRecipe").addEventListener("click", async () => {
  try {
    const serviceId = el("serviceProduct").value; if (!serviceId) throw new Error("Choose a service product.");
    await api(`/stations/${state.station.stationId}/services/${serviceId}/components`, { method: "PUT", body: { components: state.serviceRecipe } });
    message("Service recipe saved. Future posted service sales consume its article components."); await loadServiceRecipe(); await Promise.all([loadInventoryWorkspace(), loadDay()]);
  } catch (error) { message(error.message, true); }
});
el("createSetupProduct").addEventListener("click", async () => {
  try {
    const result = await api(`/clients/${state.clientId}/products`, { method: "POST", body: { code: el("setupProductCode").value.trim(), name: el("setupProductName").value.trim(), productType: el("setupProductType").value, unitCode: el("setupProductUnit").value.trim() } });
    el("setupProductCode").value = ""; el("setupProductName").value = ""; message(`Created client product ${result.product.code}. Assign it to stations before use.`); await loadStationSetup();
  } catch (error) { message(error.message, true); }
});
el("assignSetupProduct").addEventListener("click", async () => {
  try { const productId = el("assignProduct").value; if (!productId) throw new Error("Choose a product to assign."); await api(`/stations/${state.station.stationId}/products/${productId}`, { method: "PUT" }); message("Product assigned to this station."); await Promise.all([loadStationSetup(), loadDay()]); }
  catch (error) { message(error.message, true); }
});
el("createSetupTariff").addEventListener("click", async () => {
  try { const validFrom = el("setupTariffFrom").value.trim(); if (!validFrom) throw new Error("Enter an effective timestamp including its UTC offset."); await api(`/stations/${state.station.stationId}/tariffs`, { method: "POST", body: { productId: el("tariffProduct").value, unitPrice: el("setupTariffPrice").value, validFrom } }); message("Effective-dated fuel tariff added to history."); await loadStationTariffs(); }
  catch (error) { message(error.message, true); }
});
function syncEquipmentFields() {
  const kind = el("setupEquipmentKind").value; const needsProduct = kind === "NOZZLE" || kind === "TANK"; const needsParent = kind === "NOZZLE";
  el("setupEquipmentProductWrap").hidden = !needsProduct; el("setupEquipmentParentWrap").hidden = !needsParent;
  el("setupEquipmentProduct").required = needsProduct; el("setupEquipmentParent").required = needsParent;
}
el("setupEquipmentKind").addEventListener("change", syncEquipmentFields); syncEquipmentFields();
el("createSetupEquipment").addEventListener("click", async () => {
  try { const kind = el("setupEquipmentKind").value; const result = await api(`/stations/${state.station.stationId}/equipment`, { method: "POST", body: { code: el("setupEquipmentCode").value.trim(), kind, serialNumber: el("setupEquipmentSerial").value.trim() || null, productId: ["NOZZLE", "TANK"].includes(kind) ? el("setupEquipmentProduct").value : null, parentEquipmentId: kind === "NOZZLE" ? el("setupEquipmentParent").value : null } }); el("setupEquipmentCode").value = ""; el("setupEquipmentSerial").value = ""; message(`Added ${result.equipment.kind.toLowerCase()} ${result.equipment.code}.`); await loadStationSetup(); }
  catch (error) { message(error.message, true); }
});
el("setupAssignmentNozzle").addEventListener("change", () => void loadTankAssignmentHistory().catch(error => message(error.message, true)));
el("saveTankAssignment").addEventListener("click", async () => {
  try { const validFrom = el("setupAssignmentFrom").value.trim() || new Date().toISOString(); const nozzleId = el("setupAssignmentNozzle").value; if (!nozzleId) throw new Error("Choose a nozzle."); await api(`/stations/${state.station.stationId}/equipment/${nozzleId}/tank-assignments`, { method: "POST", body: { tankId: el("setupAssignmentTank").value, validFrom } }); message("Tank assignment recorded in equipment history."); await loadTankAssignmentHistory(); }
  catch (error) { message(error.message, true); }
});
el("calibrationTank").addEventListener("change", () => void loadCalibrationHistory().catch(error => message(error.message, true)));
el("createCalibration").addEventListener("click", async () => {
  try {
    const points = el("calibrationPoints").value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => { const parts = line.split(",").map(part => part.trim()); if (parts.length !== 2 || parts.some(part => !/^(?:\d+\.?\d*|\.\d+)$/.test(part))) throw new Error(`Calibration line ${index + 1} must contain depth_mm,volume_litres.`); return { depthMm: parts[0], volumeLiters: parts[1] }; });
    await api(`/stations/${state.station.stationId}/tanks/${el("calibrationTank").value}/calibrations`, { method: "POST", body: { effectiveFrom: el("calibrationDate").value, points } }); message("Calibration chart saved as a draft. Review it, then activate it when confirmed against the tank chart."); el("calibrationPoints").value = ""; await loadCalibrationHistory();
  } catch (error) { message(error.message, true); }
});
el("resetEquipment").addEventListener("change", () => void loadMeterResetHistory().catch(error => message(error.message, true)));
el("recordMeterReset").addEventListener("click", async () => {
  try { await api(`/stations/${state.station.stationId}/equipment/${el("resetEquipment").value}/meter-resets`, { method: "POST", body: { businessDate: el("resetDate").value, previousIndex: el("resetPreviousIndex").value, newInitialIndex: el("resetNewIndex").value, reason: el("resetReason").value.trim(), newSerialNumber: el("resetNewSerial").value.trim() || null } }); message("Meter reset recorded. Its date and new initial index must match the next reading batch."); await loadMeterResetHistory(); await loadDay(); }
  catch (error) { message(error.message, true); }
});

el("clientSelect").addEventListener("change", (event) => void chooseClient(event.target.value));
el("refreshSupport").addEventListener("click", () => void loadClientSupport().catch(error => message(error.message, true)));
el("createSupportRequest").addEventListener("click", async () => {
  try {
    await api("/client/support-requests", { method: "POST", body: { category: el("supportCategory").value, subject: el("supportSubject").value.trim(), description: el("supportDescription").value.trim() } });
    el("supportSubject").value = ""; el("supportDescription").value = ""; message("Support request submitted."); await loadClientSupport();
  } catch (error) { message(error.message, true); }
});
el("sendSupportReply").addEventListener("click", async () => {
  try { if (!state.supportRequestId) return; const reply = el("supportReply").value.trim(); if (!reply) throw new Error("Enter a reply."); await api(`/client/support-requests/${state.supportRequestId}/messages`, { method: "POST", body: { message: reply } }); el("supportReply").value = ""; await Promise.all([loadSupportConversation(state.supportRequestId), loadClientSupport()]); }
  catch (error) { message(error.message, true); }
});
el("stationSelect").addEventListener("change", (event) => void chooseStation(event.target.value));
el("refreshButton").addEventListener("click", () => void loadDay());
el("businessDate").addEventListener("change", () => void loadDay());
el("refreshInventory").addEventListener("click", () => void loadDay());
el("loadClientReport").addEventListener("click", async () => {
  try {
    const report = await api(`/reports/daily-state?date=${encodeURIComponent(el("reportDate").value)}`);
    renderDailyReport(report);
    message(`Loaded the client overview for ${report.businessDate}.`);
  } catch (error) { message(error.message, true); }
});
el("exportDailyXlsx").addEventListener("click", async () => {
  try {
    const date = encodeURIComponent(el("reportDate").value);
    await downloadCsv(`/reports/daily-state.xlsx?date=${date}`);
    message("Daily overview downloaded as an Excel workbook.");
  } catch (error) { message(error.message, true); }
});
el("printDailyPdf").addEventListener("click", async () => {
  try {
    await openPrintView(`/reports/daily-state/print?date=${encodeURIComponent(el("reportDate").value)}`);
    message("Daily overview opened. Use Print or save as PDF in the new tab.");
  } catch (error) { message(error.message, true); }
});
el("exportAccountingXlsx").addEventListener("click", async () => {
  try {
    const from = encodeURIComponent(el("accountingFrom").value);
    const to = encodeURIComponent(el("accountingTo").value);
    await downloadCsv(`/reports/accounting-export.xlsx?from=${from}&to=${to}`);
    message("Accounting workbook downloaded. Payments and sales remain separate records.");
  } catch (error) { message(error.message, true); }
});

el("importKind").addEventListener("change", () => {
  const opening = el("importKind").value !== "HISTORICAL_RECORDS";
  el("importStation").required = opening;
  el("importStation").options[0].textContent = opening ? "Choose a station" : "No station / client history";
  el("importStation").options[0].value = "";
  if (opening && !el("importStation").value) el("importStation").selectedIndex = 0;
});
el("downloadImportTemplate").addEventListener("click", () => {
  const headers = importHeaders();
  const blob = new Blob([`${headers.join(",")}\r\n`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${el("importKind").value.toLowerCase()}-template.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
el("stageImport").addEventListener("click", async () => {
  try {
    const file = el("importFile").files[0]; if (!file) throw new Error("Choose an Excel workbook or CSV file.");
    if (file.size > 5_000_000) throw new Error("Import file must be 5 MB or smaller.");
    const rows = await importFileRows(file); if (rows.length > 5000) throw new Error("A single import can contain at most 5,000 data rows."); const kind = el("importKind").value; const stationId = el("importStation").value;
    if (kind !== "HISTORICAL_RECORDS" && !stationId) throw new Error("Choose a station for an opening balance.");
    const payload = { importKind: kind, stationId: stationId || null, sourceName: file.name, rows };
    if (new TextEncoder().encode(JSON.stringify(payload)).length > 5_000_000) throw new Error("Parsed import exceeds the 5 MB request limit. Split it into smaller batches.");
    const created = await api("/import-jobs", { method: "POST", body: payload });
    await loadImportJobs(); el("importJobSelect").value = created.jobId; await showImportJob(created.jobId);
    el("importStatus").textContent = "Staged only. Validate the preview before committing.";
  } catch (error) { el("importStatus").textContent = error.message; message(error.message, true); }
});
el("refreshImports").addEventListener("click", async () => { try { await Promise.all([loadImportJobs(),loadImportedHistory()]); await showImportJob(); } catch (error) { message(error.message, true); } });
el("searchHistory").addEventListener("click",async()=>{try{state.importHistoryNextCursor=null;state.importHistoryHasRows=false;await loadImportedHistory();}catch(error){message(error.message,true);}});
el("loadOlderHistory").addEventListener("click",async()=>{try{await loadImportedHistory({older:true});}catch(error){message(error.message,true);}});
el("exportHistoryPage").addEventListener("click",async()=>{try{await downloadCsv(`/import-history.csv${state.importHistoryQuery?`?${state.importHistoryQuery}`:""}`);message("The visible archive page was downloaded as CSV.");}catch(error){message(error.message,true);}});
el("importJobSelect").addEventListener("change", () => void showImportJob().catch(error => message(error.message, true)));
el("validateImport").addEventListener("click", async () => {
  try { const id = el("importJobSelect").value; if (!id) throw new Error("Choose an import job."); const result = await api(`/import-jobs/${id}/validate`, { method: "POST", body: {} }); await showImportJob(id); await loadImportJobs(); el("importJobSelect").value = id; el("importStatus").textContent = `${result.validCount} valid, ${result.invalidCount} invalid. ${result.canCommit ? "Review the rows, then commit when ready." : "Correct the file and stage a new job; commits are all-or-nothing."}`; }
  catch (error) { message(error.message, true); }
});
el("commitImport").addEventListener("click", async () => {
  const id = el("importJobSelect").value; if (!id || !confirm("Commit all rows in this validated import? This appends permanent archive or ledger records.")) return;
  try { const result = await api(`/import-jobs/${id}/commit`, { method: "POST", body: {} }); await Promise.all([loadImportJobs(),loadImportedHistory()]); await showImportJob(id); el("importStatus").textContent = `Committed ${result.importedCount} records. This import is immutable.`; }
  catch (error) { message(error.message, true); }
});

el("saveReadings").addEventListener("click", async () => {
  try {
    const readings = [];
    for (const item of state.meterRows) {
      const reading = {
        equipmentId: item.row.dataset.equipmentId,
        initialIndex: decimalValue(item.row.querySelectorAll("input")[0]),
        finalIndex: decimalValue(item.row.querySelectorAll("input")[1]),
      };
      if (item.allocationRow) {
        reading.productAllocations = [...item.allocationRow.querySelectorAll("[data-product]")]
          .filter((input) => input.value.trim() !== "")
          .map((input) => ({ productId: input.dataset.product, volume: decimalValue(input) }));
      }
      readings.push(reading);
    }
    const result = await api(`/stations/${state.station.stationId}/readings`, { method: "POST", body: { businessDate: el("businessDate").value, readings } });
    message(`Saved ${result.readings.length} meter readings. Validate the batch to lock it.`);
    await loadDay();
  } catch (error) { message(error.message, true); }
});

el("validateReadings").addEventListener("click", async (event) => {
  try { await api(`/stations/${state.station.stationId}/readings/${event.currentTarget.dataset.batchId}/validate`, { method: "POST", body: {} }); message("Meter readings validated and locked."); await loadDay(); }
  catch (error) { message(error.message, true); }
});

el("saveInputs").addEventListener("click", async () => {
  try {
    const dips = [...el("tankRows").querySelectorAll(".entry-row")].map((row) => {
      const fields = row.querySelectorAll("input");
      return { tankId: row.dataset.tankId, productDepthMm: decimalValue(fields[0]), waterDepthMm: fields[1].value.trim() ? decimalValue(fields[1]) : null };
    });
    await api(`/stations/${state.station.stationId}/day-inputs?date=${encodeURIComponent(el("businessDate").value)}`, {
      method: "PUT", body: { cashTotal: decimalValue(el("cashTotal"), 2), cardTotal: decimalValue(el("cardTotal"), 2), currencyCode: el("collectionsCurrency").value.trim().toUpperCase(), dips },
    });
    message("Cash, card and tank readings saved. Validate them to lock today’s inputs."); await loadDay();
  } catch (error) { message(error.message, true); }
});

el("validateInputs").addEventListener("click", async () => {
  try { await api(`/stations/${state.station.stationId}/day-inputs/${el("businessDate").value}/validate`, { method: "POST", body: {} }); message("Daily inputs validated and locked."); await loadDay(); }
  catch (error) { message(error.message, true); }
});

el("saveRecon").addEventListener("click", async () => {
  try {
    await api(`/stations/${state.station.stationId}/day-inputs/${el("businessDate").value}/reconciliations`, {
      method: "POST", body: {
        countedCashTotal: decimalValue(el("countedCash"), 2),
        cardSettlementTotal: decimalValue(el("settledCard"), 2),
        currencyCode: el("reconCurrency").value.trim().toUpperCase(),
        cardSettlementReference: el("settlementRef").value.trim() || undefined,
        reason: el("reconReason").value.trim() || "Daily cash and card reconciliation",
      },
    });
    message("Reconciliation recorded as a new immutable revision."); await loadDay();
  } catch (error) { message(error.message, true); }
});

el("saveFinancialVariance").addEventListener("click",async()=>{
  try{
    const cash=el("cashVarianceLimit").value.trim(),card=el("cardVarianceLimit").value.trim();
    if(cash===""&&card===""){
      if(!confirm("Clear the cash and card tolerances for this station?"))return;
    }
    const reason=el("financialVarianceReason").value.trim();
    if(!reason){message("An approval reason is required.",true);return;}
    await api(`/stations/${state.station.stationId}/financial-variance-thresholds`,{method:"PATCH",body:{
      currencyCode:el("financialVarianceCurrency").value.trim().toUpperCase(),
      maxAbsCashVariance:cash===""?null:decimalValue(el("cashVarianceLimit"),2),
      maxAbsCardVariance:card===""?null:decimalValue(el("cardVarianceLimit"),2),reason,
    }});
    message("Cash/card tolerances saved. They apply to future reconciliations and never block closing.");await loadDay();
  }catch(error){message(error.message,true);}
});

el("closeDay").addEventListener("click", async () => {
  if (!confirm("Close this station day? The closing snapshot is immutable; corrections are recorded as audited adjustments.")) return;
  try { await api(`/stations/${state.station.stationId}/daily-closing?date=${encodeURIComponent(el("businessDate").value)}`, { method: "POST", body: {} }); message("Station day closed. The operational snapshot is now locked."); await loadDay(); }
  catch (error) { message(error.message, true); }
});

function localDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
el("businessDate").value = localDate();
el("calibrationDate").value = localDate();
el("resetDate").value = localDate();
el("reportDate").value = localDate();
el("accountingFrom").value = localDate();
el("accountingTo").value = localDate();
el("printInvoice").addEventListener("click", async () => {
  const invoiceId = el("invoiceIdToPrint").value.trim();
  if (!state.clientId) { message("Choose a client first so the invoice stays within that workspace.", true); return; }
  if (!invoiceId) { message("Enter an issued invoice ID.", true); return; }
  const printTab = window.open("about:blank", "_blank");
  if (!printTab) { message("Allow a new tab to open the invoice print view.", true); return; }
  try {
    const response = await fetch(`/invoices/${encodeURIComponent(invoiceId)}/print`, {
      headers: { "X-Client-Id": state.clientId }, credentials: "same-origin",
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Could not load invoice (${response.status})`);
    }
    const html = await response.text();
    const printable = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    printTab.location.href = printable;
    setTimeout(() => URL.revokeObjectURL(printable), 60_000);
    message("Invoice print view opened. Use Print or save as PDF in the new tab.");
  } catch (error) {
    printTab.close();
    message(error.message, true);
  }
});
void loadWorkspaces();

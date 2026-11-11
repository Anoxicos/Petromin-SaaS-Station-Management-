import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "../domain/authorization.js";
import { withPrincipal } from "../infrastructure/db.js";
import { IdentityError } from "../infrastructure/identity.js";
import { createXlsx, createXlsxWorkbook } from "../infrastructure/xlsx.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendCsv(res: ServerResponse, filename: string, rows: readonly (readonly unknown[])[]): void {
  const encode = (value: unknown): string => {
    let text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
    // Quoting alone does not stop spreadsheet apps from evaluating formula-leading text.
    // Preserve plain signed numeric strings from PostgreSQL numeric columns.
    if (/^[\s]*[=+@]/.test(text) || (/^[\s]*-/.test(text) && !/^\s*-?\d+(?:\.\d+)?\s*$/.test(text))) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const csv = `\uFEFF${rows.map((row) => row.map(encode).join(",")).join("\r\n")}\r\n`;
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(csv);
}

function sendXlsx(res: ServerResponse, filename: string, rows: readonly (readonly unknown[])[], numericColumns: ReadonlySet<number>): void {
  sendXlsxBytes(res, filename, createXlsx(rows, numericColumns));
}

function sendXlsxBytes(res: ServerResponse, filename: string, contents: Uint8Array): void {
  res.writeHead(200, {
    "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(contents);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[character]!);
}

function selectedClient(principal: Principal): string {
  if (!principal.clientId) throw new IdentityError(400, "Select a client workspace first");
  return principal.clientId;
}

function authorize(principal: Principal): void {
  if (!["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER", "SUPER_ADMIN"].includes(principal.role)) {
    throw new IdentityError(403, "Insufficient role");
  }
}

function date(value: string | null, label: string): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new IdentityError(400, `${label} must use YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw new IdentityError(400, `Invalid ${label}`);
  return value;
}

export async function handleReportRoutes(
  req: IncomingMessage, res: ServerResponse, principal: Principal, url: URL,
): Promise<boolean> {
  const path = url.pathname;
  if (!["/reports/daily-state", "/reports/daily-state.csv", "/reports/daily-state.xlsx", "/reports/daily-state/print", "/reports/accounting-export.csv", "/reports/accounting-export.xlsx"].includes(path)) return false;
  const clientId = selectedClient(principal);
  authorize(principal);
  if (path === "/reports/daily-state" || path === "/reports/daily-state.csv" || path === "/reports/daily-state.xlsx" || path === "/reports/daily-state/print") {
    if (req.method !== "GET") return false;
    const businessDate = date(url.searchParams.get("date"), "date");
    const report = await withPrincipal(principal, async (db) => {
      const result = await db.query(
        `WITH sale_tenders AS (
           SELECT client_id,sale_id,COALESCE(sum(amount) FILTER (WHERE tender_type='CREDIT'),0) AS credit_amount
           FROM sales_transaction_tenders WHERE client_id=$1 GROUP BY client_id,sale_id
         ), sale_balances AS (
           SELECT client_id,sale_id,COALESCE(sum(amount_delta),0) AS current_balance
           FROM customer_credit_movements WHERE client_id=$1 AND sale_id IS NOT NULL GROUP BY client_id,sale_id
         ), sales_by_currency AS (
           SELECT sale.client_id,sale.station_id,sale.currency_code,
             COALESCE(sum(sale.total) FILTER (WHERE sale.business_date=$2),0) AS posted_sales_today,
             COALESCE(sum(tender.credit_amount) FILTER (WHERE sale.business_date=$2),0) AS credit_sales_today,
             COALESCE(sum(balance.current_balance) FILTER (WHERE sale.business_date<=$2),0) AS current_open_credit_through_date
           FROM sales_transactions sale
           LEFT JOIN sale_tenders tender ON tender.client_id=sale.client_id AND tender.sale_id=sale.id
           LEFT JOIN sale_balances balance ON balance.client_id=sale.client_id AND balance.sale_id=sale.id
           WHERE sale.client_id=$1 AND sale.status='POSTED' AND sale.business_date<=$2
           GROUP BY sale.client_id,sale.station_id,sale.currency_code
         ), by_station_financial AS (
           SELECT client_id,station_id,jsonb_agg(jsonb_build_object('currencyCode',currency_code,
             'postedSalesToday',posted_sales_today,'creditSalesToday',credit_sales_today,
             'currentOpenCreditThroughDate',current_open_credit_through_date) ORDER BY currency_code) AS sales_by_currency
           FROM sales_by_currency GROUP BY client_id,station_id
         ), by_product AS (
           SELECT batch.client_id,batch.station_id,
             COALESCE(allocation.product_id,equipment.product_id) AS product_id,
             product.code AS product_code,product.name AS product_name,product.unit_code,
             CASE WHEN batch.status='VALIDATED' THEN
               sum(CASE WHEN station.meter_mode='PUMP_TOTALIZER' THEN allocation.volume ELSE reading.volume END)
             END AS volume
           FROM meter_reading_batches batch
           JOIN stations station ON station.client_id=batch.client_id AND station.id=batch.station_id
           JOIN meter_readings reading ON reading.client_id=batch.client_id AND reading.station_id=batch.station_id AND reading.batch_id=batch.id
           JOIN station_equipment equipment ON equipment.client_id=reading.client_id AND equipment.station_id=reading.station_id AND equipment.id=reading.equipment_id
           LEFT JOIN meter_reading_product_allocations allocation ON allocation.client_id=reading.client_id AND allocation.station_id=reading.station_id AND allocation.reading_id=reading.id
           JOIN products product ON product.client_id=batch.client_id AND product.id=COALESCE(allocation.product_id,equipment.product_id)
           WHERE batch.client_id=$1 AND batch.business_date=$2
           GROUP BY batch.client_id,batch.station_id,batch.status,station.meter_mode,COALESCE(allocation.product_id,equipment.product_id),product.code,product.name,product.unit_code
         ), by_station AS (
           SELECT client_id,station_id,jsonb_agg(jsonb_build_object('productId',product_id,'code',product_code,'name',product_name,'unitCode',unit_code,'volume',volume) ORDER BY product_code) AS volumes
           FROM by_product GROUP BY client_id,station_id
         ), tank_totals AS (
           SELECT station.client_id,station.id AS station_id,count(tank.id) AS active_tanks,
             count(dip.id) FILTER (WHERE inputs.status='VALIDATED') AS validated_dips
           FROM stations station
           LEFT JOIN station_equipment tank ON tank.client_id=station.client_id AND tank.station_id=station.id AND tank.kind='TANK' AND tank.retired_at IS NULL
           LEFT JOIN station_day_inputs inputs ON inputs.client_id=station.client_id AND inputs.station_id=station.id AND inputs.business_date=$2
           LEFT JOIN station_day_dips dip ON dip.client_id=inputs.client_id AND dip.station_id=inputs.station_id AND dip.day_input_id=inputs.id AND dip.tank_id=tank.id
           WHERE station.client_id=$1 GROUP BY station.client_id,station.id
         )
         SELECT station.id AS "stationId",station.code AS "stationCode",station.name AS "stationName",station.meter_mode AS "meterMode",
           COALESCE(batch.status,'NOT_ENTERED') AS "meterStatus",COALESCE(volume.volumes,'[]'::jsonb) AS volumes,
           COALESCE(financial.sales_by_currency,'[]'::jsonb) AS "salesByCurrency",
           COALESCE(inputs.status,'NOT_ENTERED') AS "inputsStatus",inputs.cash_total AS "cashTotal",inputs.card_total AS "cardTotal",inputs.currency_code AS "collectionsCurrencyCode",
           CASE WHEN tanks.active_tanks=0 THEN 'NO_TANKS'
                WHEN inputs.status<>'VALIDATED' OR tanks.validated_dips<tanks.active_tanks THEN 'INCOMPLETE'
                ELSE 'VALIDATED' END AS "dipStatus",
           close.id IS NOT NULL AS "isClosed",close.closed_at AS "closedAt"
         FROM stations station
         LEFT JOIN meter_reading_batches batch ON batch.client_id=station.client_id AND batch.station_id=station.id AND batch.business_date=$2
         LEFT JOIN by_station volume ON volume.client_id=station.client_id AND volume.station_id=station.id
         LEFT JOIN by_station_financial financial ON financial.client_id=station.client_id AND financial.station_id=station.id
         LEFT JOIN station_day_inputs inputs ON inputs.client_id=station.client_id AND inputs.station_id=station.id AND inputs.business_date=$2
         LEFT JOIN tank_totals tanks ON tanks.client_id=station.client_id AND tanks.station_id=station.id
         LEFT JOIN station_day_closings close ON close.client_id=station.client_id AND close.station_id=station.id AND close.business_date=$2
         WHERE station.client_id=$1 ORDER BY station.code`, [clientId,businessDate]);
      return result.rows;
    });
    if (path.endsWith(".csv")) {
      sendCsv(res, `daily-state-${businessDate}.csv`, [
        ["businessDate","stationCode","stationName","meterMode","meterStatus","productVolumes","salesByCurrency","inputsStatus","cashTotal","cardTotal","collectionsCurrencyCode","dipStatus","isClosed","closedAt"],
        ...report.map((row) => [businessDate,row.stationCode,row.stationName,row.meterMode,row.meterStatus,row.volumes,row.salesByCurrency,row.inputsStatus,row.cashTotal,row.cardTotal,row.collectionsCurrencyCode,row.dipStatus,row.isClosed,row.closedAt]),
      ]);
    } else if (path.endsWith(".xlsx")) {
      const stationRows = [
        ["businessDate","stationCode","stationName","meterMode","meterStatus","productVolumes","inputsStatus","cashTotal","cardTotal","collectionsCurrencyCode","dipStatus","isClosed","closedAt"],
        ...report.map((row) => [businessDate,row.stationCode,row.stationName,row.meterMode,row.meterStatus,row.volumes,row.inputsStatus,row.cashTotal,row.cardTotal,row.collectionsCurrencyCode,row.dipStatus,row.isClosed,row.closedAt]),
      ];
      const salesRows: unknown[][] = [["businessDate","stationCode","stationName","currencyCode","postedSalesToday","creditSalesToday","currentOpenCreditThroughDate"]];
      for (const row of report) {
        const totals = Array.isArray(row.salesByCurrency) ? row.salesByCurrency : [];
        if (!totals.length) salesRows.push([businessDate,row.stationCode,row.stationName,"",0,0,0]);
        else for (const item of totals) salesRows.push([businessDate,row.stationCode,row.stationName,item.currencyCode,item.postedSalesToday,item.creditSalesToday,item.currentOpenCreditThroughDate]);
      }
      sendXlsxBytes(res, `daily-state-${businessDate}.xlsx`, createXlsxWorkbook([
        { name: "Station overview", rows: stationRows, numericColumns: new Set([7,8]) },
        { name: "Sales by currency", rows: salesRows, numericColumns: new Set([4,5,6]) },
      ]));
    } else if (path.endsWith("/print")) {
      const rows = report.map((row) => {
        const volumes = Array.isArray(row.volumes) ? row.volumes.map((item: { code?: unknown; volume?: unknown; unitCode?: unknown }) =>
          `${escapeHtml(item.code)}: ${escapeHtml(item.volume ?? "—")} ${escapeHtml(item.unitCode)}`).join(" · ") : "—";
        const sales = Array.isArray(row.salesByCurrency) ? row.salesByCurrency.map((item: { currencyCode?: unknown; postedSalesToday?: unknown; creditSalesToday?: unknown; currentOpenCreditThroughDate?: unknown }) =>
          `${escapeHtml(item.currencyCode)}: sales ${escapeHtml(item.postedSalesToday)}, credit ${escapeHtml(item.creditSalesToday)}, open now ${escapeHtml(item.currentOpenCreditThroughDate)}`).join(" · ") : "—";
        return `<tr><td>${escapeHtml(row.stationCode)} · ${escapeHtml(row.stationName)}</td><td>${escapeHtml(row.meterStatus)}</td><td>${volumes}</td><td>${sales || "—"}</td><td>${escapeHtml(row.inputsStatus)}</td><td>${escapeHtml(row.cashTotal ?? "—")}</td><td>${escapeHtml(row.cardTotal ?? "—")}</td><td>${escapeHtml(row.collectionsCurrencyCode ?? "Currency unset")}</td><td>${escapeHtml(row.dipStatus)}</td><td>${row.isClosed ? "Closed" : "Open"}</td></tr>`;
      }).join("");
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Daily report ${businessDate}</title><style>body{font:14px/1.5 Arial,sans-serif;color:#18211d;margin:0;background:#f3f6f4}.sheet{max-width:1100px;margin:32px auto;padding:36px;background:white;box-shadow:0 8px 30px #173b2810}h1{margin:4px 0 20px}.toolbar{text-align:right;margin-bottom:18px}button{padding:10px 16px;border:0;border-radius:6px;background:#087b50;color:white;font-weight:bold;cursor:pointer}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px;border-bottom:1px solid #e2e9e5}th{background:#f3f6f4}@media print{body{background:white}.sheet{max-width:none;margin:0;padding:8mm;box-shadow:none}.toolbar{display:none}}</style></head><body><main class="sheet"><div class="toolbar"><button onclick="window.print()">Print or save as PDF</button></div><small>Client ${escapeHtml(clientId)}</small><h1>Daily station overview · ${businessDate}</h1><table><thead><tr><th>Station</th><th>Meter</th><th>Volumes</th><th>Sales by currency</th><th>Inputs</th><th>Cash</th><th>Card</th><th>Collection currency</th><th>Dips</th><th>Close</th></tr></thead><tbody>${rows}</tbody></table></main></body></html>`;
      res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"});
      res.end(html);
    } else sendJson(res,200,{businessDate,clientId,stations:report});
    return true;
  }

  if ((path === "/reports/accounting-export.csv" || path === "/reports/accounting-export.xlsx") && req.method === "GET") {
    if (["CASHIER"].includes(principal.role)) throw new IdentityError(403,"Accounting export requires an owner, manager, or accountant");
    const from = date(url.searchParams.get("from"),"from");
    const to = date(url.searchParams.get("to"),"to");
    if (from>to) throw new IdentityError(400,"from must not be after to");
    const rows = await withPrincipal(principal, async (db) => {
      const [sales,invoices,notes,payments,purchases] = await Promise.all([
        db.query(`SELECT sale.id::text AS reference,sale.business_date AS document_date,station.code AS station_code,customer.display_name AS party,
          sale.currency_code AS currency,sale.total AS amount,sale.tax_total AS tax,
          jsonb_build_object('source','posted sale','tenders',(SELECT jsonb_agg(jsonb_build_object('type',t.tender_type,'amount',t.amount) ORDER BY t.recorded_at) FROM sales_transaction_tenders t WHERE t.sale_id=sale.id)) AS details
          FROM sales_transactions sale JOIN stations station ON station.client_id=sale.client_id AND station.id=sale.station_id
          LEFT JOIN customers customer ON customer.client_id=sale.client_id AND customer.id=sale.customer_id
          WHERE sale.client_id=$1 AND sale.status='POSTED' AND sale.business_date BETWEEN $2 AND $3
            AND NOT EXISTS (SELECT 1 FROM issued_invoices invoice WHERE invoice.client_id=sale.client_id AND invoice.sale_id=sale.id)`,[clientId,from,to]),
        db.query(`SELECT invoice.invoice_number AS reference,invoice.business_date AS document_date,station.code AS station_code,customer.display_name AS party,
          invoice.currency_code AS currency,invoice.total AS amount,invoice.tax_total AS tax,jsonb_build_object('source','issued invoice','saleId',invoice.sale_id) AS details
          FROM issued_invoices invoice JOIN stations station ON station.client_id=invoice.client_id AND station.id=invoice.station_id
          LEFT JOIN customers customer ON customer.client_id=invoice.client_id AND customer.id=invoice.customer_id
          WHERE invoice.client_id=$1 AND invoice.business_date BETWEEN $2 AND $3`,[clientId,from,to]),
        db.query(`SELECT note.credit_note_number AS reference,note.issued_at::date AS document_date,station.code AS station_code,customer.display_name AS party,
          invoice.currency_code AS currency,-note.amount AS amount,NULL::numeric AS tax,
          jsonb_build_object('source','credit note','reason',note.reason,'receivableAdjustment',note.receivable_adjustment,'invoiceId',note.invoice_id) AS details
          FROM issued_credit_notes note JOIN issued_invoices invoice ON invoice.client_id=note.client_id AND invoice.id=note.invoice_id
          JOIN stations station ON station.client_id=invoice.client_id AND station.id=invoice.station_id
          LEFT JOIN customers customer ON customer.client_id=note.client_id AND customer.id=note.customer_id
          WHERE note.client_id=$1 AND note.issued_at::date BETWEEN $2 AND $3`,[clientId,from,to]),
        db.query(`SELECT payment.id::text AS reference,payment.received_at::date AS document_date,NULL::text AS station_code,customer.display_name AS party,
          payment.currency_code AS currency,payment.amount AS amount,NULL::numeric AS tax,
          jsonb_build_object('source','customer payment','method',payment.payment_method,'reference',payment.reference,
            'allocations',(SELECT jsonb_agg(jsonb_build_object('saleId',allocation.sale_id,'amount',allocation.amount,
              'installmentNumber',allocation.installment_number)) FROM customer_payment_allocations allocation WHERE allocation.payment_id=payment.id)) AS details
          FROM customer_payments payment JOIN customers customer ON customer.client_id=payment.client_id AND customer.id=payment.customer_id
          WHERE payment.client_id=$1 AND payment.received_at::date BETWEEN $2 AND $3`,[clientId,from,to]),
        db.query(`SELECT receipt.id::text||':'||line.id::text AS reference,receipt.business_date AS document_date,station.code AS station_code,supplier.name AS party,
          receipt.currency_code AS currency,round(line.quantity*line.unit_cost,2) AS amount,NULL::numeric AS tax,
          jsonb_build_object('source','purchase receipt','productId',line.product_id,'quantity',line.quantity,'unitCost',line.unit_cost,'tankId',line.tank_id) AS details
          FROM purchase_receipts receipt JOIN purchase_receipt_lines line ON line.client_id=receipt.client_id AND line.station_id=receipt.station_id AND line.receipt_id=receipt.id
          JOIN stations station ON station.client_id=receipt.client_id AND station.id=receipt.station_id
          JOIN suppliers supplier ON supplier.client_id=receipt.client_id AND supplier.id=receipt.supplier_id
          WHERE receipt.client_id=$1 AND receipt.status='POSTED' AND receipt.business_date BETWEEN $2 AND $3`,[clientId,from,to]),
      ]);
      const map = (type: string, result: { rows: Array<Record<string, unknown>> }) => result.rows.map((row) => [
        type,row.reference,row.document_date,row.station_code,row.party,row.currency,row.amount,row.tax,row.details,
      ]);
      return [...map("SALE",sales),...map("INVOICE",invoices),...map("CREDIT_NOTE",notes),...map("CUSTOMER_PAYMENT",payments),...map("PURCHASE_RECEIPT_LINE",purchases)]
        .sort((a,b)=>String(a[2]).localeCompare(String(b[2]))||String(a[0]).localeCompare(String(b[0])));
    });
    const workbookRows = [["recordType","reference","documentDate","stationCode","counterparty","currencyCode","amount","taxAmount","details"],...rows];
    if (path.endsWith(".xlsx")) sendXlsx(res,`accounting-export-${from}-to-${to}.xlsx`,workbookRows,new Set([6,7]));
    else sendCsv(res,`accounting-export-${from}-to-${to}.csv`,workbookRows);
    return true;
  }
  return false;
}

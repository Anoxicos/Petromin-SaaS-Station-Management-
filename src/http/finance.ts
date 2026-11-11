import type { IncomingMessage, ServerResponse } from "node:http";
import type { PoolClient } from "pg";
import type { Principal } from "../domain/authorization.js";
import { requireAccess } from "../domain/authorization.js";
import { withPrincipal } from "../infrastructure/db.js";
import { IdentityError } from "../infrastructure/identity.js";

type Body = Record<string, unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const code = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function htmlEscape(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

async function json(req: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 65_536) throw new IdentityError(400, "Request body is too large");
    chunks.push(bytes);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Body;
  } catch { throw new IdentityError(400, "Expected a valid JSON object"); }
}

function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new IdentityError(400, `Invalid ${field}`);
  return value.trim();
}

function decimal(value: unknown, field: string, positive = false, scale = 2): string {
  if (typeof value !== "string" && typeof value !== "number") throw new IdentityError(400, `Invalid ${field}`);
  const v = String(value);
  const pattern = new RegExp(`^(?:0|[1-9]\\d{0,11})(?:\\.\\d{1,${scale}})?$`);
  if (!pattern.test(v) || (positive && Number(v) <= 0)) {
    throw new IdentityError(400, `Invalid ${field}`);
  }
  return v;
}

function cents(amount: string): bigint {
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function tenant(principal: Principal): string {
  if (!principal.clientId) throw new IdentityError(400, "Select a client workspace first");
  return principal.clientId;
}

function role(principal: Principal, roles: readonly string[]): void {
  if (!roles.includes(principal.role)) throw new IdentityError(403, "Insufficient role");
}

function audit(client: PoolClient, clientId: string, actorId: string, action: string, type: string, entity: string, details: unknown, stationId: string | null = null) {
  return client.query(
    `INSERT INTO audit_events (client_id, station_id, actor_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [clientId, stationId, actorId, action, type, entity, JSON.stringify(details)],
  );
}

export async function handleFinanceRoutes(
  req: IncomingMessage, res: ServerResponse, principal: Principal, url: URL,
): Promise<boolean> {
  const route = url.pathname;
  if (!(route === "/customers" || /^\/customers\/[^/]+\/credit-account$/.test(route)
    || /^\/stations\/[^/]+\/sales(?:\/[^/]+)?(?:\/invoice)?$/.test(route)
    || route === "/customer-payments" || route === "/vouchers" || /^\/vouchers\/[^/]+\/(?:status|cancel)$/.test(route)
    || route === "/client/invoice-profile" || route === "/client/invoice-profile/approve"
    || /^\/invoices\/[^/]+\/(?:credit-notes|print)$/.test(route))) return false;
  const clientId = tenant(principal);
  if (url.pathname === "/customers" && req.method === "GET") {
    role(principal, ["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER", "SUPER_ADMIN"]);
    const customers = await withPrincipal(principal, async (db) => {
      const result = await db.query(
        `SELECT c.id, c.code, c.display_name AS "displayName", c.contact_email AS "contactEmail",
                c.contact_phone AS "contactPhone", c.is_active AS "isActive", c.created_at AS "createdAt",
                a.credit_limit AS "creditLimit", a.payment_terms_days AS "paymentTermsDays", a.status AS "creditStatus",
                COALESCE((SELECT sum(m.amount_delta) FROM customer_credit_movements m
                  WHERE m.client_id=c.client_id AND m.customer_id=c.id), 0) AS "outstandingBalance"
         FROM customers c LEFT JOIN customer_credit_accounts a
           ON a.client_id=c.client_id AND a.customer_id=c.id
         WHERE c.client_id=$1 ORDER BY c.display_name, c.code`, [clientId]);
      return result.rows;
    });
    send(res, 200, { customers }); return true;
  }
  if (url.pathname === "/customers" && req.method === "POST") {
    role(principal, ["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER", "SUPER_ADMIN"]);
    const body = await json(req);
    const customerCode = text(body.code, "customer code", 32).toUpperCase();
    if (!code.test(customerCode)) throw new IdentityError(400, "Customer code must use letters, digits, _ or -");
    const name = text(body.displayName, "display name");
    const email = body.contactEmail == null || body.contactEmail === "" ? null : text(body.contactEmail, "contact email", 254);
    const phone = body.contactPhone == null || body.contactPhone === "" ? null : text(body.contactPhone, "contact phone", 40);
    const customer = await withPrincipal(principal, async (db) => {
      const result = await db.query(
        `INSERT INTO customers (client_id,code,display_name,contact_email,contact_phone,created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,code,display_name AS "displayName",contact_email AS "contactEmail",contact_phone AS "contactPhone",is_active AS "isActive"`,
        [clientId, customerCode, name, email, phone, principal.userId]);
      const row = result.rows[0] as { id: string };
      await audit(db, clientId, principal.userId, "CUSTOMER_CREATED", "customer", row.id, { code: customerCode });
      return result.rows[0];
    });
    send(res, 201, { customer }); return true;
  }
  const creditMatch = url.pathname.match(/^\/customers\/([^/]+)\/credit-account$/);
  if (creditMatch && (req.method === "PUT" || req.method === "GET")) {
    const [, customerId] = creditMatch;
    if (!uuid.test(customerId)) throw new IdentityError(404, "Customer not found");
    role(principal, req.method === "GET" ? ["OWNER", "MANAGER", "ACCOUNTANT", "SUPER_ADMIN"] : ["OWNER", "MANAGER", "SUPER_ADMIN"]);
    if (req.method === "GET") {
      const result = await withPrincipal(principal, (db) => db.query(
        `SELECT customer_id AS "customerId",credit_limit AS "creditLimit",payment_terms_days AS "paymentTermsDays",status,updated_at AS "updatedAt"
         FROM customer_credit_accounts WHERE client_id=$1 AND customer_id=$2`, [clientId, customerId]));
      send(res, 200, { creditAccount: result.rows[0] ?? null }); return true;
    }
    const body = await json(req);
    const limit = decimal(body.creditLimit, "credit limit", false, 2);
    const terms = body.paymentTermsDays == null ? null : Number(body.paymentTermsDays);
    if (terms !== null && (!Number.isInteger(terms) || terms < 0 || terms > 3650)) throw new IdentityError(400, "Invalid payment terms");
    const status = body.status ?? "ACTIVE";
    if (!(["ACTIVE", "ON_HOLD", "CLOSED"] as unknown[]).includes(status)) throw new IdentityError(400, "Invalid credit status");
    const result = await withPrincipal(principal, async (db) => {
      const saved = await db.query(
        `INSERT INTO customer_credit_accounts (client_id,customer_id,credit_limit,payment_terms_days,status,updated_by)
         SELECT $1,id,$3,$4,$5,$6 FROM customers WHERE client_id=$1 AND id=$2 AND is_active
         ON CONFLICT (client_id,customer_id) DO UPDATE SET credit_limit=EXCLUDED.credit_limit,payment_terms_days=EXCLUDED.payment_terms_days,status=EXCLUDED.status,updated_by=EXCLUDED.updated_by,updated_at=now()
         RETURNING customer_id AS "customerId",credit_limit AS "creditLimit",payment_terms_days AS "paymentTermsDays",status,updated_at AS "updatedAt"`,
        [clientId, customerId, limit, terms, status, principal.userId]);
      if (!saved.rowCount) throw new IdentityError(404, "Active customer not found");
      await audit(db, clientId, principal.userId, "CUSTOMER_CREDIT_ACCOUNT_SET", "customer", customerId,
        { creditLimit: limit, paymentTermsDays: terms, status });
      return saved.rows[0];
    });
    send(res, 200, { creditAccount: result }); return true;
  }
  const stationSale = url.pathname.match(/^\/stations\/([^/]+)\/sales$/);
  if (stationSale && req.method === "GET") {
    const [, stationId] = stationSale;
    if (!uuid.test(stationId)) throw new IdentityError(404, "Station not found");
    role(principal, ["OWNER", "MANAGER", "ACCOUNTANT", "SUPER_ADMIN"]);
    requireAccess(principal, { clientId, stationId });
    const result = await withPrincipal(principal, (db) => db.query(
      `SELECT s.id,s.customer_id AS "customerId",c.display_name AS "customerName",s.business_date AS "businessDate",
        s.currency_code AS "currencyCode",s.status,s.subtotal,s.tax_total AS "taxTotal",s.total,s.posted_at AS "postedAt",
        s.credit_terms_days_snapshot AS "creditTermsDays",s.credit_due_date AS "creditDueDate",s.credit_schedule_snapshot AS "creditSchedule",
        COALESCE((SELECT jsonb_object_agg(pa.installment_number::text,pa.paid) FROM (
          SELECT installment_number,sum(amount) AS paid FROM customer_payment_allocations
          WHERE client_id=s.client_id AND sale_id=s.id AND installment_number IS NOT NULL GROUP BY installment_number
        ) pa),'{}'::jsonb) AS "creditInstallmentPaid",
        COALESCE((SELECT sum(a.amount) FROM customer_payment_allocations a WHERE a.client_id=s.client_id AND a.sale_id=s.id
          AND a.installment_number IS NULL),0) AS "creditSaleLevelPaid",
        EXISTS (SELECT 1 FROM issued_credit_notes cn WHERE cn.client_id=s.client_id AND cn.sale_id=s.id
          AND cn.receivable_adjustment>0) AS "creditNoteAdjusted",
        COALESCE((SELECT sum(m.amount_delta) FROM customer_credit_movements m WHERE m.client_id=s.client_id AND m.sale_id=s.id),0) AS "creditBalance",
        i.id AS "invoiceId",i.invoice_number AS "invoiceNumber"
       FROM sales_transactions s LEFT JOIN customers c ON c.client_id=s.client_id AND c.id=s.customer_id
       LEFT JOIN issued_invoices i ON i.client_id=s.client_id AND i.sale_id=s.id
       WHERE s.client_id=$1 AND s.station_id=$2 ORDER BY s.posted_at DESC NULLS LAST,s.created_at DESC LIMIT 200`,
      [clientId, stationId]));
    send(res, 200, { sales: result.rows }); return true;
  }
  if (stationSale && req.method === "POST") {
    const [, stationId] = stationSale;
    if (!uuid.test(stationId)) throw new IdentityError(404, "Station not found");
    role(principal, ["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER", "SUPER_ADMIN"]);
    requireAccess(principal, { clientId, stationId });
    const body = await json(req);
    const customerId = body.customerId == null || body.customerId === "" ? null : text(body.customerId, "customer id", 36);
    if (customerId && !uuid.test(customerId)) throw new IdentityError(400, "Invalid customer id");
    const businessDate = text(body.businessDate, "business date", 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate) || Number.isNaN(Date.parse(`${businessDate}T00:00:00Z`))) throw new IdentityError(400, "Invalid business date");
    const currency = text(body.currencyCode, "currency code", 3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new IdentityError(400, "Currency code must be three letters");
    if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > 100) throw new IdentityError(400, "Sale needs 1 to 100 lines");
    if (!Array.isArray(body.tenders) || body.tenders.length < 1 || body.tenders.length > 20) throw new IdentityError(400, "Sale needs 1 to 20 tenders");
    const lines = body.lines.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new IdentityError(400, "Invalid sale line");
      const line = item as Body;
      const productId = line.productId == null || line.productId === "" ? null : text(line.productId, "product id", 36);
      if (productId && !uuid.test(productId)) throw new IdentityError(400, "Invalid product id");
      const description = text(line.description, "line description", 300);
      const unitCode = text(line.unitCode, "unit code", 16).toUpperCase();
      if (!/^[A-Z][A-Z0-9_-]{0,15}$/.test(unitCode)) throw new IdentityError(400, "Invalid unit code");
      const quantity = decimal(line.quantity, "quantity", true, 3);
      const unitPrice = decimal(line.unitPrice, "unit price", false, 4);
      const taxRate = decimal(line.taxRatePercent, "tax rate", false, 4);
      if (Number(taxRate) > 100) throw new IdentityError(400, "Invalid tax rate");
      const taxCode = line.taxCode == null || line.taxCode === "" ? null : text(line.taxCode, "tax code", 40);
      return { productId, description, unitCode, quantity, unitPrice, taxRate, taxCode };
    });
    const tenders = body.tenders.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new IdentityError(400, "Invalid sale tender");
      const tender = item as Body;
      const kind = text(tender.type, "tender type", 12).toUpperCase();
      if (!["CASH", "CARD", "CREDIT", "VOUCHER"].includes(kind)) throw new IdentityError(400, "Invalid tender type");
      const amount = decimal(tender.amount, "tender amount", true, 2);
      if ((kind === "CREDIT") !== Boolean(customerId)) {
        if (kind === "CREDIT") throw new IdentityError(400, "Credit tender requires a customer");
      }
      const voucherId = kind === "VOUCHER" ? text(tender.voucherId, "voucher id", 36) : null;
      if (voucherId && !uuid.test(voucherId)) throw new IdentityError(400, "Invalid voucher id");
      return { kind, amount, voucherId, reference: tender.reference == null || tender.reference === "" ? null : text(tender.reference, "tender reference", 160) };
    });
    let paymentSchedule: { dueDate: string; amount: string }[] = [];
    if (body.paymentSchedule !== undefined) {
      if (!Array.isArray(body.paymentSchedule) || body.paymentSchedule.length < 1 || body.paymentSchedule.length > 60) {
        throw new IdentityError(400, "A payment schedule must contain 1 to 60 installments");
      }
      paymentSchedule = body.paymentSchedule.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new IdentityError(400, "Invalid payment installment");
        const installment = item as Body;
        const dueDate = text(installment.dueDate, "installment due date", 10);
        const parsed = new Date(`${dueDate}T00:00:00.000Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== dueDate || dueDate < businessDate) {
          throw new IdentityError(400, "Installment dates must be valid ISO dates on or after the sale date");
        }
        return { dueDate, amount: decimal(installment.amount, "installment amount", true, 2) };
      });
      for (let index = 1; index < paymentSchedule.length; index += 1) {
        if (paymentSchedule[index]!.dueDate <= paymentSchedule[index - 1]!.dueDate) {
          throw new IdentityError(400, "Installment dates must be in increasing order");
        }
      }
      const scheduledCents = paymentSchedule.reduce((sum, item) => sum + cents(item.amount), 0n);
      const creditCents = tenders.filter((item) => item.kind === "CREDIT").reduce((sum, item) => sum + cents(item.amount), 0n);
      if (creditCents === 0n || scheduledCents !== creditCents) throw new IdentityError(400, "Installment amounts must equal the credit tender total");
    }
    const overrideReason = body.creditOverrideReason == null || body.creditOverrideReason === "" ? null : text(body.creditOverrideReason, "credit override reason", 500);
    if (overrideReason && !["OWNER", "MANAGER", "SUPER_ADMIN"].includes(principal.role)) throw new IdentityError(403, "Credit override requires owner or manager role");
    const result = await withPrincipal(principal, async (db) => {
      const sale = await db.query<{ id: string }>(
        `INSERT INTO sales_transactions (client_id,station_id,customer_id,business_date,currency_code,created_by,credit_override_reason,credit_overridden_by,credit_schedule_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING id`,
        [clientId, stationId, customerId, businessDate, currency, principal.userId, overrideReason, overrideReason ? principal.userId : null, JSON.stringify(paymentSchedule)]);
      const saleId = sale.rows[0]!.id;
      for (const [index, line] of lines.entries()) {
        await db.query(
          `INSERT INTO sales_transaction_lines (client_id,station_id,sale_id,line_number,product_id,description,unit_code,quantity,unit_price,tax_code,tax_rate_percent)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [clientId, stationId, saleId, index + 1, line.productId, line.description, line.unitCode, line.quantity, line.unitPrice, line.taxCode, line.taxRate]);
      }
      for (const tender of tenders) {
        await db.query(
          `INSERT INTO sales_transaction_tenders (client_id,station_id,sale_id,tender_type,amount,voucher_id,reference,recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [clientId, stationId, saleId, tender.kind, tender.amount, tender.voucherId, tender.reference, principal.userId]);
      }
      const totals = await db.query(
        `SELECT sum(subtotal) subtotal,sum(tax_amount) tax_total,sum(total) total FROM sales_transaction_lines WHERE sale_id=$1`, [saleId]);
      await db.query(
        `UPDATE sales_transactions SET subtotal=$2,tax_total=$3,total=$4,status='POSTED',posted_by=$5,posted_at=now()
         WHERE client_id=$1 AND id=$6`, [clientId, totals.rows[0]!.subtotal, totals.rows[0]!.tax_total, totals.rows[0]!.total, principal.userId, saleId]);
      const posted = await db.query(
        `SELECT id,station_id AS "stationId",customer_id AS "customerId",business_date AS "businessDate",currency_code AS "currencyCode",status,subtotal,tax_total AS "taxTotal",total,posted_at AS "postedAt",
          credit_terms_days_snapshot AS "creditTermsDays",credit_due_date AS "creditDueDate",credit_schedule_snapshot AS "creditSchedule"
         FROM sales_transactions WHERE id=$1`, [saleId]);
      await audit(db, clientId, principal.userId, "SALE_POSTED", "sales_transaction", saleId, {
        total: totals.rows[0]!.total,
        currencyCode: currency,
        ...(overrideReason ? { creditOverrideReason: overrideReason } : {}),
      }, stationId);
      return posted.rows[0];
    });
    send(res, 201, { sale: result }); return true;
  }
  const saleRoute = url.pathname.match(/^\/stations\/([^/]+)\/sales\/([^/]+)$/);
  if (saleRoute && req.method === "GET") {
    const [, stationId, saleId] = saleRoute;
    if (!uuid.test(stationId) || !uuid.test(saleId)) throw new IdentityError(404, "Sale not found");
    role(principal, ["OWNER", "MANAGER", "ACCOUNTANT", "SUPER_ADMIN"]);
    requireAccess(principal, { clientId, stationId });
    const sale = await withPrincipal(principal, async (db) => {
      const result = await db.query(
        `SELECT s.id,s.station_id AS "stationId",s.customer_id AS "customerId",c.display_name AS "customerName",s.business_date AS "businessDate",s.currency_code AS "currencyCode",s.status,s.subtotal,s.tax_total AS "taxTotal",s.total,s.posted_at AS "postedAt",
          s.credit_terms_days_snapshot AS "creditTermsDays",s.credit_due_date AS "creditDueDate",s.credit_schedule_snapshot AS "creditSchedule",
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id',l.id,'productId',l.product_id,'description',l.description,'unitCode',l.unit_code,'quantity',l.quantity,'unitPrice',l.unit_price,'taxCode',l.tax_code,'taxRatePercent',l.tax_rate_percent,'subtotal',l.subtotal,'taxAmount',l.tax_amount,'total',l.total) ORDER BY l.line_number) FROM sales_transaction_lines l WHERE l.sale_id=s.id),'[]'::jsonb) AS lines,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id',t.id,'type',t.tender_type,'amount',t.amount,'reference',t.reference) ORDER BY t.recorded_at) FROM sales_transaction_tenders t WHERE t.sale_id=s.id),'[]'::jsonb) AS tenders
         FROM sales_transactions s LEFT JOIN customers c ON c.client_id=s.client_id AND c.id=s.customer_id
         WHERE s.client_id=$1 AND s.station_id=$2 AND s.id=$3`, [clientId, stationId, saleId]);
      return result.rows[0] ?? null;
    });
    if (!sale) throw new IdentityError(404, "Sale not found");
    send(res, 200, { sale }); return true;
  }
  if (url.pathname === "/customer-payments" && req.method === "POST") {
    role(principal, ["OWNER", "MANAGER", "ACCOUNTANT", "SUPER_ADMIN"]);
    const body = await json(req);
    const customerId = text(body.customerId, "customer id", 36);
    if (!uuid.test(customerId)) throw new IdentityError(400, "Invalid customer id");
    const amount = decimal(body.amount, "payment amount", true, 2);
    const currency = text(body.currencyCode, "currency code", 3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new IdentityError(400, "Currency code must be three letters");
    const method = text(body.paymentMethod, "payment method", 20).toUpperCase();
    if (!["CASH", "CARD", "BANK_TRANSFER", "CHEQUE", "OTHER"].includes(method)) throw new IdentityError(400, "Invalid payment method");
    const reference = body.reference == null || body.reference === "" ? null : text(body.reference, "payment reference", 160);
    const allocations = body.allocations == null ? [] : body.allocations;
    if (!Array.isArray(allocations) || allocations.length > 100) throw new IdentityError(400, "Invalid payment allocations");
    const payment = await withPrincipal(principal, async (db) => {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO customer_payments (client_id,customer_id,currency_code,amount,payment_method,reference,received_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [clientId, customerId, currency, amount, method, reference, principal.userId]);
      const paymentId = inserted.rows[0]!.id;
      let allocated = 0n;
      for (const item of allocations) {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new IdentityError(400, "Invalid payment allocation");
        const allocation = item as Body;
        const saleId = text(allocation.saleId, "sale id", 36);
        if (!uuid.test(saleId)) throw new IdentityError(400, "Invalid sale id");
        const allocatedAmount = decimal(allocation.amount, "allocation amount", true, 2);
        const installmentNumber = allocation.installmentNumber == null || allocation.installmentNumber === ""
          ? null : Number(allocation.installmentNumber);
        if (installmentNumber !== null && (!Number.isInteger(installmentNumber) || installmentNumber < 1 || installmentNumber > 60)) {
          throw new IdentityError(400, "Installment number must be between 1 and 60");
        }
        allocated += cents(allocatedAmount);
        await db.query(
          `INSERT INTO customer_payment_allocations (client_id,payment_id,sale_id,amount,allocated_by,installment_number) VALUES ($1,$2,$3,$4,$5,$6)`,
          [clientId, paymentId, saleId, allocatedAmount, principal.userId, installmentNumber]);
      }
      if (allocated > cents(amount)) throw new IdentityError(400, "Allocations exceed the payment amount");
      await audit(db, clientId, principal.userId, "CUSTOMER_PAYMENT_RECEIVED", "customer_payment", paymentId, { amount, currencyCode: currency, allocated: allocated.toString() });
      const result = await db.query(
        `SELECT id,customer_id AS "customerId",currency_code AS "currencyCode",amount,payment_method AS "paymentMethod",reference,received_at AS "receivedAt"
         FROM customer_payments WHERE id=$1`, [paymentId]);
      return result.rows[0];
    });
    send(res, 201, { payment }); return true;
  }
  if (url.pathname === "/vouchers" && (req.method === "GET" || req.method === "POST")) {
    role(principal, req.method === "GET" ? ["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER", "SUPER_ADMIN"] : ["OWNER", "MANAGER", "SUPER_ADMIN"]);
    if (req.method === "GET") {
      const rows = await withPrincipal(principal, (db) => db.query(
        `SELECT v.id,v.code,v.currency_code AS "currencyCode",v.face_value AS "faceValue",
          v.face_value+COALESCE(sum(m.amount_delta),0) AS "remainingBalance",
          CASE WHEN v.status='ACTIVE' AND v.expires_at IS NOT NULL AND v.expires_at<=now() THEN 'EXPIRED'
               WHEN v.status='ACTIVE' AND v.face_value+COALESCE(sum(m.amount_delta),0)=0 THEN 'REDEEMED' ELSE v.status END AS status,
          v.issued_at AS "issuedAt",v.expires_at AS "expiresAt",
          v.cancelled_at AS "cancelledAt",v.cancellation_reason AS "cancellationReason"
         FROM vouchers v LEFT JOIN voucher_movements m ON m.client_id=v.client_id AND m.voucher_id=v.id
         WHERE v.client_id=$1 GROUP BY v.id ORDER BY v.issued_at DESC`, [clientId]));
      send(res, 200, { vouchers: rows.rows }); return true;
    }
    const body = await json(req);
    const voucherCode = text(body.code, "voucher code", 80);
    const value = decimal(body.faceValue, "voucher face value", true, 2);
    const currency = text(body.currencyCode, "currency code", 3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new IdentityError(400, "Currency code must be three letters");
    const expiresAt = body.expiresAt == null || body.expiresAt === "" ? null : text(body.expiresAt, "expiry date", 40);
    if (expiresAt && Number.isNaN(Date.parse(expiresAt))) throw new IdentityError(400, "Invalid expiry date");
    const voucher = await withPrincipal(principal, async (db) => {
      const result = await db.query(
        `INSERT INTO vouchers (client_id,code,currency_code,face_value,issued_by,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,code,currency_code AS "currencyCode",face_value AS "faceValue",status,issued_at AS "issuedAt",expires_at AS "expiresAt"`,
        [clientId, voucherCode, currency, value, principal.userId, expiresAt]);
      await audit(db, clientId, principal.userId, "VOUCHER_ISSUED", "voucher", result.rows[0]!.id, { code: voucherCode, faceValue: value, currencyCode: currency });
      return result.rows[0];
    });
    send(res, 201, { voucher }); return true;
  }
  const voucherStatusRoute = url.pathname.match(/^\/vouchers\/([^/]+)\/status$/);
  if (voucherStatusRoute && req.method === "PATCH") {
    const [, voucherId] = voucherStatusRoute;
    if (!uuid.test(voucherId)) throw new IdentityError(404, "Voucher not found");
    role(principal, ["OWNER", "MANAGER", "SUPER_ADMIN"]);
    const body = await json(req);
    const status = text(body.status, "voucher status", 16).toUpperCase();
    if (!["ACTIVE", "SUSPENDED", "EXPIRED"].includes(status)) throw new IdentityError(400, "Voucher status must be ACTIVE, SUSPENDED, or EXPIRED");
    const result = await withPrincipal(principal, async (db) => {
      const saved = await db.query(`UPDATE vouchers SET status=$3 WHERE client_id=$1 AND id=$2 RETURNING id,code,status`, [clientId,voucherId,status]);
      if (!saved.rowCount) throw new IdentityError(404, "Voucher not found");
      await audit(db, clientId, principal.userId, "VOUCHER_STATUS_CHANGED", "voucher", voucherId, { status });
      return saved.rows[0];
    });
    send(res, 200, { voucher: result }); return true;
  }
  const voucherCancelRoute = url.pathname.match(/^\/vouchers\/([^/]+)\/cancel$/);
  if (voucherCancelRoute && req.method === "POST") {
    const [, voucherId] = voucherCancelRoute;
    if (!uuid.test(voucherId)) throw new IdentityError(404, "Voucher not found");
    role(principal, ["OWNER", "MANAGER", "SUPER_ADMIN"]);
    const body = await json(req);
    const reason = text(body.reason, "cancellation reason", 500);
    const result = await withPrincipal(principal, async (db) => {
      const found = await db.query(
        `SELECT id,status FROM vouchers WHERE client_id=$1 AND id=$2 FOR UPDATE`, [clientId, voucherId]);
      if (!found.rowCount) throw new IdentityError(404, "Voucher not found");
      const voucher = found.rows[0] as { id: string; status: string };
      if (!["ACTIVE", "SUSPENDED"].includes(voucher.status)) throw new IdentityError(409, "Only an active or suspended voucher can be cancelled");
      const balance = await db.query(
        `SELECT v.face_value+COALESCE(sum(m.amount_delta),0) AS remaining FROM vouchers v
         LEFT JOIN voucher_movements m ON m.client_id=v.client_id AND m.voucher_id=v.id
         WHERE v.client_id=$1 AND v.id=$2 GROUP BY v.id`, [clientId, voucherId]);
      const remaining = decimal(String(balance.rows[0]!.remaining), "remaining voucher balance", false, 2);
      if (cents(remaining) <= 0n) throw new IdentityError(409, "Voucher has no remaining balance to reconcile");
      await db.query(`UPDATE vouchers SET status='CANCELLED',cancelled_by=$3,cancelled_at=now(),cancellation_reason=$4 WHERE client_id=$1 AND id=$2`,
        [clientId, voucherId, principal.userId, reason]);
      await db.query(
        `INSERT INTO voucher_movements (client_id,voucher_id,movement_type,amount_delta,reason,recorded_by)
        VALUES ($1,$2,'CANCEL',$3,$4,$5)`, [clientId, voucherId, `-${remaining}`, reason, principal.userId]);
      await audit(db, clientId, principal.userId, "VOUCHER_CANCELLED", "voucher", voucherId, { reason, reconciledBalance: remaining });
      return { id: voucherId, status: "CANCELLED", remainingBalance: "0.00", cancellationReason: reason };
    });
    send(res, 200, { voucher: result }); return true;
  }
  if (url.pathname === "/client/invoice-profile" && (req.method === "GET" || req.method === "PUT")) {
    role(principal, req.method === "GET" ? ["OWNER", "MANAGER", "ACCOUNTANT", "SUPER_ADMIN"] : ["OWNER", "MANAGER", "SUPER_ADMIN"]);
    if (req.method === "GET") {
      const result = await withPrincipal(principal, (db) => db.query(
        `SELECT status,legal_configuration AS "legalConfiguration",invoice_prefix AS "invoicePrefix",next_invoice_number AS "nextInvoiceNumber",
                credit_note_prefix AS "creditNotePrefix",next_credit_note_number AS "nextCreditNoteNumber",approval_statement AS "approvalStatement",
                approval_reference AS "approvalReference",approved_by AS "approvedBy",approved_at AS "approvedAt",updated_at AS "updatedAt"
         FROM client_invoice_profiles WHERE client_id=$1`, [clientId]));
      send(res, 200, { invoiceProfile: result.rows[0] ?? null }); return true;
    }
    const body = await json(req);
    if (!body.legalConfiguration || typeof body.legalConfiguration !== "object" || Array.isArray(body.legalConfiguration)) {
      throw new IdentityError(400, "legalConfiguration must be an object");
    }
    const configuration = JSON.stringify(body.legalConfiguration);
    if (configuration.length > 50_000) throw new IdentityError(400, "Legal configuration is too large");
    const invoicePrefix = text(body.invoicePrefix ?? "INV", "invoice prefix", 24);
    const creditPrefix = text(body.creditNotePrefix ?? "CN", "credit-note prefix", 24);
    const saved = await withPrincipal(principal, async (db) => {
      const result = await db.query(
        `INSERT INTO client_invoice_profiles (client_id,legal_configuration,invoice_prefix,credit_note_prefix,updated_by)
         VALUES ($1,$2::jsonb,$3,$4,$5)
         ON CONFLICT (client_id) DO UPDATE SET legal_configuration=EXCLUDED.legal_configuration,
           invoice_prefix=EXCLUDED.invoice_prefix,credit_note_prefix=EXCLUDED.credit_note_prefix,status='DRAFT',
           approval_statement=NULL,approval_reference=NULL,approved_by=NULL,approved_at=NULL,updated_by=EXCLUDED.updated_by,updated_at=now()
         RETURNING status,legal_configuration AS "legalConfiguration",invoice_prefix AS "invoicePrefix",next_invoice_number AS "nextInvoiceNumber",
           credit_note_prefix AS "creditNotePrefix",next_credit_note_number AS "nextCreditNoteNumber"`,
        [clientId, configuration, invoicePrefix, creditPrefix, principal.userId]);
      await audit(db, clientId, principal.userId, "INVOICE_PROFILE_UPDATED", "client_invoice_profile", clientId, { status: "DRAFT" });
      return result.rows[0];
    });
    send(res, 200, { invoiceProfile: saved }); return true;
  }
  if (url.pathname === "/client/invoice-profile/approve" && req.method === "POST") {
    role(principal, ["ACCOUNTANT"]);
    const body = await json(req);
    const statement = text(body.approvalStatement, "accountant approval statement", 1000);
    const reference = body.approvalReference == null || body.approvalReference === "" ? null : text(body.approvalReference, "approval reference", 250);
    const profile = await withPrincipal(principal, async (db) => {
      const configured = await db.query<{ legal_configuration: Record<string, unknown> }>(
        `SELECT legal_configuration FROM client_invoice_profiles WHERE client_id=$1`, [clientId]);
      const legal = configured.rows[0]?.legal_configuration;
      if (!legal || typeof legal.issuerName !== "string" || !legal.issuerName.trim()
        || !Array.isArray(legal.legalMentions) || !Array.isArray(legal.taxRules)) {
        throw new IdentityError(409, "Invoice configuration needs issuerName, legalMentions, and taxRules before accountant approval");
      }
      const result = await db.query(
        `UPDATE client_invoice_profiles SET status='APPROVED',approval_statement=$2,approval_reference=$3,
           approved_by=$4,approved_at=now(),updated_by=$4,updated_at=now()
         WHERE client_id=$1 AND status IN ('DRAFT','SUSPENDED') AND legal_configuration <> '{}'::jsonb
         RETURNING status,approved_at AS "approvedAt",approval_reference AS "approvalReference"`,
        [clientId, statement, reference, principal.userId]);
      if (!result.rowCount) throw new IdentityError(409, "Add a non-empty invoice configuration before accountant approval");
      await audit(db, clientId, principal.userId, "INVOICE_PROFILE_APPROVED", "client_invoice_profile", clientId, { reference });
      return result.rows[0];
    });
    send(res, 200, { invoiceProfile: profile }); return true;
  }
  const invoiceRoute = url.pathname.match(/^\/stations\/([^/]+)\/sales\/([^/]+)\/invoice$/);
  if (invoiceRoute && (req.method === "POST" || req.method === "GET")) {
    const [, stationId, saleId] = invoiceRoute;
    if (!uuid.test(stationId) || !uuid.test(saleId)) throw new IdentityError(404, "Invoice not found");
    role(principal, req.method === "GET" ? ["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER", "SUPER_ADMIN"] : ["OWNER", "MANAGER", "ACCOUNTANT", "SUPER_ADMIN"]);
    requireAccess(principal, { clientId, stationId });
    const invoice = await withPrincipal(principal, async (db) => {
      if (req.method === "GET") {
        const existing = await db.query(
        `SELECT id,station_id AS "stationId",sale_id AS "saleId",customer_id AS "customerId",customer_snapshot AS "customerSnapshot",invoice_number AS "invoiceNumber",
            currency_code AS "currencyCode",business_date AS "businessDate",issued_at AS "issuedAt",subtotal,tax_total AS "taxTotal",total,
            legal_snapshot AS "legalSnapshot",lines_snapshot AS "lines"
           FROM issued_invoices WHERE client_id=$1 AND station_id=$2 AND sale_id=$3`, [clientId, stationId, saleId]);
        return existing.rows[0] ?? null;
      }
      const profile = await db.query(
        `SELECT * FROM client_invoice_profiles WHERE client_id=$1 AND status='APPROVED' FOR UPDATE`, [clientId]);
      if (!profile.rowCount) throw new IdentityError(409, "Invoice issuance is disabled until the client accountant approves the legal configuration");
      const sale = await db.query(
        `SELECT id,customer_id,business_date,currency_code,subtotal,tax_total,total,status,
          (SELECT jsonb_build_object('code',customer.code,'displayName',customer.display_name,
            'contactEmail',customer.contact_email,'contactPhone',customer.contact_phone)
           FROM customers customer WHERE customer.client_id=sales_transactions.client_id
             AND customer.id=sales_transactions.customer_id) AS customer_snapshot,
          (SELECT jsonb_agg(jsonb_build_object('description',line.description,'unitCode',line.unit_code,'quantity',line.quantity,
            'unitPrice',line.unit_price,'taxCode',line.tax_code,'taxRatePercent',line.tax_rate_percent,
            'subtotal',line.subtotal,'taxAmount',line.tax_amount,'total',line.total) ORDER BY line.line_number)
           FROM sales_transaction_lines line WHERE line.sale_id=sales_transactions.id) AS lines
         FROM sales_transactions WHERE client_id=$1 AND station_id=$2 AND id=$3 FOR UPDATE`, [clientId, stationId, saleId]);
      const row = sale.rows[0] as { status: string; id: string; customer_id: string | null; customer_snapshot: unknown; business_date: string; currency_code: string; subtotal: string; tax_total: string; total: string; lines: unknown } | undefined;
      if (!row || row.status !== "POSTED") throw new IdentityError(409, "Only a posted sale can be invoiced");
      const p = profile.rows[0] as { legal_configuration: unknown; invoice_prefix: string; next_invoice_number: string };
      const legal = p.legal_configuration as { taxRules?: unknown };
      const taxRules = Array.isArray(legal.taxRules) ? legal.taxRules : [];
      const taxMap = new Map<string, number>();
      for (const rule of taxRules) {
        if (!rule || typeof rule !== "object" || Array.isArray(rule)) continue;
        const taxRule = rule as { code?: unknown; ratePercent?: unknown };
        if (typeof taxRule.code === "string" && typeof taxRule.ratePercent === "number") taxMap.set(taxRule.code, taxRule.ratePercent);
      }
      const snapshotLines = Array.isArray(row.lines) ? row.lines as Array<Record<string, unknown>> : [];
      for (const line of snapshotLines) {
        const lineTaxCode = line.taxCode;
        const lineRate = Number(line.taxRatePercent);
        if (lineTaxCode == null) {
          if (lineRate !== 0) throw new IdentityError(409, "Invoice line tax rate is not covered by the approved tax rules");
        } else if (typeof lineTaxCode !== "string" || !taxMap.has(lineTaxCode) || taxMap.get(lineTaxCode) !== lineRate) {
          throw new IdentityError(409, "Invoice line tax rate is not covered by the approved tax rules");
        }
      }
      const invoiceNumber = `${p.invoice_prefix}-${String(p.next_invoice_number).padStart(8, "0")}`;
      await db.query(`UPDATE client_invoice_profiles SET next_invoice_number=next_invoice_number+1,updated_by=$2,updated_at=now() WHERE client_id=$1`, [clientId, principal.userId]);
      const inserted = await db.query(
        `INSERT INTO issued_invoices (client_id,station_id,sale_id,customer_id,customer_snapshot,invoice_number,currency_code,business_date,subtotal,tax_total,total,legal_snapshot,lines_snapshot,issued_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14)
         RETURNING id,station_id AS "stationId",sale_id AS "saleId",customer_id AS "customerId",invoice_number AS "invoiceNumber",
          currency_code AS "currencyCode",business_date AS "businessDate",issued_at AS "issuedAt",subtotal,tax_total AS "taxTotal",total,
          customer_snapshot AS "customerSnapshot",legal_snapshot AS "legalSnapshot",lines_snapshot AS "lines"`,
        [clientId,stationId,row.id,row.customer_id,JSON.stringify(row.customer_snapshot ?? { displayName: "Walk-in customer" }),
          invoiceNumber,row.currency_code,row.business_date,row.subtotal,row.tax_total,row.total,
          JSON.stringify(p.legal_configuration),JSON.stringify(row.lines ?? []),principal.userId]);
      await audit(db, clientId, principal.userId, "INVOICE_ISSUED", "issued_invoice", inserted.rows[0]!.id, { invoiceNumber, saleId }, stationId);
      return inserted.rows[0];
    });
    if (!invoice) throw new IdentityError(404, "Invoice not found");
    send(res, req.method === "POST" ? 201 : 200, { invoice }); return true;
  }
  const creditNotesRoute = url.pathname.match(/^\/invoices\/([^/]+)\/credit-notes$/);
  if (creditNotesRoute && (req.method === "GET" || req.method === "POST")) {
    const [, invoiceId] = creditNotesRoute;
    if (!uuid.test(invoiceId)) throw new IdentityError(404, "Invoice not found");
    role(principal, req.method === "GET" ? ["OWNER", "MANAGER", "ACCOUNTANT", "SUPER_ADMIN"] : ["OWNER", "MANAGER", "ACCOUNTANT", "SUPER_ADMIN"]);
    if (req.method === "GET") {
      const notes = await withPrincipal(principal, (db) => db.query(
        `SELECT id,invoice_id AS "invoiceId",sale_id AS "saleId",credit_note_number AS "creditNoteNumber",amount,receivable_adjustment AS "receivableAdjustment",reason,issued_at AS "issuedAt",legal_snapshot AS "legalSnapshot"
         FROM issued_credit_notes WHERE client_id=$1 AND invoice_id=$2 ORDER BY issued_at`, [clientId, invoiceId]));
      send(res, 200, { creditNotes: notes.rows }); return true;
    }
    const body = await json(req);
    const amount = decimal(body.amount, "credit-note amount", true, 2);
    const receivableAdjustment = body.receivableAdjustment == null ? "0" : decimal(body.receivableAdjustment, "receivable adjustment", false, 2);
    const reason = text(body.reason, "credit-note reason", 1000);
    const note = await withPrincipal(principal, async (db) => {
      const profile = await db.query(`SELECT * FROM client_invoice_profiles WHERE client_id=$1 AND status='APPROVED' FOR UPDATE`, [clientId]);
      if (!profile.rowCount) throw new IdentityError(409, "Credit notes require an approved invoice configuration");
      const invoice = await db.query(
        `SELECT sale_id,customer_id FROM issued_invoices WHERE client_id=$1 AND id=$2`, [clientId, invoiceId]);
      if (!invoice.rowCount) throw new IdentityError(404, "Invoice not found");
      const original = invoice.rows[0] as { sale_id: string; customer_id: string | null };
      const p = profile.rows[0] as { legal_configuration: unknown; credit_note_prefix: string; next_credit_note_number: string };
      const number = `${p.credit_note_prefix}-${String(p.next_credit_note_number).padStart(8, "0")}`;
      await db.query(`UPDATE client_invoice_profiles SET next_credit_note_number=next_credit_note_number+1,updated_by=$2,updated_at=now() WHERE client_id=$1`, [clientId, principal.userId]);
      const inserted = await db.query(
        `INSERT INTO issued_credit_notes (client_id,invoice_id,sale_id,customer_id,credit_note_number,amount,receivable_adjustment,reason,legal_snapshot,issued_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
         RETURNING id,invoice_id AS "invoiceId",sale_id AS "saleId",credit_note_number AS "creditNoteNumber",amount,receivable_adjustment AS "receivableAdjustment",reason,issued_at AS "issuedAt",legal_snapshot AS "legalSnapshot"`,
        [clientId,invoiceId,original.sale_id,original.customer_id,number,amount,receivableAdjustment,reason,JSON.stringify(p.legal_configuration),principal.userId]);
      await audit(db, clientId, principal.userId, "CREDIT_NOTE_ISSUED", "issued_credit_note", inserted.rows[0]!.id, { creditNoteNumber: number, amount });
      return inserted.rows[0];
    });
    send(res, 201, { creditNote: note }); return true;
  }
  const creditNotePrintRoute = url.pathname.match(/^\/credit-notes\/([^/]+)\/print$/);
  if (creditNotePrintRoute && req.method === "GET") {
    const [, creditNoteId] = creditNotePrintRoute;
    if (!uuid.test(creditNoteId)) throw new IdentityError(404, "Credit note not found");
    role(principal, ["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER", "SUPER_ADMIN"]);
    const note = await withPrincipal(principal, async (db) => {
      const result = await db.query(
        `SELECT n.credit_note_number,n.amount,n.receivable_adjustment AS "receivableAdjustment",n.reason,n.issued_at AS "issuedAt",
          n.legal_snapshot AS "legalSnapshot",i.customer_snapshot AS "customerSnapshot",i.invoice_number AS "invoiceNumber",i.business_date AS "businessDate",
          i.currency_code AS "currencyCode",i.total AS "invoiceTotal"
         FROM issued_credit_notes n
         JOIN issued_invoices i ON i.client_id=n.client_id AND i.id=n.invoice_id
         WHERE n.client_id=$1 AND n.id=$2`, [clientId, creditNoteId]);
      return result.rows[0] ?? null;
    });
    if (!note) throw new IdentityError(404, "Credit note not found");
    const legal = note.legalSnapshot as { issuerName?: unknown; legalMentions?: unknown };
    const customer = note.customerSnapshot as { displayName?: unknown; code?: unknown; contactEmail?: unknown; contactPhone?: unknown };
    const mentions = Array.isArray(legal.legalMentions)
      ? legal.legalMentions.map((mention) => `<li>${htmlEscape(mention)}</li>`).join("") : "";
    const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Credit note ${htmlEscape(note.credit_note_number)}</title><style>
      body{font:16px/1.5 Arial,sans-serif;color:#17211f;margin:0;background:#f3f6f5}.sheet{max-width:850px;margin:32px auto;padding:48px;background:#fff;box-shadow:0 12px 40px #15292318}.toolbar{text-align:right;margin-bottom:24px}button{padding:10px 18px;border:0;border-radius:6px;background:#12634d;color:white;font-size:15px;cursor:pointer}h1{margin:8px 0 24px}.meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 24px;border-block:1px solid #d9e1dd;padding:18px 0}.meta p{margin:3px 0}.amount{margin:32px 0;padding:20px;border:1px solid #d9e1dd;font-size:20px}.reason{white-space:pre-wrap}.mentions{margin-top:40px;color:#485750;font-size:13px}@media print{body{background:white}.sheet{max-width:none;margin:0;padding:10mm;box-shadow:none}.toolbar{display:none}}
      </style></head><body><main class="sheet"><div class="toolbar"><button type="button" onclick="window.print()">Print or save as PDF</button></div><header><small>${htmlEscape(legal.issuerName || "Issuer details")}</small><h1>Credit note</h1></header><section class="meta"><div><p><strong>Credit note number</strong></p><p>${htmlEscape(note.credit_note_number)}</p></div><div><p><strong>Issued</strong></p><p>${htmlEscape(note.issuedAt)}</p></div><div><p><strong>Original invoice</strong></p><p>${htmlEscape(note.invoiceNumber)} · ${htmlEscape(note.businessDate)}</p></div><div><p><strong>Customer</strong></p><p>${htmlEscape(customer.displayName || "Walk-in customer")}</p><p>${htmlEscape(customer.code || "")}</p><p>${htmlEscape(customer.contactEmail || "")}</p><p>${htmlEscape(customer.contactPhone || "")}</p></div></section><section class="amount"><p><strong>Credit note amount</strong><br>${htmlEscape(note.amount)} ${htmlEscape(note.currencyCode)}</p><p><strong>Receivable adjustment recorded</strong><br>${htmlEscape(note.receivableAdjustment)} ${htmlEscape(note.currencyCode)}</p><p><strong>Original invoice total</strong><br>${htmlEscape(note.invoiceTotal)} ${htmlEscape(note.currencyCode)}</p></section><section class="reason"><strong>Reason</strong><p>${htmlEscape(note.reason)}</p></section>${mentions ? `<section class="mentions"><ul>${mentions}</ul></section>` : ""}</main></body></html>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
    res.end(page); return true;
  }
  const invoicePrintRoute = url.pathname.match(/^\/invoices\/([^/]+)\/print$/);
  if (invoicePrintRoute && req.method === "GET") {
    const [, invoiceId] = invoicePrintRoute;
    if (!uuid.test(invoiceId)) throw new IdentityError(404, "Invoice not found");
    role(principal, ["OWNER", "MANAGER", "ACCOUNTANT", "CASHIER", "SUPER_ADMIN"]);
    const invoice = await withPrincipal(principal, async (db) => {
      const result = await db.query(
        `SELECT i.invoice_number,i.currency_code,i.business_date,i.issued_at,i.subtotal,i.tax_total,i.total,
          i.customer_snapshot AS "customerSnapshot",i.legal_snapshot,i.lines_snapshot
         FROM issued_invoices i
         WHERE i.client_id=$1 AND i.id=$2`, [clientId, invoiceId]);
      return result.rows[0] ?? null;
    });
    if (!invoice) throw new IdentityError(404, "Invoice not found");
    const legal = invoice.legal_snapshot as { issuerName?: unknown; legalMentions?: unknown };
    const customer = invoice.customerSnapshot as { displayName?: unknown; code?: unknown; contactEmail?: unknown; contactPhone?: unknown };
    const lines = Array.isArray(invoice.lines_snapshot) ? invoice.lines_snapshot as Array<Record<string, unknown>> : [];
    const mentions = Array.isArray(legal.legalMentions) ? legal.legalMentions.map((mention) => `<li>${htmlEscape(mention)}</li>`).join("") : "";
    const lineHtml = lines.map((line) => `<tr><td>${htmlEscape(line.description)}</td><td>${htmlEscape(line.quantity)} ${htmlEscape(line.unitCode)}</td><td>${htmlEscape(line.unitPrice)}</td><td>${htmlEscape(line.taxRatePercent)}%</td><td>${htmlEscape(line.total)}</td></tr>`).join("");
    const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invoice ${htmlEscape(invoice.invoice_number)}</title><style>
      body{font:16px/1.5 Arial,sans-serif;color:#17211f;margin:0;background:#f3f6f5}.sheet{max-width:850px;margin:32px auto;padding:48px;background:#fff;box-shadow:0 12px 40px #15292318}.toolbar{text-align:right;margin-bottom:24px}button{padding:10px 18px;border:0;border-radius:6px;background:#12634d;color:white;font-size:15px;cursor:pointer}h1{margin:8px 0 24px}.meta{display:flex;justify-content:space-between;gap:24px;border-block:1px solid #d9e1dd;padding:18px 0}.meta p{margin:3px 0}table{width:100%;border-collapse:collapse;margin-top:32px}th,td{text-align:left;border-bottom:1px solid #d9e1dd;padding:10px 8px}th{background:#f3f6f5}.totals{margin:24px 0 0 auto;max-width:320px}.totals p{display:flex;justify-content:space-between}.grand{font-size:20px;font-weight:bold;border-top:2px solid #17211f;padding-top:12px}.mentions{margin-top:40px;color:#485750;font-size:13px} @media print{body{background:white}.sheet{max-width:none;margin:0;padding:10mm;box-shadow:none}.toolbar{display:none}a{color:inherit}}
      </style></head><body><main class="sheet"><div class="toolbar"><button type="button" onclick="window.print()">Print or save as PDF</button></div><header><small>${htmlEscape(legal.issuerName || "Issuer details")}</small><h1>Invoice</h1></header><section class="meta"><div><p><strong>Invoice number</strong></p><p>${htmlEscape(invoice.invoice_number)}</p></div><div><p><strong>Business date</strong></p><p>${htmlEscape(invoice.business_date)}</p></div><div><p><strong>Issued</strong></p><p>${htmlEscape(invoice.issued_at)}</p></div><div><p><strong>Customer</strong></p><p>${htmlEscape(customer.displayName || "Walk-in customer")}</p><p>${htmlEscape(customer.code || "")}</p><p>${htmlEscape(customer.contactEmail || "")}</p><p>${htmlEscape(customer.contactPhone || "")}</p></div></section><table><thead><tr><th>Description</th><th>Quantity</th><th>Unit price</th><th>Tax rate</th><th>Total</th></tr></thead><tbody>${lineHtml}</tbody></table><section class="totals"><p><span>Subtotal</span><strong>${htmlEscape(invoice.subtotal)} ${htmlEscape(invoice.currency_code)}</strong></p><p><span>Tax</span><strong>${htmlEscape(invoice.tax_total)} ${htmlEscape(invoice.currency_code)}</strong></p><p class="grand"><span>Total</span><strong>${htmlEscape(invoice.total)} ${htmlEscape(invoice.currency_code)}</strong></p></section>${mentions ? `<section class="mentions"><ul>${mentions}</ul></section>` : ""}</main></body></html>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
    res.end(page); return true;
  }
  return false;
}

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "../domain/authorization.js";
import { requireAccess } from "../domain/authorization.js";
import { withPrincipal } from "../infrastructure/db.js";
import { IdentityError } from "../infrastructure/identity.js";

type Row = Record<string, unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<Row> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += part.length;
    if (size > 5_500_000) throw new IdentityError(400, "Import payload exceeds 5 MB"); chunks.push(part); }
  try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Row;
  } catch { throw new IdentityError(400, "Expected a JSON object"); }
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new IdentityError(400, `Invalid ${field}`);
  return value.trim();
}
function date(value: unknown): string {
  const valueText = text(value, "date", 10); const parsed = new Date(`${valueText}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valueText) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== valueText) throw new IdentityError(400, "Date must be a valid YYYY-MM-DD");
  return valueText;
}
function amount(value: unknown, signed = false, nonZero = false, scale = 3): string {
  const raw = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  const expression = new RegExp(`^${signed ? "-?" : ""}(?:0|[1-9]\\d{0,${13-scale}})(?:\\.\\d{1,${scale}})?$`);
  if (typeof raw !== "string" || !expression.test(raw) || Number(raw) === 0 && nonZero) throw new Error(`Use a valid number with up to ${scale} decimals`);
  return raw;
}
function client(principal: Principal): string { if (!principal.clientId) throw new IdentityError(400, "Select a client workspace first"); return principal.clientId; }
function allow(principal: Principal): void { if (!["OWNER", "MANAGER", "ACCOUNTANT", "SUPER_ADMIN"].includes(principal.role)) throw new IdentityError(403, "Insufficient role"); }
function access(principal: Principal, clientId: string, stationId?: string | null): void {
  if (principal.clientId !== clientId) throw new IdentityError(403, "Select this client workspace first");
  if (stationId) {
    try { requireAccess(principal, { clientId, stationId }); }
    catch { throw new IdentityError(403, "Station access is required"); }
  }
}

export async function handleImportRoutes(req: IncomingMessage, res: ServerResponse, principal: Principal, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (!(path === "/import-jobs" || /^\/import-jobs\/[0-9a-f-]+(?:\/(?:validate|commit))?$/.test(path)
    || path === "/import-history" || path === "/import-history.csv")) return false;
  allow(principal); const clientId = client(principal);
  if ((path === "/import-history" || path === "/import-history.csv") && req.method === "GET") {
    if (!["OWNER", "MANAGER", "ACCOUNTANT", "SUPER_ADMIN"].includes(principal.role)) throw new IdentityError(403, "Historical archive access requires an owner, manager, or accountant");
    const fromValue = url.searchParams.get("from"); const toValue = url.searchParams.get("to");
    const from = fromValue ? date(fromValue) : null; const to = toValue ? date(toValue) : null;
    if (from && to && from > to) throw new IdentityError(400, "from must not be after to");
    const stationValue = url.searchParams.get("stationId");
    const stationId = stationValue ? stationValue : null;
    if (stationId && !uuid.test(stationId)) throw new IdentityError(400, "Invalid stationId");
    if (stationId) access(principal, clientId, stationId);
    const typeValue = url.searchParams.get("recordType");
    const recordType = typeValue ? text(typeValue, "recordType", 80) : null;
    const limitValue = url.searchParams.get("limit");
    const limit = limitValue == null ? 100 : Number(limitValue);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new IdentityError(400, "limit must be an integer from 1 to 500");
    let cursorDate: string | null = null; let cursorId: string | null = null;
    const cursorValue = url.searchParams.get("cursor");
    if (cursorValue) {
      if (cursorValue.length > 256) throw new IdentityError(400, "Invalid archive cursor");
      try {
        const cursor = JSON.parse(Buffer.from(cursorValue, "base64url").toString("utf8")) as { date?: unknown; id?: unknown };
        cursorDate = date(cursor.date); cursorId = text(cursor.id, "cursor ID", 36);
        if (!uuid.test(cursorId)) throw new Error("invalid cursor ID");
      } catch { throw new IdentityError(400, "Invalid archive cursor"); }
    }
    const result = await withPrincipal(principal, db => db.query(
      `SELECT record.id,record.station_id AS "stationId",station.code AS "stationCode",record.record_date AS "recordDate",
        record.record_type AS "recordType",record.description,record.amount,record.currency_code AS "currencyCode",
        record.additional_data AS "additionalData",record.imported_at AS "importedAt"
       FROM imported_history_records record
       LEFT JOIN stations station ON station.client_id=record.client_id AND station.id=record.station_id
       WHERE record.client_id=$1 AND ($2::date IS NULL OR record.record_date >= $2)
         AND ($3::date IS NULL OR record.record_date <= $3)
         AND ($4::uuid IS NULL OR record.station_id=$4)
         AND ($5::text IS NULL OR record.record_type=$5)
         AND ($6::date IS NULL OR (record.record_date,record.id)<($6::date,$7::uuid))
       ORDER BY record.record_date DESC,record.id DESC LIMIT $8`,
      [clientId,from,to,stationId,recordType,cursorDate,cursorId,limit+1]));
    const hasMore = result.rows.length > limit; const records = result.rows.slice(0,limit);
    const last = records.at(-1) as { recordDate?: string; id?: string } | undefined;
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ date: last.recordDate, id: last.id })).toString("base64url") : null;
    if (path === "/import-history") { send(res,200,{records,nextCursor}); return true; }
    const encode = (value: unknown): string => {
      let cell = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
      if (/^[\s]*[=+@]/.test(cell) || (/^[\s]*-/.test(cell) && !/^\s*-?\d+(?:\.\d+)?\s*$/.test(cell))) cell = `'${cell}`;
      return `"${cell.replace(/"/g,"\"\"")}"`;
    };
    const headings = ["Record date","Station","Type","Description","Amount","Currency","Additional data","Imported at"];
    const rows = records.map((record: Record<string,unknown>) => [record.recordDate,record.stationCode,record.recordType,record.description,record.amount,record.currencyCode,record.additionalData,record.importedAt]);
    const csv = `\uFEFF${[headings,...rows].map(row=>row.map(encode).join(",")).join("\r\n")}\r\n`;
    res.writeHead(200,{"content-type":"text/csv; charset=utf-8","content-disposition":"attachment; filename=import-history.csv","cache-control":"no-store","x-content-type-options":"nosniff"});
    res.end(csv); return true;
  }
  if (path === "/import-jobs" && req.method === "GET") {
    const jobs = await withPrincipal(principal, db => db.query(
      `SELECT id,station_id AS "stationId",import_kind AS "importKind",source_name AS "sourceName",status,row_count AS "rowCount",valid_count AS "validCount",invalid_count AS "invalidCount",created_at AS "createdAt",validated_at AS "validatedAt",committed_at AS "committedAt" FROM import_jobs WHERE client_id=$1 ORDER BY created_at DESC LIMIT 100`, [clientId]));
    send(res, 200, { jobs: jobs.rows }); return true;
  }
  if (path === "/import-jobs" && req.method === "POST") {
    const input = await body(req); const kind = input.importKind;
    if (!["HISTORICAL_RECORDS", "OPENING_STOCK", "OPENING_RECEIVABLE"].includes(String(kind))) throw new IdentityError(400, "Invalid importKind");
    const rows = input.rows;
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 5000 || !rows.every((row: unknown) => row && typeof row === "object" && !Array.isArray(row))) throw new IdentityError(400, "rows must contain 1 to 5000 objects");
    const stationId = input.stationId == null || input.stationId === "" ? null : String(input.stationId);
    if (kind === "OPENING_STOCK" && !["OWNER", "MANAGER", "SUPER_ADMIN"].includes(principal.role)) throw new IdentityError(403, "Only an owner or manager can import opening stock");
    if (kind === "OPENING_RECEIVABLE" && !["OWNER", "MANAGER", "ACCOUNTANT", "SUPER_ADMIN"].includes(principal.role)) throw new IdentityError(403, "Insufficient role to import opening receivables");
    if (stationId && !uuid.test(stationId)) throw new IdentityError(400, "Invalid stationId");
    if (kind !== "HISTORICAL_RECORDS" && !stationId) throw new IdentityError(400, "Opening balance imports require a station");
    const sourceName = text(input.sourceName ?? "Imported file", "source name", 200);
    const result = await withPrincipal(principal, async db => {
      if (stationId) {
        const station = await db.query("SELECT id FROM stations WHERE client_id=$1 AND id=$2", [clientId, stationId]);
        if (!station.rowCount) throw new IdentityError(404, "Station not found in selected client");
        access(principal, clientId, stationId);
      }
      const inserted = await db.query(`INSERT INTO import_jobs(client_id,station_id,import_kind,source_name,row_count,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [clientId,stationId,kind,sourceName,rows.length,principal.userId]);
      const jobId = (inserted.rows[0] as {id:string}).id;
      for (let i=0;i<rows.length;i++) await db.query(`INSERT INTO import_job_rows(client_id,job_id,row_number,raw_data) VALUES($1,$2,$3,$4::jsonb)`, [clientId,jobId,i+1,JSON.stringify(rows[i])]);
      await db.query(`INSERT INTO audit_events(client_id,station_id,actor_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,'IMPORT_JOB_CREATED','import_jobs',$4,$5::jsonb)`, [clientId,stationId,principal.userId,jobId,JSON.stringify({kind,rowCount:rows.length,sourceName})]);
      return {jobId};
    });
    send(res, 201, result); return true;
  }
  const match = path.match(/^\/import-jobs\/([0-9a-f-]+)(?:\/(validate|commit))?$/); if (!match) return false;
  const [, jobId, action] = match; if (!uuid.test(jobId)) throw new IdentityError(404, "Import job not found");
  if (!action && req.method === "GET") {
    const result = await withPrincipal(principal, async db => {
      const job = await db.query(`SELECT * FROM import_jobs WHERE client_id=$1 AND id=$2`, [clientId,jobId]); if (!job.rowCount) throw new IdentityError(404,"Import job not found");
      const meta = job.rows[0] as {station_id:string|null}; access(principal,clientId,meta.station_id);
      const rows = await db.query(`SELECT row_number AS "rowNumber",raw_data AS "rawData",normalized_data AS "normalizedData",status,errors,imported_entity_id AS "importedEntityId" FROM import_job_rows WHERE client_id=$1 AND job_id=$2 ORDER BY row_number`,[clientId,jobId]);
      return {job:job.rows[0],rows:rows.rows};
    }); send(res,200,result); return true;
  }
  if (action === "validate" && req.method === "POST") {
    const result = await withPrincipal(principal, async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[jobId]);
      const jr=await db.query(`SELECT * FROM import_jobs WHERE client_id=$1 AND id=$2 FOR UPDATE`,[clientId,jobId]); if(!jr.rowCount) throw new IdentityError(404,"Import job not found");
      const job=jr.rows[0] as {id:string;station_id:string|null;import_kind:string;status:string}; access(principal,clientId,job.station_id);
      if(job.status!=="UPLOADED") throw new IdentityError(409,"Only uploaded jobs can be validated");
      const rows=await db.query(`SELECT id,row_number,raw_data FROM import_job_rows WHERE client_id=$1 AND job_id=$2 ORDER BY row_number`,[clientId,jobId]); let valid=0,invalid=0;
      for(const r of rows.rows as Array<{id:string;row_number:number;raw_data:Row}>) {
        const errors:string[]=[]; const n:Row={}; const x=r.raw_data;
        try {
          if(job.import_kind==="HISTORICAL_RECORDS") {
            n.recordDate=date(x.recordDate); n.recordType=text(x.recordType,"recordType",80); n.description=text(x.description,"description",1000);
            if(x.amount!==undefined&&x.amount!=="") n.amount=amount(x.amount,true,false,2);
            if(x.currencyCode!==undefined&&x.currencyCode!=="") { n.currencyCode=text(x.currencyCode,"currencyCode",3).toUpperCase(); if(!/^[A-Z]{3}$/.test(String(n.currencyCode))) throw new Error("currencyCode must be three letters"); }
            if (typeof x.additionalData === "string" && x.additionalData.trim()) { try { n.additionalData=JSON.parse(x.additionalData); } catch { throw new Error("additionalData must be valid JSON"); } }
            else n.additionalData=x.additionalData&&typeof x.additionalData==="object"&&!Array.isArray(x.additionalData)?x.additionalData:{};
            if (!n.additionalData || typeof n.additionalData !== "object" || Array.isArray(n.additionalData)) throw new Error("additionalData must be a JSON object");
          } else if(job.import_kind==="OPENING_STOCK") {
            n.businessDate=date(x.businessDate); n.quantity=amount(x.quantity,true,true); n.reason=text(x.reason,"reason",1000);
            if(typeof x.productId==="string"&&uuid.test(x.productId)) n.productId=x.productId;
            else n.productCode=text(x.productCode,"productCode",32).toUpperCase();
            const p=await db.query(`SELECT product.id FROM station_products assignment JOIN products product ON product.client_id=assignment.client_id AND product.id=assignment.product_id WHERE assignment.client_id=$1 AND assignment.station_id=$2 AND ($3::uuid IS NOT NULL AND product.id=$3 OR $4::text IS NOT NULL AND upper(product.code)=$4)`,[clientId,job.station_id,n.productId??null,n.productCode??null]); if(!p.rowCount) throw new Error("Product is not assigned to this station"); n.productId=(p.rows[0] as {id:string}).id;
          } else {
            n.businessDate=date(x.businessDate); n.amount=amount(x.amount,false,false,2); n.reason=text(x.reason,"reason",1000);
            if(typeof x.customerId==="string"&&uuid.test(x.customerId)) n.customerId=x.customerId;
            else n.customerCode=text(x.customerCode,"customerCode",32).toUpperCase();
            const c=await db.query(`SELECT c.id FROM customers c JOIN customer_credit_accounts a ON a.client_id=c.client_id AND a.customer_id=c.id WHERE c.client_id=$1 AND ($2::uuid IS NOT NULL AND c.id=$2 OR $3::text IS NOT NULL AND upper(c.code)=$3) AND c.is_active AND a.status='ACTIVE'`,[clientId,n.customerId??null,n.customerCode??null]); if(!c.rowCount) throw new Error("Customer code/ID must identify an active customer with an active credit account"); n.customerId=(c.rows[0] as {id:string}).id;
          }
        } catch(e) { errors.push(e instanceof Error?e.message:"Invalid row"); }
        if(errors.length) invalid++; else valid++;
        await db.query(`UPDATE import_job_rows SET normalized_data=$3::jsonb,status=$4,errors=$5::jsonb WHERE client_id=$1 AND id=$2`,[clientId,r.id,JSON.stringify(n),errors.length?"INVALID":"VALID",JSON.stringify(errors)]);
      }
      await db.query(`UPDATE import_jobs SET status='VALIDATED',valid_count=$3,invalid_count=$4,validated_at=now() WHERE client_id=$1 AND id=$2`,[clientId,jobId,valid,invalid]);
      await db.query(`INSERT INTO audit_events(client_id,station_id,actor_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,'IMPORT_JOB_VALIDATED','import_jobs',$4,$5::jsonb)`,[clientId,job.station_id,principal.userId,jobId,JSON.stringify({validCount:valid,invalidCount:invalid})]);
      return {jobId,status:"VALIDATED",validCount:valid,invalidCount:invalid,canCommit:valid>0&&invalid===0};
    }); send(res,200,result); return true;
  }
  if(action==="commit"&&req.method==="POST") {
    const result=await withPrincipal(principal,async db=>{
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[jobId]);
      const jr=await db.query(`SELECT * FROM import_jobs WHERE client_id=$1 AND id=$2 FOR UPDATE`,[clientId,jobId]); if(!jr.rowCount) throw new IdentityError(404,"Import job not found");
      const job=jr.rows[0] as {station_id:string|null;import_kind:string;status:string;invalid_count:number}; access(principal,clientId,job.station_id);
      if(job.status!=="VALIDATED"||job.invalid_count!==0) throw new IdentityError(409,"Validate the job and correct all invalid rows before committing; imports are all-or-nothing");
      const rows=await db.query(`SELECT id,row_number,normalized_data FROM import_job_rows WHERE client_id=$1 AND job_id=$2 AND status='VALID' ORDER BY row_number`,[clientId,jobId]);
      for(const row of rows.rows as Array<{id:string;row_number:number;normalized_data:Row}>) {
        const n=row.normalized_data; let entityId:string;
        if(job.import_kind==="HISTORICAL_RECORDS") {
          const inserted=await db.query(`INSERT INTO imported_history_records(client_id,station_id,import_job_row_id,record_date,record_type,description,amount,currency_code,additional_data,imported_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING id`,[clientId,job.station_id,row.id,n.recordDate,n.recordType,n.description,n.amount??null,n.currencyCode??null,JSON.stringify(n.additionalData??{}),principal.userId]); entityId=(inserted.rows[0] as {id:string}).id;
        } else if(job.import_kind==="OPENING_STOCK") {
          const inserted=await db.query(`INSERT INTO stock_movements(client_id,station_id,product_id,movement_type,quantity_delta,business_date,source_id,reason,recorded_by) VALUES($1,$2,$3,'OPENING_BALANCE',$4,$5,$6,$7,$8) RETURNING id`,[clientId,job.station_id,n.productId,n.quantity,n.businessDate,row.id,n.reason,principal.userId]); entityId=(inserted.rows[0] as {id:string}).id;
        } else {
          const inserted=await db.query(`INSERT INTO customer_credit_movements(client_id,customer_id,movement_type,amount_delta,reason,recorded_by,business_date,source_import_job_row_id) VALUES($1,$2,'ADJUSTMENT',$3,$4,$5,$6,$7) RETURNING id`,[clientId,n.customerId,n.amount,`Opening receivable: ${n.reason}`,principal.userId,n.businessDate,row.id]); entityId=(inserted.rows[0] as {id:string}).id;
        }
        await db.query(`UPDATE import_job_rows SET imported_entity_id=$3 WHERE client_id=$1 AND id=$2`,[clientId,row.id,entityId]);
      }
      await db.query(`UPDATE import_jobs SET status='COMMITTED',committed_by=$3,committed_at=now() WHERE client_id=$1 AND id=$2`,[clientId,jobId,principal.userId]);
      await db.query(`INSERT INTO audit_events(client_id,station_id,actor_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,'IMPORT_JOB_COMMITTED','import_jobs',$4,$5::jsonb)`,[clientId,job.station_id,principal.userId,jobId,JSON.stringify({kind:job.import_kind,rowCount:rows.rowCount})]);
      return {jobId,status:"COMMITTED",importedCount:rows.rowCount};
    }); send(res,200,result); return true;
  }
  return false;
}

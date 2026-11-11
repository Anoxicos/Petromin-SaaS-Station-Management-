import type { IncomingMessage, ServerResponse } from "node:http";
import type { PoolClient } from "pg";
import type { Principal } from "../domain/authorization.js";
import { requireAccess } from "../domain/authorization.js";
import { withPrincipal } from "../infrastructure/db.js";
import { IdentityError } from "../infrastructure/identity.js";

type Body = Record<string, unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const codePattern = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
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

function number(value: unknown, field: string, scale = 3, allowNegative = false, positive = false): string {
  if (typeof value !== "string" && typeof value !== "number") throw new IdentityError(400, `Invalid ${field}`);
  const raw = String(value);
  const sign = allowNegative ? "-?" : "";
  const pattern = new RegExp(`^${sign}(?:0|[1-9]\\d{0,11})(?:\\.\\d{1,${scale}})?$`);
  if (!pattern.test(raw) || (positive && Number(raw) <= 0)) {
    throw new IdentityError(400, `Invalid ${field}`);
  }
  return raw;
}

function date(value: unknown): string {
  const raw = text(value, "business date", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new IdentityError(400, "Business date must use YYYY-MM-DD");
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== raw) throw new IdentityError(400, "Invalid calendar date");
  return raw;
}

function tenant(principal: Principal): string {
  if (!principal.clientId) throw new IdentityError(400, "Select a client workspace first");
  return principal.clientId;
}

function roles(principal: Principal, allowed: readonly string[]): void {
  if (!allowed.includes(principal.role)) throw new IdentityError(403, "Insufficient role");
}

async function audit(db: PoolClient, clientId: string, stationId: string | null, actorId: string,
  action: string, entityType: string, entityId: string, details: unknown): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (client_id,station_id,actor_id,action,entity_type,entity_id,details)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [clientId,stationId,actorId,action,entityType,entityId,JSON.stringify(details)],
  );
}

export async function handleInventoryRoutes(
  req: IncomingMessage, res: ServerResponse, principal: Principal, url: URL,
): Promise<boolean> {
  const path = url.pathname;
  if (!(path === "/suppliers" || /^\/stations\/[^/]+\/(?:inventory|variance-thresholds|financial-variance-thresholds|stock-adjustments|purchase-receipts|stock-movements)$/.test(path)
    || /^\/stations\/[^/]+\/services\/[^/]+\/components$/.test(path))) return false;
  const clientId = tenant(principal);

  if (path === "/suppliers" && (req.method === "GET" || req.method === "POST")) {
    roles(principal, req.method === "GET" ? ["OWNER","MANAGER","ACCOUNTANT","SUPER_ADMIN"] : ["OWNER","MANAGER","SUPER_ADMIN"]);
    if (req.method === "GET") {
      const result = await withPrincipal(principal, (db) => db.query(
        `SELECT id,code,name,contact_email AS "contactEmail",contact_phone AS "contactPhone",is_active AS "isActive"
         FROM suppliers WHERE client_id=$1 ORDER BY name,code`, [clientId]));
      send(res, 200, { suppliers: result.rows }); return true;
    }
    const body = await json(req);
    const supplierCode = text(body.code, "supplier code", 32).toUpperCase();
    if (!codePattern.test(supplierCode)) throw new IdentityError(400, "Invalid supplier code");
    const name = text(body.name, "supplier name");
    const email = body.contactEmail == null || body.contactEmail === "" ? null : text(body.contactEmail, "contact email", 254);
    const phone = body.contactPhone == null || body.contactPhone === "" ? null : text(body.contactPhone, "contact phone", 40);
    const result = await withPrincipal(principal, async (db) => {
      const saved = await db.query(
        `INSERT INTO suppliers (client_id,code,name,contact_email,contact_phone,created_by) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id,code,name,contact_email AS "contactEmail",contact_phone AS "contactPhone",is_active AS "isActive"`,
        [clientId,supplierCode,name,email,phone,principal.userId]);
      await audit(db,clientId,null,principal.userId,"SUPPLIER_CREATED","supplier",saved.rows[0]!.id,{ code:supplierCode });
      return saved.rows[0];
    });
    send(res, 201, { supplier: result }); return true;
  }

  const stationRoute = path.match(/^\/stations\/([^/]+)\/(inventory|variance-thresholds|financial-variance-thresholds|stock-adjustments|purchase-receipts|stock-movements)$/);
  if (stationRoute) {
    const [,stationId,kind] = stationRoute;
    if (!uuid.test(stationId)) throw new IdentityError(404, "Station not found");
    requireAccess(principal,{clientId,stationId});
    if (kind === "financial-variance-thresholds" && (req.method === "GET" || req.method === "PATCH")) {
      roles(principal,req.method === "GET" ? ["OWNER","MANAGER","ACCOUNTANT","CASHIER","SUPER_ADMIN"] : ["OWNER","MANAGER","SUPER_ADMIN"]);
      if(req.method === "GET"){
        const result=await withPrincipal(principal,db=>db.query(
          `SELECT currency_code AS "currencyCode",max_abs_cash_variance AS "maxAbsCashVariance",
             max_abs_card_variance AS "maxAbsCardVariance",reason,updated_at AS "updatedAt"
           FROM station_cash_card_variance_thresholds WHERE client_id=$1 AND station_id=$2`,[clientId,stationId]));
        send(res,200,{threshold:result.rows[0]??null});return true;
      }
      const body=await json(req);
      const currency=text(body.currencyCode,"currency code",3).toUpperCase();
      if(!/^[A-Z]{3}$/.test(currency))throw new IdentityError(400,"Currency code must be three letters");
      const cash=body.maxAbsCashVariance==null||body.maxAbsCashVariance===""?null:number(body.maxAbsCashVariance,"maximum cash variance",2);
      const card=body.maxAbsCardVariance==null||body.maxAbsCardVariance===""?null:number(body.maxAbsCardVariance,"maximum card variance",2);
      const reason=text(body.reason,"variance policy reason",1000);
      const saved=await withPrincipal(principal,async db=>{
        const old=await db.query(`SELECT currency_code,max_abs_cash_variance,max_abs_card_variance FROM station_cash_card_variance_thresholds
          WHERE client_id=$1 AND station_id=$2 FOR UPDATE`,[clientId,stationId]);
        if(cash==null&&card==null){
          await db.query(`DELETE FROM station_cash_card_variance_thresholds WHERE client_id=$1 AND station_id=$2`,[clientId,stationId]);
        }else{
          await db.query(`INSERT INTO station_cash_card_variance_thresholds(client_id,station_id,currency_code,max_abs_cash_variance,max_abs_card_variance,reason,updated_by)
            VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(client_id,station_id) DO UPDATE SET
            currency_code=EXCLUDED.currency_code,max_abs_cash_variance=EXCLUDED.max_abs_cash_variance,
            max_abs_card_variance=EXCLUDED.max_abs_card_variance,reason=EXCLUDED.reason,updated_by=EXCLUDED.updated_by,updated_at=now()`,
            [clientId,stationId,currency,cash,card,reason,principal.userId]);
        }
        await audit(db,clientId,stationId,principal.userId,"CASH_CARD_VARIANCE_POLICY_CHANGED","station_cash_card_variance_threshold",stationId,
          {currencyCode:cash==null&&card==null?null:currency,previous:old.rows[0]??null,maxAbsCashVariance:cash,maxAbsCardVariance:card,reason});
        return cash==null&&card==null?null:{currencyCode:currency,maxAbsCashVariance:cash,maxAbsCardVariance:card,reason};
      });
      send(res,200,{threshold:saved,note:"Variance thresholds are informational and never block station closing."});return true;
    }
    if (kind === "variance-thresholds" && (req.method === "GET" || req.method === "PATCH")) {
      roles(principal, req.method === "GET" ? ["OWNER","MANAGER","ACCOUNTANT","CASHIER","SUPER_ADMIN"] : ["OWNER","MANAGER","SUPER_ADMIN"]);
      if (req.method === "GET") {
        const result = await withPrincipal(principal, db => db.query(
          `SELECT product.id AS "productId",product.code,product.name,product.unit_code AS "unitCode",
             threshold.max_abs_variance AS "maxAbsVariance",threshold.reason,threshold.updated_at AS "updatedAt"
           FROM station_products assignment JOIN products product
             ON product.client_id=assignment.client_id AND product.id=assignment.product_id
           LEFT JOIN station_fuel_variance_thresholds threshold
             ON threshold.client_id=assignment.client_id AND threshold.station_id=assignment.station_id AND threshold.product_id=product.id
           WHERE assignment.client_id=$1 AND assignment.station_id=$2 AND product.product_type='FUEL'
           ORDER BY product.code`,[clientId,stationId]));
        send(res,200,{thresholds:result.rows}); return true;
      }
      const body=await json(req);
      const productId=text(body.productId,"fuel product id",36);
      if(!uuid.test(productId))throw new IdentityError(400,"Invalid fuel product id");
      const reason=text(body.reason,"variance policy reason",1000);
      const threshold=body.maxAbsVariance==null?null:number(body.maxAbsVariance,"maximum absolute variance",3);
      const saved=await withPrincipal(principal,async db=>{
        const product=await db.query(`SELECT product.unit_code FROM station_products assignment JOIN products product
          ON product.client_id=assignment.client_id AND product.id=assignment.product_id
          WHERE assignment.client_id=$1 AND assignment.station_id=$2 AND product.id=$3 AND product.product_type='FUEL'`,[clientId,stationId,productId]);
        if(!product.rowCount)throw new IdentityError(404,"Assigned fuel product not found");
        const old=await db.query(`SELECT max_abs_variance FROM station_fuel_variance_thresholds WHERE client_id=$1 AND station_id=$2 AND product_id=$3 FOR UPDATE`,[clientId,stationId,productId]);
        if(threshold==null){
          await db.query(`DELETE FROM station_fuel_variance_thresholds WHERE client_id=$1 AND station_id=$2 AND product_id=$3`,[clientId,stationId,productId]);
        }else{
          await db.query(`INSERT INTO station_fuel_variance_thresholds(client_id,station_id,product_id,max_abs_variance,reason,updated_by)
            VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(client_id,station_id,product_id) DO UPDATE SET
            max_abs_variance=EXCLUDED.max_abs_variance,reason=EXCLUDED.reason,updated_by=EXCLUDED.updated_by,updated_at=now()`,
            [clientId,stationId,productId,threshold,reason,principal.userId]);
        }
        await audit(db,clientId,stationId,principal.userId,"FUEL_VARIANCE_THRESHOLD_CHANGED","station_fuel_variance_threshold",productId,
          {unitCode:product.rows[0]!.unit_code,previousMaxAbsVariance:old.rows[0]?.max_abs_variance??null,maxAbsVariance:threshold,reason});
        return {productId,maxAbsVariance:threshold,reason:threshold==null?null:reason};
      });
      send(res,200,{threshold:saved,note:"Variance thresholds are informational; they do not block day closing."}); return true;
    }
    if (kind === "inventory" && req.method === "GET") {
      roles(principal,["OWNER","MANAGER","ACCOUNTANT","CASHIER","SUPER_ADMIN"]);
      const businessDate = date(url.searchParams.get("date"));
      const inventory = await withPrincipal(principal, async (db) => {
        const result = await db.query(
          `WITH meter_volume AS (
             SELECT COALESCE(allocation.product_id,equipment.product_id) AS product_id,
               sum(CASE WHEN station.meter_mode='PUMP_TOTALIZER' THEN allocation.volume ELSE reading.volume END) AS quantity
             FROM meter_reading_batches batch
             JOIN stations station ON station.client_id=batch.client_id AND station.id=batch.station_id
             JOIN meter_readings reading ON reading.client_id=batch.client_id AND reading.station_id=batch.station_id AND reading.batch_id=batch.id
             JOIN station_equipment equipment ON equipment.client_id=reading.client_id AND equipment.station_id=reading.station_id AND equipment.id=reading.equipment_id
             LEFT JOIN meter_reading_product_allocations allocation ON allocation.client_id=reading.client_id AND allocation.station_id=reading.station_id AND allocation.reading_id=reading.id
             WHERE batch.client_id=$1 AND batch.station_id=$2 AND batch.status='VALIDATED' AND batch.business_date<=$3
             GROUP BY COALESCE(allocation.product_id,equipment.product_id)
           ), dip_by_product AS (
             SELECT tank.product_id,count(*) AS tank_count,
               count(*) FILTER (WHERE dip.id IS NOT NULL AND calibration.id IS NOT NULL
                 AND tank_volume_at_depth(calibration.id,dip.product_depth_mm) IS NOT NULL) AS calibrated_count,
               sum(CASE WHEN dip.id IS NOT NULL AND calibration.id IS NOT NULL
                 THEN tank_volume_at_depth(calibration.id,dip.product_depth_mm)
                   -COALESCE(tank_volume_at_depth(calibration.id,dip.water_depth_mm),0) END) AS volume
             FROM station_equipment tank
             LEFT JOIN station_day_inputs day ON day.client_id=tank.client_id AND day.station_id=tank.station_id
               AND day.business_date=$3 AND day.status='VALIDATED'
             LEFT JOIN station_day_dips dip ON dip.client_id=day.client_id AND dip.station_id=day.station_id
               AND dip.day_input_id=day.id AND dip.tank_id=tank.id
             LEFT JOIN LATERAL (SELECT c.id FROM tank_calibrations c WHERE c.client_id=tank.client_id AND c.station_id=tank.station_id
               AND c.tank_id=tank.id AND c.status='ACTIVE' AND c.effective_from<=$3 ORDER BY c.effective_from DESC LIMIT 1) calibration ON true
             WHERE tank.client_id=$1 AND tank.station_id=$2 AND tank.kind='TANK' AND tank.retired_at IS NULL
             GROUP BY tank.product_id
           )
           SELECT product.id AS "productId",product.code,product.name,product.product_type AS "productType",product.unit_code AS "unitCode",
             COALESCE((SELECT sum(move.quantity_delta) FROM stock_movements move WHERE move.client_id=$1 AND move.station_id=$2
               AND move.product_id=product.id AND move.business_date<=$3),0)
               -CASE WHEN product.product_type='FUEL' THEN COALESCE(meter.quantity,0) ELSE 0 END AS "theoreticalStock",
             CASE WHEN product.product_type='FUEL' AND COALESCE(dip.tank_count,0)>0 AND dip.tank_count=dip.calibrated_count
               THEN dip.volume END AS "actualDipStock",
             CASE WHEN product.product_type='FUEL' AND COALESCE(dip.tank_count,0)>0 AND dip.tank_count=dip.calibrated_count
               THEN dip.volume-(COALESCE((SELECT sum(move.quantity_delta) FROM stock_movements move WHERE move.client_id=$1 AND move.station_id=$2 AND move.product_id=product.id AND move.business_date<=$3),0)-COALESCE(meter.quantity,0)) END AS "variance",
             threshold.max_abs_variance AS "maxAbsVariance",
             CASE WHEN threshold.max_abs_variance IS NOT NULL AND product.product_type='FUEL'
               AND COALESCE(dip.tank_count,0)>0 AND dip.tank_count=dip.calibrated_count
               THEN abs(dip.volume-(COALESCE((SELECT sum(move.quantity_delta) FROM stock_movements move WHERE move.client_id=$1 AND move.station_id=$2 AND move.product_id=product.id AND move.business_date<=$3),0)-COALESCE(meter.quantity,0)))<=threshold.max_abs_variance END AS "withinVarianceThreshold"
           FROM station_products assignment JOIN products product ON product.client_id=assignment.client_id AND product.id=assignment.product_id
           LEFT JOIN meter_volume meter ON meter.product_id=product.id
           LEFT JOIN dip_by_product dip ON dip.product_id=product.id
           LEFT JOIN station_fuel_variance_thresholds threshold ON threshold.client_id=$1 AND threshold.station_id=$2 AND threshold.product_id=product.id
           WHERE assignment.client_id=$1 AND assignment.station_id=$2 AND product.is_active AND product.product_type<>'SERVICE'
           ORDER BY product.product_type,product.name`, [clientId,stationId,businessDate]);
        return result.rows;
      });
      send(res, 200, { businessDate, inventory }); return true;
    }
    if (kind === "stock-adjustments" && req.method === "POST") {
      roles(principal,["OWNER","MANAGER","SUPER_ADMIN"]);
      const body = await json(req);
      const productId = text(body.productId,"product id",36);
      if (!uuid.test(productId)) throw new IdentityError(400,"Invalid product id");
      const quantity = number(body.quantityDelta,"quantity delta",3,true);
      if (Number(quantity)===0) throw new IdentityError(400,"Quantity delta cannot be zero");
      const businessDate = date(body.businessDate);
      const reason = text(body.reason,"adjustment reason",1000);
      const movementType = body.movementType ?? "ADJUSTMENT";
      if (movementType!=="ADJUSTMENT" && movementType!=="OPENING_BALANCE") throw new IdentityError(400,"Invalid stock movement type");
      const result = await withPrincipal(principal,async (db)=>{
        const movement = await db.query(
          `INSERT INTO stock_movements (client_id,station_id,product_id,movement_type,quantity_delta,business_date,source_id,reason,recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,gen_random_uuid(),$7,$8)
           RETURNING id,product_id AS "productId",movement_type AS "movementType",quantity_delta AS "quantityDelta",business_date AS "businessDate",reason,recorded_at AS "recordedAt"`,
          [clientId,stationId,productId,movementType,quantity,businessDate,reason,principal.userId]);
        await audit(db,clientId,stationId,principal.userId,"STOCK_ADJUSTED","stock_movement",movement.rows[0]!.id,{productId,quantityDelta:quantity,businessDate,reason,movementType});
        return movement.rows[0];
      });
      send(res,201,{ movement:result }); return true;
    }
    if (kind === "purchase-receipts" && (req.method === "GET" || req.method === "POST")) {
      roles(principal,req.method==="GET"?["OWNER","MANAGER","ACCOUNTANT","SUPER_ADMIN"]:["OWNER","MANAGER","ACCOUNTANT","SUPER_ADMIN"]);
      if (req.method === "GET") {
        const receipts = await withPrincipal(principal,(db)=>db.query(
          `SELECT receipt.id,receipt.supplier_id AS "supplierId",supplier.name AS "supplierName",receipt.supplier_reference AS "supplierReference",
            receipt.business_date AS "businessDate",receipt.currency_code AS "currencyCode",receipt.status,receipt.created_at AS "createdAt",receipt.posted_at AS "postedAt",
            COALESCE((SELECT jsonb_agg(jsonb_build_object('productId',line.product_id,'tankId',line.tank_id,'quantity',line.quantity,'unitCost',line.unit_cost) ORDER BY line.id)
              FROM purchase_receipt_lines line WHERE line.receipt_id=receipt.id),'[]'::jsonb) AS lines
           FROM purchase_receipts receipt JOIN suppliers supplier ON supplier.client_id=receipt.client_id AND supplier.id=receipt.supplier_id
           WHERE receipt.client_id=$1 AND receipt.station_id=$2 ORDER BY receipt.business_date DESC,receipt.created_at DESC LIMIT 500`,[clientId,stationId]));
        send(res,200,{receipts:receipts.rows}); return true;
      }
      const body = await json(req);
      const supplierId = text(body.supplierId,"supplier id",36);
      if (!uuid.test(supplierId)) throw new IdentityError(400,"Invalid supplier id");
      const businessDate = date(body.businessDate);
      const currencyCode = text(body.currencyCode,"currency code",3).toUpperCase();
      if (!/^[A-Z]{3}$/.test(currencyCode)) throw new IdentityError(400,"Currency code must be three letters");
      const reference = body.supplierReference==null||body.supplierReference===""?null:text(body.supplierReference,"supplier reference",120);
      if (!Array.isArray(body.lines)||body.lines.length<1||body.lines.length>100) throw new IdentityError(400,"Receipt needs 1 to 100 lines");
      const lines = body.lines.map((entry)=>{
        if (!entry||typeof entry!=="object"||Array.isArray(entry)) throw new IdentityError(400,"Invalid receipt line");
        const line=entry as Body; const productId=text(line.productId,"product id",36);
        if (!uuid.test(productId)) throw new IdentityError(400,"Invalid product id");
        const tankId=line.tankId==null||line.tankId===""?null:text(line.tankId,"tank id",36);
        if (tankId&&!uuid.test(tankId)) throw new IdentityError(400,"Invalid tank id");
        return {productId,tankId,quantity:number(line.quantity,"quantity",3,false,true),unitCost:number(line.unitCost,"unit cost",4)};
      });
      const saved=await withPrincipal(principal,async(db)=>{
        const header=await db.query<{id:string}>(
          `INSERT INTO purchase_receipts (client_id,station_id,supplier_id,supplier_reference,business_date,currency_code,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[clientId,stationId,supplierId,reference,businessDate,currencyCode,principal.userId]);
        const receiptId=header.rows[0]!.id;
        for (const line of lines) await db.query(
          `INSERT INTO purchase_receipt_lines (client_id,station_id,receipt_id,product_id,tank_id,quantity,unit_cost) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [clientId,stationId,receiptId,line.productId,line.tankId,line.quantity,line.unitCost]);
        const posted=await db.query(
          `UPDATE purchase_receipts SET status='POSTED',posted_by=$3,posted_at=now() WHERE client_id=$1 AND id=$2
           RETURNING id,supplier_id AS "supplierId",supplier_reference AS "supplierReference",business_date AS "businessDate",currency_code AS "currencyCode",status,posted_at AS "postedAt"`,
          [clientId,receiptId,principal.userId]);
        await audit(db,clientId,stationId,principal.userId,"PURCHASE_RECEIPT_POSTED","purchase_receipt",receiptId,{supplierId,businessDate,lineCount:lines.length});
        return posted.rows[0];
      });
      send(res,201,{receipt:saved}); return true;
    }
    if (kind === "stock-movements" && req.method === "GET") {
      roles(principal,["OWNER","MANAGER","ACCOUNTANT","CASHIER","SUPER_ADMIN"]);
      const productId=url.searchParams.get("productId");
      if (productId&&!uuid.test(productId)) throw new IdentityError(400,"Invalid product id");
      const result=await withPrincipal(principal,(db)=>db.query(
        `SELECT movement.id,movement.product_id AS "productId",product.code AS "productCode",product.name AS "productName",
          movement.movement_type AS "movementType",movement.quantity_delta AS "quantityDelta",movement.business_date AS "businessDate",movement.reason,movement.recorded_at AS "recordedAt"
         FROM stock_movements movement JOIN products product ON product.client_id=movement.client_id AND product.id=movement.product_id
         WHERE movement.client_id=$1 AND movement.station_id=$2 AND ($3::uuid IS NULL OR movement.product_id=$3)
         ORDER BY movement.business_date DESC,movement.recorded_at DESC LIMIT 1000`,[clientId,stationId,productId]));
      send(res,200,{movements:result.rows}); return true;
    }
    return false;
  }

  const componentsRoute=path.match(/^\/stations\/([^/]+)\/services\/([^/]+)\/components$/);
  if (componentsRoute) {
    const [,stationId,serviceProductId]=componentsRoute;
    if (!uuid.test(stationId)||!uuid.test(serviceProductId)) throw new IdentityError(404,"Service not found");
    requireAccess(principal,{clientId,stationId});
    if (req.method==="GET") {
      roles(principal,["OWNER","MANAGER","ACCOUNTANT","CASHIER","SUPER_ADMIN"]);
      const result=await withPrincipal(principal,(db)=>db.query(
        `SELECT c.component_product_id AS "productId",p.code,p.name,c.quantity_per_service AS "quantityPerService",p.unit_code AS "unitCode"
         FROM service_components c JOIN products p ON p.client_id=c.client_id AND p.id=c.component_product_id
         WHERE c.client_id=$1 AND c.station_id=$2 AND c.service_product_id=$3 ORDER BY p.name`,[clientId,stationId,serviceProductId]));
      send(res,200,{components:result.rows}); return true;
    }
    if (req.method==="PUT") {
      roles(principal,["OWNER","MANAGER","SUPER_ADMIN"]);
      const body=await json(req);
      if (!Array.isArray(body.components)||body.components.length>100) throw new IdentityError(400,"components must be an array with at most 100 items");
      const components=body.components.map((entry)=>{
        if(!entry||typeof entry!=="object"||Array.isArray(entry)) throw new IdentityError(400,"Invalid service component");
        const component=entry as Body; const productId=text(component.productId,"component product id",36);
        if(!uuid.test(productId)) throw new IdentityError(400,"Invalid component product id");
        return {productId,quantity:number(component.quantityPerService,"quantity per service",3,false,true)};
      });
      if(new Set(components.map((component)=>component.productId)).size!==components.length) throw new IdentityError(400,"Service component products must be unique");
      const result=await withPrincipal(principal,async(db)=>{
        const service=await db.query(`SELECT 1 FROM station_products assignment JOIN products product ON product.client_id=assignment.client_id AND product.id=assignment.product_id
          WHERE assignment.client_id=$1 AND assignment.station_id=$2 AND assignment.product_id=$3 AND product.product_type='SERVICE'`,[clientId,stationId,serviceProductId]);
        if(!service.rowCount) throw new IdentityError(404,"Active station service product not found");
        const before=await db.query(`SELECT component_product_id,quantity_per_service FROM service_components WHERE client_id=$1 AND station_id=$2 AND service_product_id=$3`,[clientId,stationId,serviceProductId]);
        await db.query(`DELETE FROM service_components WHERE client_id=$1 AND station_id=$2 AND service_product_id=$3`,[clientId,stationId,serviceProductId]);
        for(const component of components) await db.query(
          `INSERT INTO service_components (client_id,station_id,service_product_id,component_product_id,quantity_per_service,updated_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,[clientId,stationId,serviceProductId,component.productId,component.quantity,principal.userId]);
        await audit(db,clientId,stationId,principal.userId,"SERVICE_COMPONENTS_SET","service_product",serviceProductId,
          {before:before.rows,after:components});
        return components;
      });
      send(res,200,{components:result}); return true;
    }
  }
  return false;
}

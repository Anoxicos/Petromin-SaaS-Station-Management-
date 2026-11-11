import type { IncomingMessage, ServerResponse } from "node:http";
import type { PoolClient } from "pg";
import type { Principal } from "../domain/authorization.js";
import { withPrincipal } from "../infrastructure/db.js";
import { IdentityError } from "../infrastructure/identity.js";

type Body = Record<string, unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body));
}
async function read(req: IncomingMessage): Promise<Body> {
  const chunks: Buffer[]=[]; let size=0;
  for await(const chunk of req){const part=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=part.length;if(size>65_536)throw new IdentityError(400,"Request body is too large");chunks.push(part);}
  try{const value:unknown=JSON.parse(Buffer.concat(chunks).toString("utf8"));if(!value||typeof value!=="object"||Array.isArray(value))throw new Error();return value as Body;}catch{throw new IdentityError(400,"Expected a JSON object");}
}
function text(value:unknown,label:string,max=200):string{if(typeof value!=="string"||!value.trim()||value.trim().length>max)throw new IdentityError(400,`Invalid ${label}`);return value.trim();}
function date(value:unknown,label:string):string{const raw=text(value,label,10);const parsed=new Date(`${raw}T00:00:00Z`);if(!/^\d{4}-\d{2}-\d{2}$/.test(raw)||Number.isNaN(parsed.valueOf())||parsed.toISOString().slice(0,10)!==raw)throw new IdentityError(400,`${label} must be a valid YYYY-MM-DD date`);return raw;}
function superAdmin(principal:Principal):void{if(principal.role!=="SUPER_ADMIN")throw new IdentityError(403,"Super-admin access required");}
const onboardingTasks=[
  ["ACCESS_AND_USERS","Confirm access and roles","The client owner confirms named users, station access, and least-privilege roles.","CLIENT","OWNER"],
  ["STATION_DAY_RULES","Confirm station day rules","Operations confirms each station cutoff, time zone, and which night readings belong to its business date.","CLIENT","MANAGER"],
  ["PRODUCTS_AND_TARIFFS","Configure products and tariffs","Assign each station's product catalogue and enter dated prices from client records.","CLIENT","MANAGER"],
  ["EQUIPMENT_AND_TANKS","Record equipment and calibration","Record pumps, meters, nozzles, tanks, assignments, and supplied tank calibration curves.","CLIENT","MANAGER"],
  ["FINANCE_PROFILE","Approve finance configuration","The client accountant supplies and approves tax rules and invoice legal wording; obtain local advice as needed.","CLIENT","ACCOUNTANT"],
  ["STOCK_CONTROLS","Confirm stock controls","Operations supplies dip frequency, stock variance thresholds, and inventory reconciliation rules.","CLIENT","MANAGER"],
  ["HISTORY_RECONCILIATION","Import and reconcile history","Agree history dates/volume and paper digitization responsibility, then validate opening balances against source records.","CLIENT","ACCOUNTANT"],
  ["PRIVACY_AND_RETENTION","Confirm privacy and retention","The client/legal owner confirms applicable data rules, retention duration, archive access, and incident contacts.","CLIENT","ACCOUNTANT"],
  ["SUPPORT_TRAINING","Deliver setup and support handover","Provider completes operator/admin training and shares the agreed runbook and support channels.","PROVIDER","PROVIDER"],
  ["PILOT_ACCEPTANCE","Record pilot acceptance","Provider records that the authenticated REC scenarios, load/restore evidence, and client sign-off are complete.","PROVIDER","PROVIDER"],
] as const;
function stationSettings(raw:unknown):{code:string;name:string;meterMode:string;closingCutoff:string;timeZone:string;closingDayRule:string|null}{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new IdentityError(400,"Each station must include its setup fields");const row=raw as Body;
  const code=text(row.code,"station code",32).toUpperCase();if(!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(code))throw new IdentityError(400,"Invalid station code");
  const name=text(row.name,"station name");if(row.meterMode!=="NOZZLE"&&row.meterMode!=="PUMP_TOTALIZER")throw new IdentityError(400,"meterMode must be NOZZLE or PUMP_TOTALIZER");
  const closingCutoff=text(row.closingCutoff,"closing cutoff",8);if(!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(closingCutoff))throw new IdentityError(400,"closingCutoff must use HH:mm or HH:mm:ss");
  const timeZone=text(row.timeZone,"time zone",80);try{new Intl.DateTimeFormat("en",{timeZone}).format();}catch{throw new IdentityError(400,"timeZone must be a valid IANA time zone");}
  const closingDayRule=row.closingDayRule??null;if(closingDayRule!==null&&closingDayRule!=="CUTOFF_STARTS_DAY"&&closingDayRule!=="CUTOFF_ENDS_DAY")throw new IdentityError(400,"Invalid closingDayRule");
  return{code,name,meterMode:row.meterMode,closingCutoff,timeZone,closingDayRule};
}
async function audit(db:PoolClient,actor:string,action:string,entity:string,id:string,clientId:string|null=null,details:unknown={}):Promise<void>{
  await db.query(`INSERT INTO audit_events(client_id,actor_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[clientId,actor,action,entity,id,JSON.stringify(details)]);
}

export async function handlePlatformAdminRoutes(req:IncomingMessage,res:ServerResponse,principal:Principal,url:URL):Promise<boolean>{
  const path=url.pathname;
  if(path==="/client/support-requests"&&principal.clientId){
    const clientId=principal.clientId;
    if(req.method==="GET"){
      const result=await withPrincipal(principal,db=>db.query(`SELECT id,category,subject,description,status,created_at AS "createdAt",updated_at AS "updatedAt",resolved_at AS "resolvedAt",closed_at AS "closedAt" FROM support_requests WHERE client_id=$1 ORDER BY updated_at DESC LIMIT 100`,[clientId]));
      send(res,200,{requests:result.rows});return true;
    }
    if(req.method==="POST"){
      const input=await read(req);const category=text(input.category,"category",32);if(!["OPERATIONS","ACCESS","DATA_ISSUE","OTHER"].includes(category))throw new IdentityError(400,"Invalid support category");
      const subject=text(input.subject,"subject",160),description=text(input.description,"description",5000);
      const created=await withPrincipal(principal,async db=>{const row=await db.query(`INSERT INTO support_requests(client_id,opened_by,category,subject,description) VALUES($1,$2,$3,$4,$5) RETURNING id,category,subject,description,status,created_at AS "createdAt"`,[clientId,principal.userId,category,subject,description]);await audit(db,principal.userId,"SUPPORT_REQUEST_OPENED","support_request",(row.rows[0] as {id:string}).id,clientId,{category});return row.rows[0];});send(res,201,{request:created});return true;
    }
  }
  const clientSupportMessage=path.match(/^\/client\/support-requests\/([0-9a-f-]+)\/messages$/);
  if(clientSupportMessage&&uuid.test(clientSupportMessage[1])&&req.method==="GET"){
    if(!principal.clientId)throw new IdentityError(403,"Select a client workspace first");const messages=await withPrincipal(principal,db=>db.query(`SELECT m.id,m.actor_id AS "actorId",m.message_type AS "messageType",m.status_from AS "statusFrom",m.status_to AS "statusTo",m.message,m.created_at AS "createdAt" FROM support_request_messages m JOIN support_requests r ON r.client_id=m.client_id AND r.id=m.support_request_id WHERE m.client_id=$1 AND m.id IS NOT NULL AND r.id=$2 ORDER BY m.created_at,m.id`,[principal.clientId,clientSupportMessage[1]]));send(res,200,{messages:messages.rows});return true;
  }
  if(clientSupportMessage&&uuid.test(clientSupportMessage[1])&&req.method==="POST"){
    if(!principal.clientId||!["OWNER","MANAGER","ACCOUNTANT","CASHIER","SUPER_ADMIN"].includes(principal.role))throw new IdentityError(403,"Client support access required");
    const input=await read(req),message=text(input.message,"message",5000);const id=clientSupportMessage[1];
    const result=await withPrincipal(principal,async db=>{const inserted=await db.query(`INSERT INTO support_request_messages(client_id,support_request_id,actor_id,message_type,visibility,message) SELECT $1,r.id,$2,'MESSAGE','CLIENT',$3 FROM support_requests r WHERE r.client_id=$1 AND r.id=$4 AND r.status<>'CLOSED' RETURNING id,created_at AS "createdAt"`,[principal.clientId,principal.userId,message,id]);if(!inserted.rowCount)throw new IdentityError(404,"Open support request not found");return inserted.rows[0];});send(res,201,{message:result});return true;
  }
  if(path==="/admin/platform/support-requests"&&req.method==="GET"){
    superAdmin(principal);const status=url.searchParams.get("status");
    const result=await withPrincipal(principal,db=>db.query(`SELECT r.id,r.client_id AS "clientId",c.code AS "clientCode",c.name AS "clientName",r.category,r.subject,r.description,r.status,r.assigned_to AS "assignedTo",r.resolution_note AS "resolutionNote",r.created_at AS "createdAt",r.updated_at AS "updatedAt",r.resolved_at AS "resolvedAt",r.closed_at AS "closedAt" FROM support_requests r JOIN clients c ON c.id=r.client_id WHERE ($1::text IS NULL OR r.status=$1) ORDER BY CASE WHEN r.status IN('CLOSED','RESOLVED') THEN 1 ELSE 0 END,r.updated_at DESC LIMIT 200`,[status]));send(res,200,{requests:result.rows});return true;
  }
  const adminSupport=path.match(/^\/admin\/platform\/support-requests\/([0-9a-f-]+)(?:\/(messages))?$/);
  if(adminSupport){
    superAdmin(principal);if(!uuid.test(adminSupport[1]))throw new IdentityError(404,"Support request not found");const id=adminSupport[1];
    if(req.method==="GET"&&!adminSupport[2]){
      const data=await withPrincipal(principal,async db=>{const request=await db.query(`SELECT r.id,r.client_id AS "clientId",c.code AS "clientCode",c.name AS "clientName",r.opened_by AS "openedBy",r.category,r.subject,r.description,r.status,r.assigned_to AS "assignedTo",r.resolution_note AS "resolutionNote",r.created_at AS "createdAt",r.updated_at AS "updatedAt",r.resolved_at AS "resolvedAt",r.closed_at AS "closedAt" FROM support_requests r JOIN clients c ON c.id=r.client_id WHERE r.id=$1`,[id]);if(!request.rowCount)throw new IdentityError(404,"Support request not found");const messages=await db.query(`SELECT id,actor_id AS "actorId",message_type AS "messageType",visibility,status_from AS "statusFrom",status_to AS "statusTo",message,created_at AS "createdAt" FROM support_request_messages WHERE support_request_id=$1 ORDER BY created_at,id`,[id]);return{request:request.rows[0],messages:messages.rows};});send(res,200,data);return true;
    }
    if(req.method==="POST"&&adminSupport[2]){
      const input=await read(req),message=text(input.message,"message",5000);if(input.visibility!=="CLIENT"&&input.visibility!=="PROVIDER")throw new IdentityError(400,"visibility must be CLIENT or PROVIDER");
      const saved=await withPrincipal(principal,async db=>{const row=await db.query(`INSERT INTO support_request_messages(client_id,support_request_id,actor_id,message_type,visibility,message) SELECT client_id,id,$2,'MESSAGE',$3,$4 FROM support_requests WHERE id=$1 RETURNING id,created_at AS "createdAt"`,[id,principal.userId,input.visibility,message]);if(!row.rowCount)throw new IdentityError(404,"Support request not found");await db.query(`UPDATE support_requests SET updated_at=now() WHERE id=$1`,[id]);return row.rows[0];});send(res,201,{message:saved});return true;
    }
    if(req.method==="PATCH"&&!adminSupport[2]){
      const input=await read(req);const status=text(input.status,"status",32);if(!["NEW","ACKNOWLEDGED","IN_PROGRESS","WAITING_FOR_CLIENT","RESOLVED","CLOSED"].includes(status))throw new IdentityError(400,"Invalid support status");
      const note=input.resolutionNote===undefined?null:text(input.resolutionNote,"resolution note",1000);const assigned=input.assignedTo===undefined?undefined:input.assignedTo;
      if(assigned!==undefined&&assigned!==null&&(typeof assigned!=="string"||!uuid.test(assigned)))throw new IdentityError(400,"assignedTo must be a user ID or null");
      const updated=await withPrincipal(principal,async db=>{const previous=await db.query(`SELECT client_id,status,assigned_to FROM support_requests WHERE id=$1 FOR UPDATE`,[id]);if(!previous.rowCount)throw new IdentityError(404,"Support request not found");const old=previous.rows[0] as {client_id:string;status:string;assigned_to:string|null};
        if(assigned!==undefined&&assigned!==null){const provider=await db.query(`SELECT 1 FROM app_users WHERE id=$1 AND is_super_admin`,[assigned]);if(!provider.rowCount)throw new IdentityError(400,"Support can only be assigned to a configured provider super-admin");}
        const result=await db.query(`UPDATE support_requests SET status=$2,assigned_to=CASE WHEN $3::boolean THEN $4::uuid ELSE assigned_to END,resolution_note=CASE WHEN $2 IN('RESOLVED','CLOSED') THEN COALESCE($5,resolution_note) ELSE resolution_note END WHERE id=$1 RETURNING id,status,assigned_to AS "assignedTo",resolution_note AS "resolutionNote",updated_at AS "updatedAt"`,[id,status,assigned!==undefined,assigned??null,note]);
        if(old.status!==status)await db.query(`INSERT INTO support_request_messages(client_id,support_request_id,actor_id,message_type,visibility,status_from,status_to,message) VALUES($1,$2,$3,'STATUS_CHANGE','CLIENT',$4,$5,$6)`,[old.client_id,id,principal.userId,old.status,status,note??`Status changed to ${status.toLowerCase().replaceAll('_',' ')}.`]);
        if(old.assigned_to!==(assigned===undefined?old.assigned_to:assigned))await db.query(`INSERT INTO support_request_messages(client_id,support_request_id,actor_id,message_type,visibility,message) VALUES($1,$2,$3,'ASSIGNMENT','PROVIDER',$4)`,[old.client_id,id,principal.userId,assigned?`Assigned to ${assigned}.`:`Assignment cleared.`]);
        await audit(db,principal.userId,"SUPPORT_REQUEST_UPDATED","support_request",id,old.client_id,{from:old.status,to:status});return result.rows[0];});send(res,200,{request:updated});return true;
    }
    return false;
  }
  const clientChecklist=path.match(/^\/clients\/([0-9a-f-]+)\/onboarding(?:\/([A-Z0-9_]+))?$/);
  if(clientChecklist&&uuid.test(clientChecklist[1])&&(req.method==="GET"&&!clientChecklist[2]||req.method==="PATCH"&&clientChecklist[2])){
    const clientId=clientChecklist[1];if(principal.clientId!==clientId)throw new IdentityError(403,"Select this client workspace first");
    if(principal.role!=="SUPER_ADMIN"&&!["OWNER","MANAGER","ACCOUNTANT"].includes(principal.role))throw new IdentityError(403,"Client onboarding access required");
    if(req.method==="GET"){
      const tasks=await withPrincipal(principal,db=>db.query(`SELECT task_code AS "taskCode",title,description,responsible_party AS "responsibleParty",responsible_role AS "responsibleRole",is_required AS "isRequired",status,completion_note AS "completionNote",completed_by AS "completedBy",completed_at AS "completedAt",waived_by AS "waivedBy",waived_at AS "waivedAt" FROM client_onboarding_tasks WHERE client_id=$1 ORDER BY task_code`,[clientId]));
      send(res,200,{clientId,tasks:tasks.rows,ready:tasks.rows.every((task:{isRequired:boolean;status:string})=>!task.isRequired||task.status!=="PENDING")});return true;
    }
    const taskCode=clientChecklist[2]!;const input=await read(req);if(input.status!=="COMPLETED"&&input.status!=="WAIVED")throw new IdentityError(400,"status must be COMPLETED or WAIVED");const note=text(input.note,"completion note",1000);
    const updated=await withPrincipal(principal,async db=>{
      const task=await db.query(`SELECT responsible_party,responsible_role,status FROM client_onboarding_tasks WHERE client_id=$1 AND task_code=$2 FOR UPDATE`,[clientId,taskCode]);if(!task.rowCount)throw new IdentityError(404,"Onboarding task not found");const current=task.rows[0] as {responsible_party:string;responsible_role:string;status:string};if(current.status!=="PENDING")throw new IdentityError(409,"Onboarding task is already closed");
      if(input.status==="WAIVED"&&principal.role!=="SUPER_ADMIN")throw new IdentityError(403,"Only a super-admin may waive an onboarding task");
      if(input.status==="COMPLETED"&&current.responsible_party==="PROVIDER"&&principal.role!=="SUPER_ADMIN")throw new IdentityError(403,"This task is assigned to the provider");
      if(input.status==="COMPLETED"&&current.responsible_party==="CLIENT"&&principal.role!=="SUPER_ADMIN"&&principal.role!==current.responsible_role)throw new IdentityError(403,`This task is assigned to the client ${current.responsible_role.toLowerCase()}`);
      const result=await db.query(`UPDATE client_onboarding_tasks SET status=$3,completion_note=$4,completed_by=CASE WHEN $3='COMPLETED' THEN $5 END,completed_at=CASE WHEN $3='COMPLETED' THEN now() END,waived_by=CASE WHEN $3='WAIVED' THEN $5 END,waived_at=CASE WHEN $3='WAIVED' THEN now() END WHERE client_id=$1 AND task_code=$2 RETURNING task_code AS "taskCode",status,completion_note AS "completionNote",completed_at AS "completedAt",waived_at AS "waivedAt"`,[clientId,taskCode,input.status,note,principal.userId]);
      await audit(db,principal.userId,"CLIENT_ONBOARDING_TASK_CLOSED","client_onboarding_task",taskCode,clientId,{status:input.status,note});return result.rows[0];
    });send(res,200,{task:updated});return true;
  }
  const adminChecklist=path.match(/^\/admin\/platform\/clients\/([0-9a-f-]+)\/onboarding(?:\/([A-Z0-9_]+))?$/);
  if(adminChecklist&&uuid.test(adminChecklist[1])&&(req.method==="GET"&&!adminChecklist[2]||req.method==="PATCH"&&adminChecklist[2])){
    superAdmin(principal);const clientId=adminChecklist[1];
    if(req.method==="GET"){
      const tasks=await withPrincipal(principal,db=>db.query(`SELECT task_code AS "taskCode",title,description,responsible_party AS "responsibleParty",responsible_role AS "responsibleRole",is_required AS "isRequired",status,completion_note AS "completionNote",completed_at AS "completedAt",waived_at AS "waivedAt" FROM client_onboarding_tasks WHERE client_id=$1 ORDER BY task_code`,[clientId]));
      send(res,200,{clientId,tasks:tasks.rows,ready:tasks.rows.every((task:{isRequired:boolean;status:string})=>!task.isRequired||task.status!=="PENDING")});return true;
    }
    const taskCode=adminChecklist[2]!;const input=await read(req);if(input.status!=="COMPLETED"&&input.status!=="WAIVED")throw new IdentityError(400,"status must be COMPLETED or WAIVED");const note=text(input.note,"completion note",1000);
    const updated=await withPrincipal(principal,async db=>{const task=await db.query(`SELECT status FROM client_onboarding_tasks WHERE client_id=$1 AND task_code=$2 FOR UPDATE`,[clientId,taskCode]);if(!task.rowCount)throw new IdentityError(404,"Onboarding task not found");if((task.rows[0] as {status:string}).status!=="PENDING")throw new IdentityError(409,"Onboarding task is already closed");const result=await db.query(`UPDATE client_onboarding_tasks SET status=$3,completion_note=$4,completed_by=CASE WHEN $3='COMPLETED' THEN $5 END,completed_at=CASE WHEN $3='COMPLETED' THEN now() END,waived_by=CASE WHEN $3='WAIVED' THEN $5 END,waived_at=CASE WHEN $3='WAIVED' THEN now() END WHERE client_id=$1 AND task_code=$2 RETURNING task_code AS "taskCode",status,completion_note AS "completionNote",completed_at AS "completedAt",waived_at AS "waivedAt"`,[clientId,taskCode,input.status,note,principal.userId]);await audit(db,principal.userId,"CLIENT_ONBOARDING_TASK_CLOSED","client_onboarding_task",taskCode,clientId,{status:input.status,note});return result.rows[0];});send(res,200,{task:updated});return true;
  }
  const clientAudit=path.match(/^\/clients\/([0-9a-f-]+)\/audit-events$/);
  if(clientAudit&&uuid.test(clientAudit[1])&&req.method==="GET"){
    const clientId=clientAudit[1];if(principal.clientId!==clientId||!["OWNER","MANAGER","ACCOUNTANT","SUPER_ADMIN"].includes(principal.role))throw new IdentityError(403,"Client audit access required");
    const limit=Math.max(1,Math.min(200,Number(url.searchParams.get("limit")||50)));if(!Number.isInteger(limit))throw new IdentityError(400,"limit must be an integer");
    const events=await withPrincipal(principal,db=>db.query(`SELECT id,station_id AS "stationId",actor_id AS "actorId",action,entity_type AS "entityType",entity_id AS "entityId",reason,details,occurred_at AS "occurredAt" FROM audit_events WHERE client_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT $2`,[clientId,limit]));send(res,200,{events:events.rows});return true;
  }
  const adminAudit=path.match(/^\/admin\/platform\/clients\/([0-9a-f-]+)\/audit-events$/);
  if(adminAudit&&uuid.test(adminAudit[1])&&req.method==="GET"){
    superAdmin(principal);const limit=Math.max(1,Math.min(200,Number(url.searchParams.get("limit")||50)));if(!Number.isInteger(limit))throw new IdentityError(400,"limit must be an integer");
    const events=await withPrincipal(principal,db=>db.query(`SELECT id,station_id AS "stationId",actor_id AS "actorId",action,entity_type AS "entityType",entity_id AS "entityId",reason,details,occurred_at AS "occurredAt" FROM audit_events WHERE client_id=$1 ORDER BY occurred_at DESC,id DESC LIMIT $2`,[adminAudit[1],limit]));send(res,200,{events:events.rows});return true;
  }
  if(path==="/client/billing-statements"&&req.method==="GET"){
    if(!principal.clientId||!["OWNER","MANAGER","ACCOUNTANT"].includes(principal.role))throw new IdentityError(403,"Client owner or accountant access required");
    const statements=await withPrincipal(principal,db=>db.query(`SELECT id,period_start AS "periodStart",period_end AS "periodEnd",currency_code AS "currencyCode",station_count AS "stationCount",monthly_base_fee AS "monthlyBaseFee",monthly_station_fee AS "monthlyStationFee",amount_before_tax AS "amountBeforeTax",status,status_reason AS "statusReason",created_at AS "createdAt",reviewed_at AS "reviewedAt" FROM platform_billing_statements WHERE client_id=$1 ORDER BY period_start DESC`,[principal.clientId]));
    send(res,200,{statements:statements.rows,note:"Internal pre-tax subscription statements; not legal invoices or proof of payment."});return true;
  }
  if(!path.startsWith("/admin/platform/"))return false;
  superAdmin(principal);
  if(path==="/admin/platform/support-assignees"&&req.method==="GET"){
    const users=await withPrincipal(principal,db=>db.query(`SELECT id,email,display_name AS "displayName" FROM app_users WHERE is_super_admin ORDER BY display_name,email`));
    send(res,200,{assignees:users.rows});return true;
  }
  if(path==="/admin/platform/overview"&&req.method==="GET"){
    const overview=await withPrincipal(principal,async db=>{
      const result=await db.query(`SELECT c.id AS "clientId",c.code,c.name,c.created_at AS "createdAt",
        (SELECT count(*) FROM stations s WHERE s.client_id=c.id) AS "stationCount",
        (SELECT count(*) FROM client_memberships m WHERE m.client_id=c.id) AS "userCount",
        sub.id AS "subscriptionId",sub.status AS "subscriptionStatus",sub.effective_from AS "subscriptionStarts",
        plan.code AS "planCode",plan.name AS "planName"
        FROM clients c LEFT JOIN client_subscriptions sub ON sub.client_id=c.id AND sub.status IN('PENDING','ACTIVE','PAUSED')
        LEFT JOIN platform_subscription_plans plan ON plan.id=sub.plan_id ORDER BY c.name`);
      return result.rows;
    });send(res,200,{clients:overview});return true;
  }
  if(path==="/admin/platform/onboard"&&req.method==="POST"){
    const input=await read(req);const name=text(input.clientName,"client name");const code=text(input.clientCode,"client code",32).toUpperCase();
    if(!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(code))throw new IdentityError(400,"Invalid client code");
    const ownerEmail=text(input.ownerEmail,"owner email",320).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail))throw new IdentityError(400,"Invalid owner email");
    if(!Array.isArray(input.stations)||input.stations.length<1||input.stations.length>50)throw new IdentityError(400,"Provide 1 to 50 station setups");
    const stations=input.stations.map(stationSettings);if(new Set(stations.map(x=>x.code)).size!==stations.length)throw new IdentityError(400,"Station codes must be unique within the client");
    const created=await withPrincipal(principal,async db=>{
      const owner=await db.query(`SELECT id,email,display_name FROM app_users WHERE lower(email)=lower($1)`,[ownerEmail]);
      if(!owner.rowCount)throw new IdentityError(404,"Owner account is not provisioned yet; have that user sign in once, then retry onboarding");
      if(owner.rowCount!==1)throw new IdentityError(409,"More than one account matches that email; resolve the duplicate before onboarding");
      const user=owner.rows[0] as {id:string;email:string;display_name:string};
      const client=await db.query(`INSERT INTO clients(name,code) VALUES($1,$2) RETURNING id,name,code,created_at`,[name,code]);
      const tenant=client.rows[0] as {id:string;name:string;code:string;created_at:Date};
      await db.query(`INSERT INTO client_memberships(client_id,user_id,role) VALUES($1,$2,'OWNER')`,[tenant.id,user.id]);
      const stationRows=[];
      for(const station of stations){const result=await db.query(`INSERT INTO stations(client_id,code,name,meter_mode,closing_cutoff,time_zone,closing_day_rule) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,code,name,meter_mode,closing_cutoff::text,time_zone,closing_day_rule`,[tenant.id,station.code,station.name,station.meterMode,station.closingCutoff,station.timeZone,station.closingDayRule]);stationRows.push(result.rows[0]);}
      for(const [taskCode,title,description,responsibleParty,responsibleRole] of onboardingTasks) await db.query(`INSERT INTO client_onboarding_tasks(client_id,task_code,title,description,responsible_party,responsible_role) VALUES($1,$2,$3,$4,$5,$6)`,[tenant.id,taskCode,title,description,responsibleParty,responsibleRole]);
      await audit(db,principal.userId,"CLIENT_ONBOARDED","client",tenant.id,tenant.id,{ownerUserId:user.id,stationIds:stationRows.map((x:{id:string})=>x.id)});
      return{client:tenant,owner:{userId:user.id,email:user.email,displayName:user.display_name},stations:stationRows,onboardingTasks:onboardingTasks.map(([taskCode,title,,responsibleParty,responsibleRole])=>({taskCode,title,responsibleParty,responsibleRole}))};
    });send(res,201,created);return true;
  }
  if(path==="/admin/platform/plans"&&(req.method==="GET"||req.method==="POST")){
    if(req.method==="GET"){
      const plans=await withPrincipal(principal,async db=>{const result=await db.query(`SELECT p.id,p.code,p.name,p.description,p.is_active AS "isActive",p.created_at AS "createdAt",COALESCE(jsonb_agg(jsonb_build_object('id',r.id,'effectiveFrom',r.effective_from,'currencyCode',r.currency_code,'monthlyBaseFee',r.monthly_base_fee,'monthlyStationFee',r.monthly_station_fee) ORDER BY r.effective_from) FILTER(WHERE r.id IS NOT NULL),'[]'::jsonb) AS rates FROM platform_subscription_plans p LEFT JOIN platform_plan_rates r ON r.plan_id=p.id GROUP BY p.id ORDER BY p.name`);return result.rows;});send(res,200,{plans});return true;
    }
    const input=await read(req);const code=text(input.code,"plan code",32).toUpperCase();if(!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(code))throw new IdentityError(400,"Invalid plan code");
    const plan=await withPrincipal(principal,async db=>{const result=await db.query(`INSERT INTO platform_subscription_plans(code,name,description,created_by) VALUES($1,$2,$3,$4) RETURNING id,code,name,description,is_active AS "isActive"`,[code,text(input.name,"plan name",160),typeof input.description==="string"?input.description.trim().slice(0,2000):"",principal.userId]);const row=result.rows[0] as {id:string};await audit(db,principal.userId,"SUBSCRIPTION_PLAN_CREATED","platform_subscription_plan",row.id,null,{code});return result.rows[0];});send(res,201,{plan});return true;
  }
  const rateMatch=path.match(/^\/admin\/platform\/plans\/([0-9a-f-]+)\/rates$/);
  if(rateMatch&&(req.method==="GET"||req.method==="POST")){
    if(!uuid.test(rateMatch[1]))throw new IdentityError(404,"Plan not found");
    if(req.method==="GET"){
      const rates=await withPrincipal(principal,db=>db.query(`SELECT id,effective_from AS "effectiveFrom",currency_code AS "currencyCode",monthly_base_fee AS "monthlyBaseFee",monthly_station_fee AS "monthlyStationFee",created_at AS "createdAt" FROM platform_plan_rates WHERE plan_id=$1 ORDER BY effective_from`,[rateMatch[1]]));send(res,200,{rates:rates.rows});return true;
    }
    const input=await read(req);const currency=text(input.currencyCode,"currency code",3).toUpperCase();if(!/^[A-Z]{3}$/.test(currency))throw new IdentityError(400,"currencyCode must be three letters");
    const money=(v:unknown,label:string)=>{const raw=typeof v==="number"?String(v):v;if(typeof raw!=="string"||!/^\d{1,12}(\.\d{1,2})?$/.test(raw))throw new IdentityError(400,`Invalid ${label}`);return raw;};
    const saved=await withPrincipal(principal,async db=>{const plan=await db.query(`SELECT id,is_active FROM platform_subscription_plans WHERE id=$1 FOR UPDATE`,[rateMatch[1]]);if(!plan.rowCount)throw new IdentityError(404,"Plan not found");if(!(plan.rows[0] as {is_active:boolean}).is_active)throw new IdentityError(409,"Plan is inactive");const result=await db.query(`INSERT INTO platform_plan_rates(plan_id,effective_from,currency_code,monthly_base_fee,monthly_station_fee,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,effective_from AS "effectiveFrom",currency_code AS "currencyCode",monthly_base_fee AS "monthlyBaseFee",monthly_station_fee AS "monthlyStationFee"`,[rateMatch[1],date(input.effectiveFrom,"effectiveFrom"),currency,money(input.monthlyBaseFee,"monthly base fee"),money(input.monthlyStationFee,"monthly station fee"),principal.userId]);const row=result.rows[0] as {id:string};await audit(db,principal.userId,"SUBSCRIPTION_RATE_CREATED","platform_plan_rate",row.id,null,{planId:rateMatch[1],effectiveFrom:input.effectiveFrom,currencyCode:currency});return result.rows[0];});send(res,201,{rate:saved});return true;
  }
  const subscriptionMatch=path.match(/^\/admin\/platform\/clients\/([0-9a-f-]+)\/subscription$/);
  if(subscriptionMatch&&uuid.test(subscriptionMatch[1])&&(req.method==="GET"||req.method==="POST")){
    const clientId=subscriptionMatch[1];
    if(req.method==="GET"){
      const current=await withPrincipal(principal,db=>db.query(`SELECT s.id,s.client_id AS "clientId",s.plan_id AS "planId",p.code AS "planCode",p.name AS "planName",s.status,s.effective_from AS "effectiveFrom",s.effective_until AS "effectiveUntil",s.contract_reference AS "contractReference",s.billing_day AS "billingDay",s.billing_time_zone AS "billingTimeZone" FROM client_subscriptions s JOIN platform_subscription_plans p ON p.id=s.plan_id WHERE s.client_id=$1 ORDER BY s.created_at DESC`,[clientId]));send(res,200,{subscriptions:current.rows});return true;
    }
    const input=await read(req);if(typeof input.planId!=="string"||!uuid.test(input.planId))throw new IdentityError(400,"Invalid planId");if(input.billingDay===undefined||input.billingDay===null||input.billingDay==="")throw new IdentityError(400,"billingDay must be supplied from the agreed billing schedule");const billingDay=Number(input.billingDay);if(!Number.isInteger(billingDay)||billingDay<1||billingDay>31)throw new IdentityError(400,"billingDay must be between 1 and 31");const zone=text(input.billingTimeZone,"billing time zone",80);try{new Intl.DateTimeFormat("en",{timeZone:zone}).format();}catch{throw new IdentityError(400,"Invalid billing time zone");}
    const created=await withPrincipal(principal,async db=>{const plan=await db.query(`SELECT id FROM platform_subscription_plans WHERE id=$1 AND is_active`,[input.planId]);if(!plan.rowCount)throw new IdentityError(404,"Active plan not found");const client=await db.query(`SELECT id FROM clients WHERE id=$1`,[clientId]);if(!client.rowCount)throw new IdentityError(404,"Client not found");const result=await db.query(`INSERT INTO client_subscriptions(client_id,plan_id,effective_from,contract_reference,billing_day,billing_time_zone,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id,client_id AS "clientId",plan_id AS "planId",status,effective_from AS "effectiveFrom",contract_reference AS "contractReference",billing_day AS "billingDay",billing_time_zone AS "billingTimeZone"`,[clientId,input.planId,date(input.effectiveFrom,"effectiveFrom"),input.contractReference?text(input.contractReference,"contract reference",240):null,billingDay,zone,principal.userId]);const row=result.rows[0] as {id:string};await audit(db,principal.userId,"CLIENT_SUBSCRIPTION_CREATED","client_subscription",row.id,clientId,{planId:input.planId,status:"PENDING"});return result.rows[0];});send(res,201,{subscription:created});return true;
  }
  const subState=path.match(/^\/admin\/platform\/subscriptions\/([0-9a-f-]+)$/);
  if(subState&&uuid.test(subState[1])&&req.method==="PATCH"){
    const input=await read(req);if(!["ACTIVE","PAUSED","CANCELLED"].includes(String(input.status)))throw new IdentityError(400,"status must be ACTIVE, PAUSED, or CANCELLED");if(input.status==="ACTIVE"&&!input.contractReference)throw new IdentityError(400,"A real contract reference is required before activating billing");
    const saved=await withPrincipal(principal,async db=>{const old=await db.query(`SELECT client_id,status FROM client_subscriptions WHERE id=$1 FOR UPDATE`,[subState[1]]);if(!old.rowCount)throw new IdentityError(404,"Subscription not found");const prior=old.rows[0] as {client_id:string;status:string};const result=await db.query(`UPDATE client_subscriptions SET status=$2,contract_reference=CASE WHEN $3::text IS NULL THEN contract_reference ELSE $3 END,effective_until=CASE WHEN $4::date IS NULL THEN effective_until ELSE $4 END,updated_by=$5,updated_at=now() WHERE id=$1 RETURNING id,status,client_id AS "clientId",contract_reference AS "contractReference",effective_until AS "effectiveUntil"`,[subState[1],input.status,input.contractReference?text(input.contractReference,"contract reference",240):null,input.effectiveUntil?date(input.effectiveUntil,"effectiveUntil"):null,principal.userId]);await audit(db,principal.userId,"CLIENT_SUBSCRIPTION_STATE_CHANGED","client_subscription",subState[1],prior.client_id,{from:prior.status,to:input.status});return result.rows[0];});send(res,200,{subscription:saved});return true;
  }
  const statementCollection=path.match(/^\/admin\/platform\/clients\/([0-9a-f-]+)\/billing-statements$/);
  if(statementCollection&&uuid.test(statementCollection[1])&&(req.method==="GET"||req.method==="POST")){
    const clientId=statementCollection[1];
    if(req.method==="GET"){
      const statements=await withPrincipal(principal,db=>db.query(`SELECT b.id,b.subscription_id AS "subscriptionId",b.period_start AS "periodStart",b.period_end AS "periodEnd",b.currency_code AS "currencyCode",b.station_count AS "stationCount",b.monthly_base_fee AS "monthlyBaseFee",b.monthly_station_fee AS "monthlyStationFee",b.amount_before_tax AS "amountBeforeTax",b.status,b.status_reason AS "statusReason",b.created_at AS "createdAt",b.reviewed_at AS "reviewedAt",p.code AS "planCode" FROM platform_billing_statements b JOIN client_subscriptions s ON s.client_id=b.client_id AND s.id=b.subscription_id JOIN platform_subscription_plans p ON p.id=s.plan_id WHERE b.client_id=$1 ORDER BY b.period_start DESC`,[clientId]));send(res,200,{statements:statements.rows});return true;
    }
    const input=await read(req);const subscriptionId=text(input.subscriptionId,"subscription identifier",36);if(!uuid.test(subscriptionId))throw new IdentityError(400,"Invalid subscriptionId");const periodStart=date(input.periodStart,"periodStart"),periodEnd=date(input.periodEnd,"periodEnd");
    const start=new Date(`${periodStart}T00:00:00Z`),end=new Date(`${periodEnd}T00:00:00Z`);const nextMonth=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,1));const lastDay=new Date(nextMonth.valueOf()-86400000).toISOString().slice(0,10);
    if(start.getUTCDate()!==1||lastDay!==periodEnd||start.getUTCMonth()!==end.getUTCMonth()||start.getUTCFullYear()!==end.getUTCFullYear())throw new IdentityError(400,"Billing statement periods must be a full calendar month");
    const created=await withPrincipal(principal,async db=>{
      const sub=await db.query(`SELECT s.id,s.plan_id,s.status,s.effective_from,s.effective_until,s.contract_reference FROM client_subscriptions s WHERE s.client_id=$1 AND s.id=$2 FOR UPDATE`,[clientId,subscriptionId]);if(!sub.rowCount)throw new IdentityError(404,"Subscription not found");
      const subscription=sub.rows[0] as {id:string;plan_id:string;status:string;effective_from:string;effective_until:string|null;contract_reference:string|null};
      if(subscription.status!=="ACTIVE"||!subscription.contract_reference)throw new IdentityError(409,"Only a contract-backed active subscription can be billed");
      if(subscription.effective_from>periodStart||(subscription.effective_until&&subscription.effective_until<periodEnd))throw new IdentityError(409,"Billing period falls outside the subscription dates");
      const rate=await db.query(`SELECT id,currency_code,monthly_base_fee,monthly_station_fee FROM platform_plan_rates WHERE plan_id=$1 AND effective_from<=$2 ORDER BY effective_from DESC LIMIT 1`,[subscription.plan_id,periodStart]);if(!rate.rowCount)throw new IdentityError(409,"No configured plan rate covers the start of this period");
      const rateRow=rate.rows[0] as {id:string;currency_code:string;monthly_base_fee:string;monthly_station_fee:string};
      const midPeriodRate=await db.query(`SELECT 1 FROM platform_plan_rates WHERE plan_id=$1 AND effective_from>$2 AND effective_from<=$3 LIMIT 1`,[subscription.plan_id,periodStart,periodEnd]);if(midPeriodRate.rowCount)throw new IdentityError(409,"A plan rate changes during this month; split billing periods after the billing rule is agreed");
      const count=await db.query(`SELECT count(*)::integer AS station_count FROM stations WHERE client_id=$1 AND created_at<$2::date+interval '1 day'`,[clientId,periodEnd]);const stationCount=Number((count.rows[0] as {station_count:number}).station_count);
      const result=await db.query(`INSERT INTO platform_billing_statements(client_id,subscription_id,plan_rate_id,period_start,period_end,currency_code,station_count,monthly_base_fee,monthly_station_fee,amount_before_tax,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,round($8::numeric+$9::numeric*$7,2),$10) RETURNING id,period_start AS "periodStart",period_end AS "periodEnd",currency_code AS "currencyCode",station_count AS "stationCount",monthly_base_fee AS "monthlyBaseFee",monthly_station_fee AS "monthlyStationFee",amount_before_tax AS "amountBeforeTax",status`,[clientId,subscriptionId,rateRow.id,periodStart,periodEnd,rateRow.currency_code,stationCount,rateRow.monthly_base_fee,rateRow.monthly_station_fee,principal.userId]);
      const row=result.rows[0] as {id:string};await audit(db,principal.userId,"PLATFORM_BILLING_STATEMENT_CREATED","platform_billing_statement",row.id,clientId,{periodStart,periodEnd,stationCount,rateId:rateRow.id});return result.rows[0];
    });send(res,201,{statement:created,note:"Draft pre-tax subscription statement only. No legal invoice or payment has been issued."});return true;
  }
  const statementState=path.match(/^\/admin\/platform\/billing-statements\/([0-9a-f-]+)$/);
  if(statementState&&uuid.test(statementState[1])&&req.method==="PATCH"){
    const input=await read(req);if(input.status!=="APPROVED"&&input.status!=="VOID")throw new IdentityError(400,"status must be APPROVED or VOID");const reason=input.status==="VOID"?text(input.reason,"void reason",1000):input.reason==null?null:text(input.reason,"review note",1000);
    const saved=await withPrincipal(principal,async db=>{const prior=await db.query(`SELECT client_id,status FROM platform_billing_statements WHERE id=$1 FOR UPDATE`,[statementState[1]]);if(!prior.rowCount)throw new IdentityError(404,"Billing statement not found");const before=prior.rows[0] as {client_id:string;status:string};if(before.status!=="DRAFT")throw new IdentityError(409,"Only draft statements can be reviewed");const result=await db.query(`UPDATE platform_billing_statements SET status=$2,status_reason=$3,reviewed_by=$4,reviewed_at=now() WHERE id=$1 RETURNING id,status,status_reason AS "statusReason",reviewed_at AS "reviewedAt"`,[statementState[1],input.status,reason,principal.userId]);await audit(db,principal.userId,"PLATFORM_BILLING_STATEMENT_REVIEWED","platform_billing_statement",statementState[1],before.client_id,{status:input.status,reason});return result.rows[0];});send(res,200,{statement:saved,note:"Approval records an internal review only; external billing and legal invoices are not issued."});return true;
  }
  return false;
}

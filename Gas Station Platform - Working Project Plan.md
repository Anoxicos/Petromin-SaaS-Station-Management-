# Gas Station Platform: Decision Register, Checklist and Milestones

**Working draft v1.2 — 12 October 2026**  
Based on the supplied project brief and project skill. This is a living planning document; decisions marked **Provisional** are working assumptions and can be edited. Effort is sized S / M / L / XL because no start date or deadline has been set.

## 1. Project frame

| Topic | Current position |
| --- | --- |
| Provider | You are the provider and sole developer. |
| Contract | **No contract is in place.** Scope, pricing, and assumptions must be agreed before commitment. |
| Product | One shared SaaS platform, with data isolated per client. Each client may own multiple stations. |
| Launch size | 2–5 clients and 21–50 stations in total. |
| Hosting | Cloud hosting selected and paid by you; include its cost in recurring client pricing. |
| Rollout | Pilot with one client first, then roll out in waves by client. |
| Stack | PostgreSQL 16+ using Docker Desktop for local development; TypeScript is the working language choice. | PostgreSQL and Docker Desktop confirmed; TypeScript remains provisional. Use row-level security alongside application authorization. |

## 2. Current decisions and assumptions

| Topic | Working decision | Status / consequence |
| --- | --- | --- |
| Meter readings | Mixed granularity, configured per station: nozzle or pump/totalizer. | Decided. Both modes need acceptance coverage. |
| Offline mode | Not required; connectivity is assumed reliable. | Decided. Put this assumption in the contract; no offline sync or conflict handling is planned. |
| Invoicing | The app issues invoices, including numbering, VAT, immutability, credit notes, and PDF. | Scope decision. Legal requirements must be confirmed by the client accountant before M3; do not invent tax rules. |
| Day closing | Closing varies by client or station. | Decided. Configure each station's cut-off time and time zone, including the night-reading rule. |
| Fuel prices | Prices change infrequently on scheduled effective dates. | Decided. Store effective date and time; define an exception rule for intraday changes. |
| Bank cards | Staff enter totals and reconcile manually. | Decided. No terminal integration in baseline; bank-file import is optional later work. |
| Tank-to-nozzle | Fixed per station at setup. | Decided. Later changes are audited admin actions. |
| Accounting / ERP | Standard export is baseline; direct API connectors are optional per client. | Decided. Identify software and connector scope client by client. |
| Fuel stock | Staff enter daily manual dip readings. | Decided. Dip entry belongs in daily closing. |
| Credit limits | Block sales automatically; authorized override requires a reason and audit record. | Decided (RG-012, RG-020). |
| Retention | Keep records for a fixed number of years, then archive. | Open: years and archive access/meaning need a decision. |
| History | Import available history, subject to an agreed cap or per-volume price. | Open and high risk: define date range, source quality, and responsibility for paper digitization. |
| Support | You provide support. | Open: hours, channels, response targets, and service level. |
| Client billing | Defer platform billing until after pilot; invoice initial clients manually. | Decided. Client subscription automation is outside the pilot critical path. |
| Pricing | Flexible hybrid structure; no rates set. | **Provisional recommendation:** milestone pricing for the build after scope agreement, with change control; recurring platform fee with a base plus station-count band; one-time onboarding/import; optional support levels and integrations. Confirm structure and amounts before contract. |

## 3. Scope to add beyond functional and technical spec v2.0

The supplied spec has no multi-client concept or client billing. Its invoicing scope is subject to contract. Add and price the following:

- Client (tenant) entity, tenant isolation, and super-admin role across clients.
- In-app legal invoices and credit notes, subject to written local tax and accounting requirements.
- Repeatable client onboarding process and onboarding kit.
- Excel and paper-history import, validation, and opening balances.
- Client subscriptions and billing after the pilot.
- Hosting, monitoring, backups, support, and continuity terms.
- Optional ERP connectors priced per client; standard accounting export is baseline.

## 4. Open points register

Assign a named client-side owner and target milestone for each item. **M0 is active planning; none of the legal or operating answers below are presumed.**

| # | Open point | Decision owner | Blocks | Current note |
| --- | --- | --- | --- | --- |
| 1 | VAT rules, invoice legal mentions, numbering, and compliance | Client accountant | M3 | Obtain written rules before invoice implementation. |
| 2 | Credit schedules, interest, and approval circuit | Client management | M3 | Define before configuring credit workflows. |
| 3 | Availability target, RPO/RTO, concurrent users, transaction volumes | Provider and client | M1, M9 | Needed for architecture and launch operations. |
| 4 | Fuel-stock variance thresholds and inventory frequency | Client operations | M4 | Define acceptable variance and escalation. |
| 5 | Retention years and archive access rights | Client accountant | M1 | Also confirm what “archive” means operationally. |
| 6 | History cap and responsibility for paper digitization | Provider and client | M6 | Recommend a bounded period or per-volume pricing. |
| 7 | Cut-off, time zone, and night-reading rule for each station | Client operations | M2 | Capture station by station. |
| 8 | ERP software and integration scope by client | Client IT | Optional | Connector is separately scoped and priced. |
| 9 | Support hours, channels, and response times | Provider | M9 | Include in service terms. |
| 10 | Applicable Moroccan personal-data requirements and obligations | Legal adviser | M1 | Obtain advice; do not infer compliance rules. |
| 11 | Provider pricing structure and rate card | Provider | M0 | Flexible structure is provisional; amounts not supplied. |
| 12 | Contract status | Provider | M0 | **Answered: no contract.** Scope remains negotiable. |

## 5. Milestone plan

| # | Milestone | Scope | Exit criterion | Effort |
| --- | --- | --- | --- | --- |
| M0 | Decision freeze | Resolve open points as far as possible; agree scope, pricing structure, owners, and contract assumptions. | Register reviewed; baseline scope and commercial approach ready for agreement. | S |
| M1 | Foundations | Confirm stack; tenant isolation, authentication, roles, station setup, audit trail, hosting, backups, CI. | Test client with two differently configured stations is created and isolated. | L |
| M2 | Daily operations | Products and tariffs, equipment, index readings, volumes, cash/card sales, daily dips, core closing. | One full station day closes correctly. | XL |
| M3 | Credit and invoicing | Customers, vouchers, credit sales, limits, payments, credit notes, legal invoices, balances. | Accountant validates tax rules; numbering and immutability are demonstrated. | XL |
| M4 | Stock and products | Articles, services, purchases/receptions, fuel and article stock, full closing and reconciliations. | Theoretical stock reconciles with dips; closing is complete. | L |
| M5 | Reporting | Daily consolidated state by station and client; Excel/PDF and standard export. | Reports match hand-computed examples. | M |
| M6 | Data import | Import tooling, validation, opening balances, pilot history. | Pilot history loads and reconciles within agreed cap. | L |
| M7 | Pilot | One client, 1–3 stations, acceptance scenarios, load and restore demonstrations. | Blocking scenarios pass; decision to generalize is recorded. | M |
| M8 | Platform business | Client onboarding, subscriptions/billing, super-admin and support tooling. | A new client is onboarded end to end. | L |
| M9 | Rollout and operations | Client waves, training, runbook, monitoring, support. | Launch clients are live under agreed operating terms. | M |
| Later | Options | ERP connectors and bank-file import. | Separately scoped and priced. | n/a |

The spec's seven phases map as follows: scoping to M0; design to the first part of M1; build to M1–M6; acceptance and pilot to M7; rollout to M9; warranty and maintenance follow M9.

## 6. Checklist by module

### M01 — Multisite administration and users
- [ ] Client (tenant) entity and tenant isolation.
- [ ] Station sheet with unique code (RG-001).
- [ ] Per-station meter mode, closing cut-off, and time zone.
- [ ] Users, roles, and permissions per client and station.
- [ ] Super-admin role across clients.
- [ ] Server-side authorization on operational data (RG-002, RG-022).

### M02 — Products and tariffs
- [ ] Product catalogue for fuels and other products.
- [ ] Tariff table with effective date/time and history.
- [ ] Transaction price frozen at sale (RG-007).
- [ ] Intraday price-change rule defined (RG-008).

### M03 — Pumps, meters, nozzles, and tanks
- [ ] Equipment has unique identity and assignment history (RG-003).
- [ ] Tank-to-nozzle assignment fixed at setup; changes audited.
- [ ] Meter replacement/reset procedure (RG-004).

### M04 — Manual index readings
- [ ] Nozzle-level or pump/totalizer entry according to station setting.
- [ ] Volume uses final validated index less initial validated index (RG-004).
- [ ] No duplicate validation for the same meter and period (RG-005).
- [ ] Closed readings locked; corrections documented and approved (RG-006).
- [ ] Lower-than-previous index blocked or controlled (REC-03).
- [ ] Rounding and precision defined per data type (RG-019).

### M05 — Cash sales and collections
- [ ] Cash and card sales separated by payment method.
- [ ] Staff-entered card totals and manual reconciliation screen.
- [ ] Payments recorded separately from sales (RG-013).
- [ ] Index-derived sales are not counted twice (RG-009, RG-010).

### M06 — Customer accounts and vouchers
- [ ] Customer accounts and credit sales linked to a customer (RG-011).
- [ ] Vouchers track remaining balance.
- [ ] Credit limit blocks sales; authorized override requires reason and audit (RG-012, RG-020).
- [ ] Payments of earlier invoices do not create new sales (RG-014).
- [ ] Credit notes.
- [ ] Legal invoices: numbering, VAT, mandatory mentions, immutability, PDF; validate rules with client accountant before M3.
- [ ] Payment schedules and interest, after decision.

### M07 — Articles and stock
- [ ] Article catalogue and stock movements.
- [ ] Adjustments require a reason.
- [ ] Theoretical stock calculated from validated movements (RG-015).

### M08 — Services
- [ ] Service sheets include component consumption.
- [ ] Component outflows are not counted as article sales (RG-017).

### M09 — Purchases and supplies
- [ ] Supplier and purchase records.
- [ ] Fuel receptions assigned to a consistent tank and product (RG-016).

### M10 — Daily closing and reconciliations
- [ ] Daily dip entry.
- [ ] Volume and cash variance checks use approved thresholds.
- [ ] Validated closings locked; adjustments preserve the original trace (RG-018).
- [ ] Closing follows each station's cut-off and time-zone rule.

### M11 — Reporting and exports
- [ ] Daily consolidated state by station and client.
- [ ] Excel/PDF exports respect access rights (RG-022, REC-17).
- [ ] Standard accounting export is baseline.

### M12 — Security, permissions, and audit
- [ ] Audit log for sensitive operations (RG-021).
- [ ] Separation of duties for overrides (RG-020).
- [ ] Tenant-isolation tests include exports and reports.

### M13 — Backup and continuity
- [ ] Automated backups.
- [ ] Restore demonstrated and verified (REC-18).
- [ ] RPO/RTO defined and tested.

### M14 — Documentation, training, and deployment
- [ ] User and admin documentation.
- [ ] Training material per role.
- [ ] Operations runbook.
- [ ] Repeatable client onboarding kit.

### New scope outside the supplied spec
- [ ] Excel/paper import tooling with validation and opening balances.
- [ ] Client subscriptions and billing after pilot.
- [ ] Support process and tooling.
- [ ] Optional ERP connectors, priced per client.

## 7. Acceptance scenarios by milestone

| Milestone | Scenarios |
| --- | --- |
| M1 | REC-01 (two stations with different configurations); establish REC-18 backup/restore baseline. |
| M2 | REC-02 to REC-07 (index volumes, duplicates, price history, intraday price, cash, and card). |
| M3 | REC-08 to REC-11 (credit sale, vouchers, limits, and payment of earlier invoice). |
| M4 | REC-12 to REC-14 (fuel reception, article sale, service with components), REC-15, REC-16, REC-20 (closing, daily state, cancellation). |
| M5 | REC-17 (export). |
| M7 | REC-18 demonstrated; REC-19 load test; full run of all blocking scenarios. |

At M7, apply acceptance conditions from spec section 7.1: blocking tests pass; no critical security, integrity, or calculation defect remains; known gaps are documented and accepted; key users validate; documentation is delivered; backup and restore are demonstrated.

## 8. Main risks and responses

| Risk | Response |
| --- | --- |
| Invoice compliance is unconfirmed. | Obtain accountant's written rules before M3; do not estimate legal behavior by assumption. |
| History may be incomplete or paper-based. | Agree a date/volume cap and digitization responsibility; charge excess by volume. |
| One developer handles build, hosting, and support. | Pilot first, defer billing automation and ERP connectors, maintain a runbook, and define service limits. |
| Clients may expect a replacement accounting system. | State the product boundary; standard export is baseline and ERP integration is optional. |
| Tenant isolation failure could expose another client's data. | Enforce isolation in the database and application; test all reads, writes, reports, and exports. |
| Hosting and data protection obligations are unclear. | Obtain legal advice; define data handling, backup, retention, and incident terms before launch. |
| Support could become open-ended. | Set hours, channels, response targets, and service levels before rollout. |

## 9. Working next steps

1. Use this as the M0 working register; assign named client-side owners to open points 1–10.
2. Agree contract scope and provider pricing structure; no contract currently exists and no amounts are set.
3. Obtain legal/accounting input for tax, invoicing, privacy, and retention requirements.
4. Confirm station-by-station closing rules and the history-import cap/responsibilities.
5. Confirm the stack before finalizing M1 architecture and estimates.
6. Update functional and technical spec v2.0 with multi-client SaaS, in-app invoicing, onboarding, history import, billing, hosting/support, and optional integrations.
7. Estimate hours per milestone, then add calendar dates once a start date is agreed.

## 10. Core domain rules to preserve

- Volume distributed, revenue, receivables, and collections are distinct measures. Credit sales are recognized before payment; later payment is not a new sale. Index-derived sales and their cash/credit split must reconcile without double-counting.
- Closed readings and validated closings are locked. Corrections require documentation and approval and retain the original trace.
- Prices are historized and frozen into each transaction. Theoretical stock does not replace physical dip readings.
- Every operational record belongs to a station and client. Server-side authorization applies to application views, reports, and exports.

## Change log

- **v1.1 — 12 October 2026:** Started the working plan from the supplied brief and project skill. Recorded “no contract” as confirmed. Added a flexible hybrid pricing structure as a provisional recommendation, without rates. All remaining unresolved inputs stay open for later editing.
- **v1.2 — 12 October 2026:** Began M1 foundation work in the project workspace: TypeScript service skeleton, tenant/station schema with PostgreSQL row-level security, station meter/closing/time-zone configuration, role/scope helpers, and append-only audit-event table. Stack remained provisional.
- **v1.3 — 12 October 2026:** Confirmed PostgreSQL 16+ and Docker Desktop for local development. Added Docker Compose database/app configuration and first-boot schema initialization. Docker Desktop's engine is currently unavailable in this environment, so containers have not yet been started.
- **v1.4 — 12 October 2026:** Extended M1 with configurable OIDC token verification, verified-subject-to-membership resolution in PostgreSQL, audited client/user/membership/station setup endpoints, and role checks. OIDC provider, first super-admin bootstrap, live database startup, and isolation validation remain outstanding.
- **v1.5 — 12 October 2026:** Added a configurable local rolling backup service and restore-to-new-database procedure. Local execution and restore were subsequently demonstrated during M1 validation; production RPO/RTO, retention, and off-site backup policy remain open.
- **v1.6 — 12 October 2026:** Continued M1 with an audited station-settings update route for meter mode, closing cut-off, and time zone; authorization scope failures now return HTTP 403. Docker TypeScript build passes. Tenant/station isolation and backup restore checks have passed locally. OIDC configuration, production recovery objectives, off-site backup, repeatable upgrade migrations, CI, and agreed service-level targets remain open.
- **v1.7 — 12 October 2026:** Added a transactional, version-tracked SQL migration runner before app startup. It adopts the prior initialized database only after checking required schema and grants; blank-database initialization, repeat runs, and existing-database baseline recording passed in Docker. CI, OIDC configuration, production recovery targets/off-site backups, and service-level targets remain open.
- **v1.8 — 12 October 2026:** Added a locked, one-time super-admin bootstrap SQL procedure that validates inputs and refuses a second bootstrap, plus a GitHub Actions workflow for dependency install, TypeScript build, clean Compose startup, health check, and container build. A disposable Docker database confirmed first-admin creation and second-admin refusal. The workflow is prepared but cannot be confirmed remotely until connected to a Git repository; production bootstrap awaits the selected OIDC provider and real administrator subject.
- **v1.9 — 13 October 2026:** Connected the project to `Anoxicos/Petromin-SaaS-Station-Management-`, pushed the initial `main` branch, and confirmed the first GitHub Actions run passed. Added tenant-scoped membership listing and updates with audit records, restricted manager promotion to owner, and prevented demotion of the last client owner. OIDC provider and production service/recovery/privacy decisions remain open.

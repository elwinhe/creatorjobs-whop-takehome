import{waitUntil}from"@vercel/functions";import{handle}from"hono/vercel";import{serve}from"@hono/node-server";import{Hono}from"hono";import{z}from"zod";function object(value){return typeof value==="object"&&value!==null&&!Array.isArray(value)?value:null}function string(value){return typeof value==="string"&&value.length>0?value:void 0}function paymentOrderId(data){return string(object(data.metadata)?.order_id)}function refundOrderId(data){let payment=object(data.payment);return payment?paymentOrderId(payment):void 0}async function processWebhookEvent(repository,inboxId,event){let envelope=object(event),eventType=string(envelope?.type),data=object(envelope?.data);try{if(!eventType||!data)throw new Error("Webhook envelope is missing type or data");if(eventType==="payment.succeeded"){let orderId=paymentOrderId(data),paymentId=string(data.id);if(!orderId||!paymentId)throw new Error("Payment webhook is missing metadata.order_id or id");let userId=string(object(data.user)?.id);if(!await repository.recordPaymentSucceeded({orderId,paymentId,webhookEventId:inboxId,whopUserId:userId}))throw new Error(`Order not found: ${orderId}`);await repository.markWebhook(inboxId,"processed");return}let transition={"payment.failed":{expected:["pending_payment"],orderId:paymentOrderId(data),to:"canceled"},"payment.pending":{expected:[],orderId:paymentOrderId(data),to:"pending_payment"},"refund.created":{expected:["paid"],orderId:refundOrderId(data),to:"refunded"}}[eventType];if(transition){if(!transition.orderId)throw new Error(`${eventType} is missing metadata.order_id`);if(!await repository.transitionOrder({actor:"webhook",expected:transition.expected,note:`Whop ${eventType}`,orderId:transition.orderId,to:transition.to,webhookEventId:inboxId}))throw new Error(`Order not found: ${transition.orderId}`);await repository.markWebhook(inboxId,"processed");return}if(eventType==="verification.succeeded"||eventType==="payout_method.created"||eventType==="payout_account.status_updated"){let companyId=string(envelope?.company_id)??string(data.company_id);if(!companyId)throw new Error(`${eventType} is missing company_id`);let updated=await repository.updateSellerReadiness(companyId,eventType);await repository.markWebhook(inboxId,updated?"processed":"ignored");return}await repository.markWebhook(inboxId,"ignored")}catch(error){let message=error instanceof Error?error.message:String(error);throw await repository.markWebhook(inboxId,"error",message),error}}async function approveOrderAndPay(repository,whop,platformCompanyId,orderId){let payout=await repository.approveAndCreatePayout(orderId);if(!payout)return null;if(!payout.shouldTransfer)return{payoutId:payout.id,transferred:!1};try{let transfer=await whop.createTransfer({amountCents:payout.amount_cents,currency:payout.currency,destinationId:payout.whop_company_id,idempotencyKey:payout.idempotency_key,orderId:payout.order_id,originId:platformCompanyId,payoutId:payout.id});return await repository.markPayoutProcessing(payout.id,orderId,transfer.id),await whop.retrieveTransfer(transfer.id),await repository.markPayoutSucceeded(payout.id,orderId),{payoutId:payout.id,transferred:!0}}catch(error){let reason=error instanceof Error?error.message:String(error);throw await repository.markPayoutFailed(payout.id,orderId,reason),error}}var idSchema=z.string().uuid(),sellerBodySchema=z.object({display_name:z.string().trim().min(2).max(100),email:z.email().transform((value)=>value.toLowerCase())}),orderBodySchema=z.object({buyer_email:z.email().transform((value)=>value.toLowerCase()),listing_id:idSchema}),submissionBodySchema=z.object({content_url:z.url().nullable().optional(),note:z.string().trim().max(2000).nullable().optional()});function defaultDefer(task){task.catch((error)=>console.error("Deferred webhook processing failed",error))}async function jsonBody(context){try{return await context.req.json()}catch{throw new z.ZodError([{code:"custom",input:void 0,message:"Body must be valid JSON",path:[]}])}}function createMarketplaceApp(dependencies){let app=new Hono,defer=dependencies.defer??defaultDefer;return app.onError((error,context)=>{if(error instanceof z.ZodError)return context.json({error:"Validation failed",issues:error.issues},400);let code=objectCode(error);if(code==="23505")return context.json({error:"Resource already exists"},409);if(code==="23503")return context.json({error:"Related resource does not exist"},409);return console.error(error),context.json({error:error instanceof Error?error.message:"Internal server error"},500)}),app.get("/api/health",async(context)=>{try{let db=await dependencies.repository.ping();return context.json({ok:db,db,environment:dependencies.environment,service:"creatorjobs-api"},db?200:503)}catch{return context.json({ok:!1,db:!1,environment:dependencies.environment,service:"creatorjobs-api"},503)}}),app.post("/api/sellers",async(context)=>{let body=sellerBodySchema.parse(await jsonBody(context)),seller=await dependencies.repository.createSeller(body.email,body.display_name);try{let company=await dependencies.whop.createCompany({email:body.email,parentCompanyId:dependencies.platformCompanyId,sellerId:seller.id,title:body.display_name});return await dependencies.repository.setSellerCompany(seller.id,company.id),context.json(await dependencies.repository.getSeller(seller.id),201)}catch(error){return context.json({error:error instanceof Error?error.message:"Whop company creation failed",seller_id:seller.id},502)}}),app.get("/api/sellers/:id",async(context)=>{let sellerId=idSchema.parse(context.req.param("id")),seller=await dependencies.repository.getSeller(sellerId);return seller?context.json(seller):context.json({error:"Seller not found"},404)}),app.post("/api/sellers/:id/account-link",async(context)=>{let sellerId=idSchema.parse(context.req.param("id")),seller=await dependencies.repository.getSeller(sellerId);if(!seller)return context.json({error:"Seller not found"},404);if(!seller.whop_company_id)return context.json({error:"Seller connected account is not ready"},409);let sellerUrl=`${dependencies.appBaseUrl.replace(/\/$/,"")}/seller?id=${seller.id}`,link;try{link=await dependencies.whop.createAccountLink({companyId:seller.whop_company_id,refreshUrl:sellerUrl,returnUrl:sellerUrl,useCase:"account_onboarding"})}catch{return context.json({error:"Whop account link creation failed"},502)}return await dependencies.repository.setAccountLink(sellerId,link.url),context.json(link)}),app.post("/api/sellers/:id/payout-portal-link",async(context)=>{let sellerId=idSchema.parse(context.req.param("id")),seller=await dependencies.repository.getSeller(sellerId);if(!seller)return context.json({error:"Seller not found"},404);if(!seller.whop_company_id)return context.json({error:"Seller connected account is not ready"},409);let sellerUrl=`${dependencies.appBaseUrl.replace(/\/$/,"")}/seller?id=${seller.id}`;try{let link=await dependencies.whop.createAccountLink({companyId:seller.whop_company_id,refreshUrl:sellerUrl,returnUrl:sellerUrl,useCase:"payouts_portal"});return context.json(link)}catch{return context.json({error:"Whop payout portal link creation failed"},502)}}),app.get("/api/listings",async(context)=>context.json({listings:await dependencies.repository.listListings()})),app.post("/api/orders",async(context)=>{let body=orderBodySchema.parse(await jsonBody(context)),order=await dependencies.repository.createOrder(body.listing_id,body.buyer_email);if(!order)return context.json({error:"Active listing not found"},404);try{let redirectUrl=`${dependencies.appBaseUrl.replace(/\/$/,"")}/orders/${order.id}`,checkout=await dependencies.whop.createCheckout({amountCents:order.amount_cents,currency:order.currency,idempotencyKey:`checkout-${order.id}`,orderId:order.id,redirectUrl});if(!checkout.purchase_url)throw new Error("Whop checkout did not return a purchase URL");return await dependencies.repository.setCheckout(order.id,checkout.id),context.json({order_id:order.id,purchase_url:checkout.purchase_url},201)}catch(error){return context.json({error:error instanceof Error?error.message:"Checkout creation failed",order_id:order.id},502)}}),app.get("/api/orders/:id",async(context)=>{let orderId=idSchema.parse(context.req.param("id")),order=await dependencies.repository.getOrder(orderId);return order?context.json(order):context.json({error:"Order not found"},404)}),app.post("/api/orders/:id/accept",async(context)=>{let orderId=idSchema.parse(context.req.param("id")),result=await dependencies.repository.transitionOrder({actor:"seller",expected:["paid"],orderId,to:"in_progress"});return transitionResponse(context,result)}),app.post("/api/orders/:id/submit",async(context)=>{let orderId=idSchema.parse(context.req.param("id")),body=submissionBodySchema.parse(await jsonBody(context));if(!body.content_url&&!body.note)return context.json({error:"A content URL or note is required"},400);let result=await dependencies.repository.createSubmission(orderId,body.content_url??null,body.note??null);return transitionResponse(context,result)}),app.post("/api/orders/:id/reject",async(context)=>{let orderId=idSchema.parse(context.req.param("id")),result=await dependencies.repository.reviewSubmission(orderId,"reject");return transitionResponse(context,result)}),app.post("/api/orders/:id/approve",async(context)=>{let orderId=idSchema.parse(context.req.param("id"));try{let result=await approveOrderAndPay(dependencies.repository,dependencies.whop,dependencies.platformCompanyId,orderId);return result?context.json(result):context.json({error:"Order cannot be approved"},409)}catch(error){return context.json({error:error instanceof Error?error.message:"Payout failed"},502)}}),app.post("/api/webhooks/whop",async(context)=>{let rawBody=await context.req.text(),headers=Object.fromEntries(context.req.raw.headers.entries()),event;try{event=dependencies.whop.verifyWebhook(rawBody,headers)}catch{return context.json({error:"Invalid webhook signature"},401)}let envelope=event,eventId=headers["webhook-id"]??envelope.id;if(!eventId||!envelope.type)return context.json({error:"Invalid webhook envelope"},400);let inbox=await dependencies.repository.insertWebhook({apiVersionDate:headers["api-version-date"]??envelope.api_version,companyId:envelope.company_id,eventId,eventType:envelope.type,payload:event,rawBody});if(!inbox.duplicate)defer(processWebhookEvent(dependencies.repository,inbox.id,event));return context.json({accepted:!0,duplicate:inbox.duplicate})}),app.get("/api/dashboard",async(context)=>context.json(await dependencies.repository.getDashboard())),app.notFound((context)=>context.json({error:"Not found"},404)),app}function objectCode(error){return typeof error==="object"&&error!==null&&"code"in error?String(error.code):void 0}function transitionResponse(context,result){if(!result)return context.json({error:"Order not found"},404);if(!result.applied)return context.json({error:"Transition rejected",status:result.currentStatus},409);return context.json(result,200)}import postgres from"postgres";function createDatabase(databaseUrl,max=10){return postgres(databaseUrl,{idle_timeout:20,max,prepare:!0,transform:{undefined:null}})}async function closeDatabase(sql){await sql.end({timeout:5})}import{z as z2}from"zod";var baseEnvironmentSchema=z2.object({APP_BASE_URL:z2.url(),DATABASE_URL:z2.string().min(1),NODE_ENV:z2.enum(["development","test","production"]).default("development"),PORT:z2.coerce.number().int().positive().default(3001),WHOP_API_KEY:z2.string().min(1),WHOP_API_URL:z2.url().default("https://sandbox-api.whop.com/api/v1"),WHOP_API_VERSION:z2.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2026-07-20"),WHOP_COMPANY_ID:z2.string().startsWith("biz_"),WHOP_WEBHOOK_SECRET:z2.string().min(1)}),databaseEnvironmentSchema=baseEnvironmentSchema.pick({DATABASE_URL:!0}),testDefaults={APP_BASE_URL:"http://localhost:5173",DATABASE_URL:"postgres://test:test@localhost:5432/creatorjobs_test",NODE_ENV:"test",PORT:3001,WHOP_API_KEY:"test_key",WHOP_API_URL:"https://sandbox-api.whop.com/api/v1",WHOP_API_VERSION:"2026-07-20",WHOP_COMPANY_ID:"biz_test",WHOP_WEBHOOK_SECRET:"test_webhook_secret"};function parseServerEnv(source=process.env){let input=source.NODE_ENV==="test"?{...testDefaults,...source}:source;return baseEnvironmentSchema.parse(input)}async function appendTransition(sql,input){await sql`
    insert into order_events
      (order_id, from_status, to_status, applied, actor, webhook_event_id, note)
    values (
      ${input.orderId}, ${input.from}, ${input.to}, ${input.applied}, ${input.actor},
      ${input.webhookEventId??null}, ${input.note??null}
    )
  `}class PostgresMarketplaceRepository{sql;constructor(sql){this.sql=sql}async ping(){let[row]=await this.sql`select 1 as ok`;return row?.ok===1}async createSeller(email,displayName){return this.sql.begin(async(transaction)=>{let[user]=await transaction`
        insert into users (email, display_name, role)
        values (${email}, ${displayName}, 'seller')
        returning id
      `,[profile]=await transaction`
        insert into seller_profiles (user_id)
        values (${user.id})
        returning id, onboarding_status, has_payout_method, whop_company_id,
          last_account_link_url, ${email}::text as email, ${displayName}::text as display_name
      `;return profile})}async setSellerCompany(sellerId,companyId){await this.sql`
      update seller_profiles set whop_company_id = ${companyId}, updated_at = now()
      where id = ${sellerId} and whop_company_id is null
    `}async setAccountLink(sellerId,url){await this.sql`
      update seller_profiles
      set last_account_link_url = ${url}, onboarding_status = 'link_sent', updated_at = now()
      where id = ${sellerId}
    `}async getSeller(sellerId){let[seller]=await this.sql`
      select sp.id, u.email, u.display_name, sp.whop_company_id, sp.onboarding_status,
        sp.has_payout_method, sp.last_account_link_url
      from seller_profiles sp join users u on u.id = sp.user_id
      where sp.id = ${sellerId}
    `;return seller??null}async listListings(){return this.sql`
      select l.id, l.title, l.description, l.price_cents, l.currency,
        u.display_name as seller_name
      from listings l
      join seller_profiles sp on sp.id = l.seller_id
      join users u on u.id = sp.user_id
      where l.status = 'active'
      order by l.created_at, l.id
    `}async createOrder(listingId,buyerEmail){return this.sql.begin(async(transaction)=>{let[listing]=await transaction`
        select seller_id, price_cents, currency from listings
        where id = ${listingId} and status = 'active'
      `;if(!listing)return null;let[buyer]=await transaction`
        insert into users (email, display_name, role)
        values (${buyerEmail}, ${buyerEmail.split("@")[0]}, 'buyer')
        on conflict (email) do update set email = excluded.email
        returning id, role
      `;if(buyer.role!=="buyer")throw new Error("Email belongs to a non-buyer account");let[order]=await transaction`
        insert into orders (listing_id, buyer_id, seller_id, amount_cents, currency)
        values (${listingId}, ${buyer.id}, ${listing.seller_id}, ${listing.price_cents}, ${listing.currency})
        returning id, amount_cents, currency
      `;return order})}async setCheckout(orderId,checkoutId){await this.sql`
      update orders set whop_checkout_config_id = ${checkoutId}, updated_at = now()
      where id = ${orderId} and whop_checkout_config_id is null
    `}async getOrder(orderId){let[order]=await this.sql`
      select o.*, l.title as listing_title, buyer.email as buyer_email,
        seller_user.display_name as seller_name,
        coalesce((select jsonb_agg(to_jsonb(oe) order by oe.created_at) from order_events oe where oe.order_id = o.id), '[]') as events,
        coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at) from submissions s where s.order_id = o.id), '[]') as submissions
      from orders o
      join listings l on l.id = o.listing_id
      join users buyer on buyer.id = o.buyer_id
      join seller_profiles sp on sp.id = o.seller_id
      join users seller_user on seller_user.id = sp.user_id
      where o.id = ${orderId}
    `;return order??null}async transitionOrder(input){return this.sql.begin(async(transaction)=>{let[order]=await transaction`
        select status from orders where id = ${input.orderId} for update
      `;if(!order)return null;let applied=input.expected.includes(order.status)&&order.status!==input.to;if(applied)await transaction`
          update orders set status = ${input.to}, updated_at = now()
          where id = ${input.orderId} and status = ${order.status}
        `;return await appendTransition(transaction,{...input,applied,from:order.status,note:input.note??(applied?void 0:"Rejected: unexpected current state")}),{applied,currentStatus:applied?input.to:order.status,orderId:input.orderId}})}async recordPaymentSucceeded(input){return this.sql.begin(async(transaction)=>{let[order]=await transaction`
        select buyer_id, status from orders where id = ${input.orderId} for update
      `;if(!order)return null;let applied=order.status==="pending_payment";if(applied){if(await transaction`
          update orders set status = 'paid', whop_payment_id = ${input.paymentId},
            paid_at = now(), updated_at = now()
          where id = ${input.orderId} and status = 'pending_payment'
        `,input.whopUserId)await transaction`
            update users set whop_user_id = ${input.whopUserId}
            where id = ${order.buyer_id} and (whop_user_id is null or whop_user_id = ${input.whopUserId})
          `}return await appendTransition(transaction,{actor:"webhook",applied,from:order.status,orderId:input.orderId,to:"paid",webhookEventId:input.webhookEventId,note:applied?`Whop payment ${input.paymentId}`:"Rejected: unexpected current state"}),{applied,currentStatus:applied?"paid":order.status,orderId:input.orderId}})}async createSubmission(orderId,contentUrl,note){return this.sql.begin(async(transaction)=>{let[order]=await transaction`
        select seller_id, status from orders where id = ${orderId} for update
      `;if(!order)return null;let applied=order.status==="in_progress";if(applied)await transaction`
          insert into submissions (order_id, seller_id, content_url, note)
          values (${orderId}, ${order.seller_id}, ${contentUrl}, ${note})
        `,await transaction`update orders set status = 'delivered', updated_at = now() where id = ${orderId}`;return await appendTransition(transaction,{actor:"seller",applied,from:order.status,orderId,to:"delivered",note:applied?"Deliverable submitted":"Rejected: order is not in progress"}),{applied,currentStatus:applied?"delivered":order.status,orderId}})}async reviewSubmission(orderId,_action){return this.sql.begin(async(transaction)=>{let[order]=await transaction`
        select status from orders where id = ${orderId} for update
      `;if(!order)return null;let applied=order.status==="delivered";if(applied)await transaction`
          update submissions set status = 'rejected'
          where id = (select id from submissions where order_id = ${orderId} order by created_at desc limit 1)
        `,await transaction`update orders set status = 'in_progress', updated_at = now() where id = ${orderId}`;return await appendTransition(transaction,{actor:"buyer",applied,from:order.status,orderId,to:"in_progress",note:applied?"Deliverable rejected for rework":"Rejected: order is not delivered"}),{applied,currentStatus:applied?"in_progress":order.status,orderId}})}async approveAndCreatePayout(orderId){return this.sql.begin(async(transaction)=>{let[order]=await transaction`
        select o.status, o.amount_cents, o.currency, o.seller_id, sp.whop_company_id
        from orders o join seller_profiles sp on sp.id = o.seller_id
        where o.id = ${orderId} for update of o
      `;if(!order)return null;let applied=order.status==="delivered";if(applied){if(!order.whop_company_id)throw new Error("Seller has no connected Whop company");await transaction`
          update submissions set status = 'approved'
          where id = (select id from submissions where order_id = ${orderId} order by created_at desc limit 1)
        `,await transaction`
          update orders set status = 'completed', completed_at = now(), updated_at = now()
          where id = ${orderId} and status = 'delivered'
        `}if(await appendTransition(transaction,{actor:"buyer",applied,from:order.status,orderId,to:"completed",note:applied?"Deliverable approved":"Rejected: order is not delivered"}),!applied&&!["completed","payout_pending","paid_out","payout_failed"].includes(order.status))return null;let[payout]=await transaction`
        insert into payouts (order_id, seller_id, amount_cents, currency)
        values (${orderId}, ${order.seller_id}, ${order.amount_cents}, ${order.currency})
        on conflict (order_id) do update set order_id = excluded.order_id
        returning id, amount_cents, currency, idempotency_key::text, status, whop_transfer_id
      `;if(!order.whop_company_id)throw new Error("Seller has no connected Whop company");let[claim]=await transaction`
        update payouts set status = 'processing', failure_reason = null
        where id = ${payout.id} and status = 'pending' and whop_transfer_id is null
        returning id
      `;return{...payout,order_id:orderId,shouldTransfer:Boolean(claim),whop_company_id:order.whop_company_id}})}async markPayoutProcessing(payoutId,orderId,transferId){await this.sql.begin(async(transaction)=>{await transaction`
        update payouts set status = 'processing', whop_transfer_id = ${transferId}, failure_reason = null
        where id = ${payoutId} and status = 'processing' and whop_transfer_id is null
      `;let[order]=await transaction`
        select status from orders where id = ${orderId} for update
      `;if(order){let applied=order.status==="completed";if(applied)await transaction`update orders set status = 'payout_pending', updated_at = now() where id = ${orderId}`;await appendTransition(transaction,{actor:"system",applied,from:order.status,orderId,to:"payout_pending",note:applied?`Transfer ${transferId} created`:"Transfer already recorded"})}})}async markPayoutSucceeded(payoutId,orderId){await this.sql.begin(async(transaction)=>{await transaction`
        update payouts set status = 'succeeded', settled_at = now(), failure_reason = null
        where id = ${payoutId} and status in ('pending','processing')
      `;let[order]=await transaction`select status from orders where id = ${orderId} for update`;if(order){let applied=order.status==="payout_pending";if(applied)await transaction`update orders set status = 'paid_out', updated_at = now() where id = ${orderId}`;await appendTransition(transaction,{actor:"system",applied,from:order.status,orderId,to:"paid_out",note:"Transfer retrieved successfully"})}})}async markPayoutFailed(payoutId,orderId,reason){await this.sql.begin(async(transaction)=>{await transaction`
        update payouts set status = 'failed', failure_reason = ${reason}
        where id = ${payoutId} and status <> 'succeeded'
      `;let[order]=await transaction`select status from orders where id = ${orderId} for update`;if(order){let applied=["completed","payout_pending"].includes(order.status);if(applied)await transaction`update orders set status = 'payout_failed', updated_at = now() where id = ${orderId}`;await appendTransition(transaction,{actor:"system",applied,from:order.status,orderId,to:"payout_failed",note:reason})}})}async insertWebhook(input){return this.sql.begin(async(transaction)=>{let storedPayload=JSON.parse(JSON.stringify({event:input.payload,raw_body:input.rawBody})),[inserted]=await transaction`
        insert into webhook_events
          (whop_event_id, event_type, api_version_date, whop_company_id, payload)
        values (
          ${input.eventId}, ${input.eventType}, ${input.apiVersionDate??null},
          ${input.companyId??null}, ${transaction.json(storedPayload)}
        )
        on conflict (whop_event_id) do nothing
        returning id
      `;if(inserted)return{duplicate:!1,id:inserted.id};let[existing]=await transaction`
        update webhook_events set status = 'duplicate'
        where whop_event_id = ${input.eventId}
        returning id
      `;return{duplicate:!0,id:existing.id}})}async markWebhook(id,status,error){await this.sql`
      update webhook_events set status = ${status}, error = ${error??null}, processed_at = now()
      where id = ${id} and status <> 'duplicate'
    `}async updateSellerReadiness(companyId,eventType){let[updated]=await this.sql`
      update seller_profiles set
        has_payout_method = case when ${eventType} = 'payout_method.created' then true else has_payout_method end,
        onboarding_status = case
          when ${eventType} = 'payout_method.created' then 'payout_ready'
          when ${eventType} = 'verification.succeeded' then 'verified'
          when ${eventType} = 'payout_account.status_updated' and has_payout_method then 'payout_ready'
          else onboarding_status
        end,
        updated_at = now()
      where whop_company_id = ${companyId}
      returning id
    `;return Boolean(updated)}async getDashboard(){let[orders,sellers,payouts,webhooks,apiErrors,transitionErrors]=await Promise.all([this.sql`select o.id, l.title, u.email as buyer, o.amount_cents, o.currency, o.status, o.whop_payment_id, o.paid_at, o.completed_at, o.created_at from orders o join listings l on l.id = o.listing_id join users u on u.id = o.buyer_id order by o.created_at desc limit 50`,this.sql`select sp.id, u.display_name, u.email, sp.onboarding_status, sp.has_payout_method, sp.whop_company_id from seller_profiles sp join users u on u.id = sp.user_id order by sp.created_at desc`,this.sql`select id, order_id, amount_cents, currency, whop_transfer_id, status, failure_reason, created_at, settled_at from payouts order by created_at desc limit 50`,this.sql`select id, whop_event_id, event_type, status, error, received_at, processed_at from webhook_events order by received_at desc limit 50`,this.sql`select 'api' as source, id, method || ' ' || path as summary, status_code, error, created_at from api_request_log where error is not null or status_code >= 400 order by created_at desc limit 50`,this.sql`select 'transition' as source, id, from_status || ' → ' || to_status as summary, null::integer as status_code, note as error, created_at from order_events where applied = false order by created_at desc limit 50`]);return{orders,sellers,payouts,webhooks,errors:[...apiErrors,...transitionErrors].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,50)}}}import Whop,{APIError}from"@whop/sdk";function errorEvidence(error){if(error instanceof APIError)return{error:error.message,statusCode:error.status,whopRequestId:error.headers?.get("x-request-id")??error.headers?.get("request-id")??void 0};return{error:error instanceof Error?error.message:String(error)}}function createWhopGateway(sql,env){let client=new Whop({apiKey:env.WHOP_API_KEY,baseURL:env.WHOP_API_URL,maxRetries:2,version:env.WHOP_API_VERSION,webhookKey:Buffer.from(env.WHOP_WEBHOOK_SECRET).toString("base64")});async function record(entry){await sql`
      insert into api_request_log (method, path, status_code, whop_request_id, error)
      values (
        ${entry.method}, ${entry.path}, ${entry.statusCode??null},
        ${entry.whopRequestId??null}, ${entry.error??null}
      )
    `}async function logged(method,path,request){try{let{data,response}=await request().withResponse();return await record({method,path,statusCode:response.status,whopRequestId:response.headers.get("x-request-id")??response.headers.get("request-id")??void 0}),data}catch(error){try{await record({method,path,...errorEvidence(error)})}catch(logError){console.error("Failed to persist Whop API error evidence",logError)}throw error}}return{createCompany:(input)=>logged("POST","/companies",()=>client.companies.create({email:input.email,metadata:{seller_id:input.sellerId},parent_company_id:input.parentCompanyId,title:input.title})),createAccountLink:(input)=>logged("POST","/account_links",()=>client.accountLinks.create({company_id:input.companyId,refresh_url:input.refreshUrl,return_url:input.returnUrl,use_case:input.useCase})),createCheckout:async(input)=>{let checkout=await logged("POST","/checkout_configurations",()=>client.checkoutConfigurations.create({account_id:env.WHOP_COMPANY_ID,"Idempotency-Key":input.idempotencyKey,metadata:{order_id:input.orderId},plan:{currency:input.currency,force_create_new_plan:!0,initial_price:input.amountCents/100,plan_type:"one_time",release_method:"buy_now"},redirect_url:input.redirectUrl}));return{id:checkout.id,purchase_url:checkout.purchase_url??null}},createTransfer:async(input)=>{let transfer=await logged("POST","/transfers",()=>client.transfers.create({amount:input.amountCents/100,currency:input.currency,destination_id:input.destinationId,idempotence_key:input.idempotencyKey,"Idempotency-Key":input.idempotencyKey,metadata:{order_id:input.orderId,payout_id:input.payoutId},origin_id:input.originId,type:"ledger"}));if(!("id"in transfer))throw new Error("Whop returned a non-ledger transfer response");return{id:transfer.id}},retrieveTransfer:(transferId)=>logged("GET",`/transfers/${transferId}`,()=>client.transfers.retrieve(transferId)),verifyWebhook:(rawBody,headers)=>client.webhooks.unwrap(rawBody,{headers})}}function createRuntime(source=process.env,options={}){let env=parseServerEnv(source),database=createDatabase(env.DATABASE_URL),repository=new PostgresMarketplaceRepository(database),whop=createWhopGateway(database,env);return{app:createMarketplaceApp({appBaseUrl:env.APP_BASE_URL,defer:options.defer,environment:env.NODE_ENV,platformCompanyId:env.WHOP_COMPANY_ID,repository,whop}),close:()=>closeDatabase(database),env}}function defer(task){waitUntil(task.catch((error)=>console.error("Deferred webhook processing failed",error)))}var runtime=createRuntime(process.env,{defer}),vercel_default=handle(runtime.app);export{vercel_default as default};

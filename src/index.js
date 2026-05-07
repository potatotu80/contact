'use strict';

const AWS = require('aws-sdk');
const twilio = require('twilio');
const { generateTenantApiKey } = require('./utils/tenant-api-key');
const {
  APP_TENANT_ADMIN_UID,
  APP_TENANT_UID,
  APP_USER_UID,
  CONTACT_UID,
  assertTenantScopeForContact,
  assertTenantScopeForUser,
  buildTenantUserImagePrefix,
  getAdminTenantContext,
  getTenantIdsFilter,
  parsePositiveInt,
} = require('./utils/tenant-access');

const buildS3ObjectUrl = (bucket, region, key) => {
  const encodedKey = key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;
};

const buildVoiceIdentity = (adminUser) => {
  const prefix = (process.env.TWILIO_VOICE_IDENTITY_PREFIX || 'admin').trim() || 'admin';
  return `${prefix}-${adminUser.id}`;
};

const getTwilioVoiceConfig = () => ({
  accountSid: (process.env.TWILIO_ACCOUNT_SID || '').trim(),
  apiKeySid: (process.env.TWILIO_VOICE_API_KEY_SID || '').trim(),
  apiKeySecret: (process.env.TWILIO_VOICE_API_KEY_SECRET || '').trim(),
  twimlAppSid: (process.env.TWILIO_VOICE_TWIML_APP_SID || '').trim(),
  callerId: (process.env.TWILIO_VOICE_CALLER_ID || '').trim(),
  tokenTtl: parsePositiveInt(process.env.TWILIO_VOICE_TOKEN_TTL) || 3600,
});

const createVoiceAccessToken = (adminUser) => {
  const config = getTwilioVoiceConfig();

  if (!config.accountSid || !config.apiKeySid || !config.apiKeySecret || !config.twimlAppSid || !config.callerId) {
    throw new Error(
      'Twilio Voice configuration is incomplete. Required: TWILIO_ACCOUNT_SID, ' +
      'TWILIO_VOICE_API_KEY_SID, TWILIO_VOICE_API_KEY_SECRET, TWILIO_VOICE_TWIML_APP_SID, ' +
      'TWILIO_VOICE_CALLER_ID.'
    );
  }

  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;
  const token = new AccessToken(
    config.accountSid,
    config.apiKeySid,
    config.apiKeySecret,
    {
      identity: buildVoiceIdentity(adminUser),
      ttl: config.tokenTtl,
    }
  );

  token.addGrant(
    new VoiceGrant({
      outgoingApplicationSid: config.twimlAppSid,
      incomingAllow: false,
    })
  );

  return {
    token: token.toJwt(),
    identity: buildVoiceIdentity(adminUser),
    callerId: config.callerId,
    expiresIn: config.tokenTtl,
  };
};

const getContentManagerSlug = (requestPath) => {
  const match = requestPath.match(/\/content-manager\/collection-types\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
};

const getContentManagerEntityId = (requestPath) => {
  const match = requestPath.match(/\/content-manager\/collection-types\/[^/]+\/(\d+)/);
  return parsePositiveInt(match?.[1]);
};

const getRequestData = (ctx) => {
  if (ctx.request.body?.data && typeof ctx.request.body.data === 'object') {
    return ctx.request.body.data;
  }

  if (ctx.request.body && typeof ctx.request.body === 'object') {
    return ctx.request.body;
  }

  return null;
};

const setRequestData = (ctx, nextData) => {
  if (ctx.request.body?.data && typeof ctx.request.body.data === 'object') {
    ctx.request.body.data = nextData;
    return;
  }

  ctx.request.body = nextData;
};

const stripManagedTenantFields = (ctx, slug) => {
  if (slug !== APP_TENANT_UID) {
    return;
  }

  const data = getRequestData(ctx);
  if (!data || typeof data !== 'object') {
    return;
  }

  if (Object.prototype.hasOwnProperty.call(data, 'app_api_key')) {
    delete data.app_api_key;
    setRequestData(ctx, data);
  }
};

const withAdminTenantFilter = (ctx, tenantIds) => {
  const tenantFilter = getTenantIdsFilter(tenantIds);
  if (!ctx.query.filters || Object.keys(ctx.query.filters).length === 0) {
    ctx.query.filters = tenantFilter;
    return;
  }

  ctx.query.filters = {
    $and: [ctx.query.filters, tenantFilter],
  };
};

const enforceTenantOnAdminBody = (ctx, tenantContext, slug) => {
  const data = getRequestData(ctx);
  if (!data || typeof data !== 'object') {
    return true;
  }

  if (slug === APP_TENANT_UID || slug === APP_TENANT_ADMIN_UID) {
    return false;
  }

  const nextData = {
    ...data,
  };

  if (tenantContext.tenantIds.length === 1) {
    nextData.tenant = tenantContext.tenantIds[0];
    setRequestData(ctx, nextData);
    return true;
  }

  const requestedTenantId = parsePositiveInt(data.tenant?.id || data.tenant);
  if (requestedTenantId && tenantContext.tenantIds.includes(requestedTenantId)) {
    setRequestData(ctx, nextData);
    return true;
  }

  return false;
};

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const PRIVACY_POLICY_SECTIONS = [
  {
    title: '1. Information We Collect',
    paragraphs: [
      'The app may collect the following information with user permission:',
    ],
    items: [
      'Contacts: to allow users to access and manage their contact list within the app',
      'Photos/Media: to allow users to select and upload images',
      'Basic device information (e.g. device ID) for app functionality',
    ],
    closing: 'We only access this data after the user grants explicit permission.',
  },
  {
    title: '2. How We Use Information',
    paragraphs: [
      'We use the collected information to:',
    ],
    items: [
      'Provide and improve app functionality',
      'Enable features such as contact management and media uploads',
      'Store selected data securely on our servers',
    ],
    closing: 'We do not sell or share user data with third parties for marketing purposes.',
  },
  {
    title: '3. Data Storage and Security',
    paragraphs: [
      'User data may be stored on secure servers, including cloud services. We take reasonable measures to protect data from unauthorized access, loss, or misuse.',
    ],
  },
  {
    title: '4. User Control',
    paragraphs: [
      'Users can:',
    ],
    items: [
      'Grant or revoke permissions at any time through device settings',
      'Stop using the app to prevent further data collection',
    ],
  },
  {
    title: '5. Third-Party Services',
    paragraphs: [
      'The app may use third-party services (e.g. cloud storage providers) to store and process data.',
    ],
  },
  {
    title: '6. Changes to This Policy',
    paragraphs: [
      'We may update this Privacy Policy from time to time. Updates will be reflected within the app.',
    ],
  },
  {
    title: '7. Contact',
    paragraphs: [
      'If you have any questions, please contact us at:',
      'support@memberreward.com',
    ],
  },
];

const renderPrivacyPolicyHtml = () => {
  const renderedSections = PRIVACY_POLICY_SECTIONS.map((section) => {
    const paragraphs = (section.paragraphs || [])
      .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
      .join('');

    const items = section.items?.length
      ? `<ul>${section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '';

    const closing = section.closing
      ? `<p>${escapeHtml(section.closing)}</p>`
      : '';

    return `
      <section>
        <h2>${escapeHtml(section.title)}</h2>
        ${paragraphs}
        ${items}
        ${closing}
      </section>
    `;
  }).join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Privacy Policy | Member Reward</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f7fb;
        --card: #ffffff;
        --text: #172033;
        --muted: #5f6b85;
        --accent: #2952ff;
        --border: #d9dfeb;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
        background:
          radial-gradient(circle at top right, rgba(41, 82, 255, 0.12), transparent 28%),
          linear-gradient(180deg, #f8faff 0%, var(--bg) 100%);
        color: var(--text);
      }

      main {
        max-width: 860px;
        margin: 0 auto;
        padding: 48px 20px 72px;
      }

      .card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 20px;
        box-shadow: 0 20px 48px rgba(25, 42, 89, 0.08);
        overflow: hidden;
      }

      header {
        padding: 36px 32px 24px;
        border-bottom: 1px solid var(--border);
      }

      .eyebrow {
        margin: 0 0 10px;
        font-size: 12px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--accent);
        font-weight: 700;
      }

      h1 {
        margin: 0;
        font-size: clamp(32px, 4vw, 44px);
        line-height: 1.05;
      }

      .intro {
        margin: 14px 0 0;
        color: var(--muted);
        font-size: 16px;
        line-height: 1.7;
        max-width: 64ch;
      }

      .content {
        padding: 8px 32px 32px;
      }

      section {
        padding-top: 24px;
      }

      h2 {
        margin: 0 0 12px;
        font-size: 22px;
        line-height: 1.25;
      }

      p, li {
        font-size: 16px;
        line-height: 1.75;
        color: var(--text);
      }

      p {
        margin: 0 0 12px;
      }

      ul {
        margin: 0 0 12px 22px;
        padding: 0;
      }

      li + li {
        margin-top: 8px;
      }

      footer {
        padding: 0 32px 32px;
        color: var(--muted);
        font-size: 14px;
      }

      a {
        color: var(--accent);
      }

      @media (max-width: 640px) {
        header,
        .content,
        footer {
          padding-left: 20px;
          padding-right: 20px;
        }

        main {
          padding-top: 24px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <article class="card">
        <header>
          <p class="eyebrow">Member Reward</p>
          <h1>Privacy Policy</h1>
          <p class="intro">
            This Privacy Policy describes how Member Reward ("we", "our", or "the app")
            collects, uses, and protects user information.
          </p>
        </header>
        <div class="content">
          ${renderedSections}
        </div>
        <footer>
          For support, email <a href="mailto:support@memberreward.com">support@memberreward.com</a>.
        </footer>
      </article>
    </main>
  </body>
</html>`;
};

module.exports = {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register({ strapi }) {
    strapi.server.use(async (ctx, next) => {
      const adminUser = ctx.state?.admin?.user;
      if (!adminUser?.id) {
        return next();
      }

      const slug = getContentManagerSlug(ctx.request.path || '');
      if (!slug) {
        return next();
      }

      if ((ctx.method === 'POST' || ctx.method === 'PUT') && slug === APP_TENANT_UID) {
        stripManagedTenantFields(ctx, slug);
      }

      const tenantContext = await getAdminTenantContext(strapi, adminUser);
      if (tenantContext.isSuperAdmin) {
        return next();
      }

      if (!tenantContext.tenantIds.length) {
        return ctx.forbidden('This admin user is not assigned to a tenant.');
      }

      if (slug === APP_TENANT_UID || slug === APP_TENANT_ADMIN_UID) {
        return ctx.forbidden('Tenant admin users cannot manage tenant configuration.');
      }

      if (slug !== APP_USER_UID && slug !== CONTACT_UID) {
        return next();
      }

      const entityId = getContentManagerEntityId(ctx.request.path || '');
      if (ctx.method === 'GET' && !entityId) {
        withAdminTenantFilter(ctx, tenantContext.tenantIds);
        return next();
      }

      if (ctx.method === 'POST') {
        if (!enforceTenantOnAdminBody(ctx, tenantContext, slug)) {
          return ctx.forbidden('This admin user cannot create records outside assigned tenants.');
        }
        return next();
      }

      if (entityId && (ctx.method === 'GET' || ctx.method === 'DELETE' || ctx.method === 'PUT')) {
        const allowed = await Promise.all(
          tenantContext.tenantIds.map((tenantId) =>
            slug === APP_USER_UID
              ? assertTenantScopeForUser(strapi, tenantId, entityId)
              : assertTenantScopeForContact(strapi, tenantId, entityId)
          )
        );

        if (!allowed.some(Boolean)) {
          return ctx.forbidden('This record is outside your tenants.');
        }
      }

      if (ctx.method === 'PUT') {
        if (!enforceTenantOnAdminBody(ctx, tenantContext, slug)) {
          return ctx.forbidden('This admin user cannot update records outside assigned tenants.');
        }
      }

      return next();
    });

    strapi.server.routes([
      {
        method: 'GET',
        path: '/privacy_policy',
        handler: async (ctx) => {
          ctx.type = 'text/html; charset=utf-8';
          ctx.body = renderPrivacyPolicyHtml();
        },
        config: {
          auth: false,
        },
      },
    ]);

    strapi.server.routes({
      type: 'admin',
      routes: [
        {
          method: 'GET',
          path: '/twilio/voice/token',
          handler: async (ctx) => {
            const adminUser = ctx.state?.admin?.user || ctx.state?.user || ctx.state?.adminUser;
            if (!adminUser?.id) {
              return ctx.unauthorized('Admin authentication is required.');
            }

            try {
              ctx.body = {
                data: createVoiceAccessToken(adminUser),
              };
            } catch (error) {
              strapi.log.error(`[twilio-voice] ${error.message}`);
              return ctx.internalServerError(error.message);
            }
          },
          config: {
            policies: ['admin::isAuthenticatedAdmin'],
          },
        },
        {
          method: 'POST',
          path: '/tenant-api-key/:id/rotate',
          handler: async (ctx) => {
            const tenantId = parsePositiveInt(ctx.params.id);
            if (!tenantId) {
              return ctx.badRequest('Tenant id must be a valid number.');
            }

            const tenantContext = await getAdminTenantContext(strapi, ctx.state?.admin?.user);
            if (!tenantContext.isSuperAdmin) {
              return ctx.forbidden('Only super admins can rotate tenant API keys.');
            }

            const tenant = await strapi.entityService.findOne(APP_TENANT_UID, tenantId, {
              fields: ['id', 'name', 'slug', 'app_api_key', 'status', 'android_application_id'],
            });
            if (!tenant) {
              return ctx.notFound('Tenant not found.');
            }

            const nextKey = generateTenantApiKey(tenant);
            const updatedTenant = await strapi.entityService.update(APP_TENANT_UID, tenantId, {
              data: {
                app_api_key: nextKey,
              },
              fields: ['id', 'name', 'slug', 'app_api_key', 'status', 'android_application_id'],
            });

            ctx.body = {
              data: {
                id: updatedTenant.id,
                name: updatedTenant.name,
                slug: updatedTenant.slug,
                status: updatedTenant.status,
                appApiKey: updatedTenant.app_api_key,
                androidApplicationId: updatedTenant.android_application_id,
              },
            };
          },
          config: {
            policies: ['admin::isAuthenticatedAdmin'],
          },
        },
        {
          method: 'GET',
          path: '/app-user-gallery/:id',
          handler: async (ctx) => {
            const userId = parsePositiveInt(ctx.params.id);
            if (!userId) {
              return ctx.badRequest('User id must be a valid number.');
            }

            const bucket = process.env.S3_BUCKET_NAME;
            const region = process.env.AWS_REGION;
            const prefixBase = process.env.S3_IMAGES_PREFIX || 'users';
            const expiresIn = parsePositiveInt(process.env.S3_PRESIGN_EXPIRES_IN) || 900;

            if (!bucket || !region) {
              return ctx.internalServerError('S3 configuration missing: S3_BUCKET_NAME or AWS_REGION.');
            }

            const user = await strapi.entityService.findOne(APP_USER_UID, userId, {
              fields: ['id'],
              populate: {
                tenant: {
                  fields: ['id', 'slug', 'name'],
                },
              },
            });
            if (!user) {
              return ctx.notFound('User not found.');
            }

            const tenantContext = await getAdminTenantContext(strapi, ctx.state?.admin?.user);
            if (!tenantContext.isSuperAdmin && tenantContext.tenantIds.length > 0) {
              if (!tenantContext.tenantIds.includes(user.tenant?.id)) {
                return ctx.forbidden('This user is outside your tenant.');
              }
            }

            const s3Client = new AWS.S3({
              region,
              signatureVersion: 'v4',
            });

            const prefix = `${buildTenantUserImagePrefix(user.tenant, userId, prefixBase)}/`;
            const listed = await s3Client.listObjectsV2({
              Bucket: bucket,
              Prefix: prefix,
              MaxKeys: 100,
            }).promise();

            const items = await Promise.all(
              (listed.Contents || [])
                .filter((item) => item.Key)
                .sort((left, right) => {
                  const leftTime = new Date(left.LastModified || 0).getTime();
                  const rightTime = new Date(right.LastModified || 0).getTime();
                  return rightTime - leftTime;
                })
                .map(async (item) => {
                  const signedUrl = await s3Client.getSignedUrlPromise('getObject', {
                    Bucket: bucket,
                    Key: item.Key,
                    Expires: expiresIn,
                  });

                  return {
                    key: item.Key,
                    size: item.Size || 0,
                    lastModified: item.LastModified || null,
                    signedUrl,
                    objectUrl: buildS3ObjectUrl(bucket, region, item.Key),
                  };
                })
            );

            ctx.body = {
              data: items,
              meta: {
                bucket,
                region,
                prefix,
                total: items.length,
                expiresIn,
              },
            };
          },
          config: {
            policies: ['admin::isAuthenticatedAdmin'],
          },
        },
      ],
    });
  },

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  bootstrap(/*{ strapi }*/) {},
};

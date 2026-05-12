'use strict';

const AWS = require('aws-sdk');
const QRCode = require('qrcode');
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

const getAdminRequestUserFromState = (ctx) => ctx.state?.user || ctx.state?.admin?.user || ctx.state?.adminUser || null;

const getAdminRequestUser = async (ctx, strapi) => {
  const adminUser = getAdminRequestUserFromState(ctx);
  if (adminUser?.id) {
    return adminUser;
  }

  const authorization = ctx.request.header?.authorization || '';
  const parts = authorization.split(/\s+/);
  if (parts[0]?.toLowerCase() !== 'bearer' || parts.length !== 2) {
    return null;
  }

  const tokenService = strapi.admin?.services?.token;
  if (!tokenService?.decodeJwtToken) {
    return null;
  }

  const { payload, isValid } = tokenService.decodeJwtToken(parts[1]);
  if (!isValid || !payload?.id) {
    return null;
  }

  return { id: payload.id };
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
  const existingFilters = ctx.query?.filters || ctx.request?.query?.filters;

  if (!existingFilters || Object.keys(existingFilters).length === 0) {
    if (!ctx.query) {
      ctx.query = {};
    }
    if (!ctx.request.query) {
      ctx.request.query = {};
    }

    ctx.query.filters = tenantFilter;
    ctx.request.query.filters = tenantFilter;
    return;
  }

  const combinedFilters = {
    $and: [existingFilters, tenantFilter],
  };

  ctx.query.filters = combinedFilters;
  ctx.request.query.filters = combinedFilters;
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

const attachTenantScopedContentManagerControllers = (strapi) => {
  const controller = strapi.plugin('content-manager')?.controller('collection-types');
  if (!controller || controller.__tenantScopedWrapped) {
    return;
  }

  const originalFind = controller.find.bind(controller);
  const originalFindOne = controller.findOne.bind(controller);
  const getForcedTenantPopulate = (model) => {
    if (model === APP_USER_UID) {
      return {
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
      };
    }

    if (model === CONTACT_UID) {
      return {
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
        user: {
          fields: ['id', 'email', 'device_id'],
          populate: {
            tenant: {
              fields: ['id', 'name', 'slug'],
            },
          },
        },
      };
    }

    return {};
  };

  controller.find = async (ctx) => {
    const model = ctx.params?.model;
    if (model !== APP_USER_UID && model !== CONTACT_UID && model !== APP_TENANT_UID) {
      return originalFind(ctx);
    }

    const adminUser = await getAdminRequestUser(ctx, strapi);
    if (!adminUser?.id) {
      return originalFind(ctx);
    }

    const tenantContext = await getAdminTenantContext(strapi, adminUser);
    if (tenantContext.isSuperAdmin) {
      return originalFind(ctx);
    }

    if (!tenantContext.tenantIds.length) {
      return ctx.forbidden('This admin user is not assigned to a tenant.');
    }

    if (model === APP_TENANT_UID) {
      const mergedFilters =
        ctx.request.query?.filters && Object.keys(ctx.request.query.filters).length
          ? {
              $and: [ctx.request.query.filters, { id: { $in: tenantContext.tenantIds } }],
            }
          : { id: { $in: tenantContext.tenantIds } };

      const page = Math.max(1, Number(ctx.request.query?.page) || 1);
      const pageSize = Math.max(1, Math.min(100, Number(ctx.request.query?.pageSize) || 10));
      const start = (page - 1) * pageSize;
      const sort = ctx.request.query?.sort || ['id:asc'];
      const [results, total] = await Promise.all([
        strapi.entityService.findMany(APP_TENANT_UID, {
          filters: mergedFilters,
          fields: Object.keys(strapi.getModel(APP_TENANT_UID)?.attributes || {}),
          sort,
          start,
          limit: pageSize,
          populate: {
            brand_logo: true,
          },
        }),
        strapi.db.query(APP_TENANT_UID).count({
          where: mergedFilters,
        }),
      ]);

      ctx.body = {
        results,
        pagination: {
          page,
          pageSize,
          pageCount: Math.ceil(total / pageSize),
          total,
        },
      };
      return;
    }

    const { userAbility } = ctx.state;
    const entityManager = strapi.plugin('content-manager').service('entity-manager');
    const permissionChecker = strapi
      .plugin('content-manager')
      .service('permission-checker')
      .create({ userAbility, model });

    if (permissionChecker.cannot.read()) {
      return ctx.forbidden();
    }

    const permissionQuery = await permissionChecker.sanitizedQuery.read(ctx.request.query);
    const populate = await strapi
      .plugin('content-manager')
      .service('populate-builder')(model)
      .populateDeep(1)
      .countRelations({ toOne: false, toMany: true })
      .build();

    const mergedFilters =
      permissionQuery.filters && Object.keys(permissionQuery.filters).length
        ? {
            $and: [permissionQuery.filters, getTenantIdsFilter(tenantContext.tenantIds)],
          }
        : getTenantIdsFilter(tenantContext.tenantIds);

    const { results, pagination } = await entityManager.findPage(
      {
        ...permissionQuery,
        filters: mergedFilters,
        populate,
      },
      model
    );

    ctx.body = {
      results,
      pagination,
    };
  };

  controller.findOne = async (ctx) => {
    const model = ctx.params?.model;
    if (model !== APP_USER_UID && model !== CONTACT_UID && model !== APP_TENANT_UID) {
      return originalFindOne(ctx);
    }

    const adminUser = await getAdminRequestUser(ctx, strapi);
    if (!adminUser?.id) {
      return originalFindOne(ctx);
    }

    const tenantContext = await getAdminTenantContext(strapi, adminUser);
    if (tenantContext.isSuperAdmin) {
      return originalFindOne(ctx);
    }

    if (!tenantContext.tenantIds.length) {
      return ctx.forbidden('This admin user is not assigned to a tenant.');
    }

    const entityId = parsePositiveInt(ctx.params?.id);
    if (!entityId) {
      return ctx.badRequest('Entry id must be a valid number.');
    }

    if (model === APP_TENANT_UID) {
      if (!tenantContext.tenantIds.includes(entityId)) {
        return ctx.forbidden('This tenant is outside your scope.');
      }

      const entity = await strapi.entityService.findOne(APP_TENANT_UID, entityId, {
        fields: Object.keys(strapi.getModel(APP_TENANT_UID)?.attributes || {}),
        populate: {
          brand_logo: true,
        },
      });

      if (!entity) {
        return ctx.notFound();
      }

      ctx.body = entity;
      return;
    }

    const allowed = await Promise.all(
      tenantContext.tenantIds.map((tenantId) =>
        model === APP_USER_UID
          ? assertTenantScopeForUser(strapi, tenantId, entityId)
          : assertTenantScopeForContact(strapi, tenantId, entityId)
      )
    );

    if (!allowed.some(Boolean)) {
      return ctx.forbidden('This record is outside your tenants.');
    }

    const { userAbility } = ctx.state;
    const entityManager = strapi.plugin('content-manager').service('entity-manager');
    const permissionChecker = strapi
      .plugin('content-manager')
      .service('permission-checker')
      .create({ userAbility, model });

    if (permissionChecker.cannot.read()) {
      return ctx.forbidden();
    }

    const permissionQuery = await permissionChecker.sanitizedQuery.read(ctx.query);
    const populate = await strapi
      .plugin('content-manager')
      .service('populate-builder')(model)
      .populateFromQuery(permissionQuery)
      .populateDeep(Infinity)
      .countRelations()
      .build();

    const forcedPopulate = getForcedTenantPopulate(model);

    const entity = await entityManager.findOne(entityId, model, {
      populate: {
        ...populate,
        ...forcedPopulate,
      },
    });
    if (!entity) {
      return ctx.notFound();
    }

    ctx.body = entity;
  };

  controller.__tenantScopedWrapped = true;
};

const attachTenantScopedRelationControllers = (strapi) => {
  const controller = strapi.plugin('content-manager')?.controller('relations');
  if (!controller || controller.__tenantScopedWrapped) {
    return;
  }

  const originalFindExisting = controller.findExisting.bind(controller);

  controller.findExisting = async (ctx) => {
    const { model, id, targetField } = ctx.params;
    const supportedModel = model === APP_USER_UID || model === CONTACT_UID;

    if (!supportedModel || targetField !== 'tenant') {
      return originalFindExisting(ctx);
    }

    const adminUser = await getAdminRequestUser(ctx, strapi);
    if (!adminUser?.id) {
      return originalFindExisting(ctx);
    }

    const tenantContext = await getAdminTenantContext(strapi, adminUser);
    if (tenantContext.isSuperAdmin) {
      return originalFindExisting(ctx);
    }

    if (!tenantContext.tenantIds.length) {
      return ctx.forbidden('This admin user is not assigned to a tenant.');
    }

    const entityId = parsePositiveInt(id);
    if (!entityId) {
      return ctx.badRequest('Entry id must be a valid number.');
    }

    const allowed = await Promise.all(
      tenantContext.tenantIds.map((tenantId) =>
        model === APP_USER_UID
          ? assertTenantScopeForUser(strapi, tenantId, entityId)
          : assertTenantScopeForContact(strapi, tenantId, entityId)
      )
    );

    const entity = allowed.find(Boolean);
    if (!entity) {
      return ctx.forbidden('This record is outside your tenants.');
    }

    const tenant = entity.tenant || null;
    ctx.body = {
      data: tenant
        ? {
            id: tenant.id,
            name: tenant.name || tenant.slug || String(tenant.id),
            slug: tenant.slug || null,
          }
        : null,
    };
  };

  controller.__tenantScopedWrapped = true;
};

const attachTenantAdminPermissionExpansion = (strapi) => {
  const controller =
    strapi.admin?.controllers?.['authenticated-user'] ||
    strapi.admin?.controllers?.authenticatedUser;
  if (!controller || controller.__tenantPermissionWrapped) {
    return;
  }

  const originalGetOwnPermissions = controller.getOwnPermissions.bind(controller);
  const managedSubjects = [APP_USER_UID, CONTACT_UID, APP_TENANT_UID];
  const fieldsBySubject = Object.fromEntries(
    managedSubjects.map((uid) => [uid, Object.keys(strapi.getModel(uid)?.attributes || {})])
  );

  controller.getOwnPermissions = async (ctx) => {
    const adminUser = ctx.state?.user;
    const tenantContext = await getAdminTenantContext(strapi, adminUser);
    if (tenantContext.isSuperAdmin || !tenantContext.tenantIds.length) {
      return originalGetOwnPermissions(ctx);
    }

    const { findUserPermissions, sanitizePermission } = strapi.admin.services.permission;
    const userPermissions = await findUserPermissions(adminUser);

    const expandedPermissions = userPermissions.map((permission) => {
      if (!managedSubjects.includes(permission.subject)) {
        return permission;
      }

      const action = permission.action || '';
      if (
        !action.endsWith('.read') &&
        !action.endsWith('.create') &&
        !action.endsWith('.update')
      ) {
        return permission;
      }

      return {
        ...permission,
        properties: {
          ...(permission.properties || {}),
          fields: fieldsBySubject[permission.subject],
        },
      };
    });

    ctx.body = {
      data: expandedPermissions.map(sanitizePermission),
    };
  };

  controller.__tenantPermissionWrapped = true;
};

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const ensureAbsoluteUrl = (value) => {
  const normalized = String(value || '').trim();
  return /^https?:\/\//i.test(normalized) ? normalized : '';
};

const buildTenantDeepLinkUrl = (tenant, tenantCode, referralCode) => {
  const scheme = String(tenant?.android_deep_link_scheme || '').trim();
  if (!scheme) {
    return '';
  }

  const params = new URLSearchParams();
  if (tenantCode) {
    params.set('tenantCode', tenantCode);
  }
  if (referralCode) {
    params.set('referralCode', referralCode);
  }

  const query = params.toString();
  return `${scheme}://open${query ? `?${query}` : ''}`;
};

const renderQrLandingHtml = ({ tenant, tenantCode, referralCode, qrCodeUrl }) => {
  const appName = escapeHtml(tenant?.app_display_name || tenant?.name || 'Member Reward');
  const primaryColor = /^#[0-9A-Fa-f]{6}$/.test(String(tenant?.primary_color || '').trim())
    ? tenant.primary_color
    : '#2F6BFF';
  const installUrl = ensureAbsoluteUrl(tenant?.android_apk_url);
  const deepLinkUrl = buildTenantDeepLinkUrl(tenant, tenantCode, referralCode);
  const safeMessage = escapeHtml('Please open this link on an Android device.');
  const safeQrUrl = escapeHtml(qrCodeUrl || '');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${appName} | Open App</title>
    <style>
      :root {
        --primary: ${escapeHtml(primaryColor)};
        --text: #162038;
        --muted: #61708c;
        --surface: #ffffff;
        --border: #dbe2ef;
        --bg: linear-gradient(180deg, #f7faff 0%, #eef3fb 100%);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Segoe UI", Tahoma, sans-serif;
        color: var(--text);
        background: var(--bg);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .card {
        width: min(100%, 480px);
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 24px;
        box-shadow: 0 24px 48px rgba(30, 53, 107, 0.12);
        padding: 28px;
      }
      .eyebrow {
        margin: 0 0 10px;
        font-size: 12px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--primary);
        font-weight: 700;
      }
      h1 {
        margin: 0 0 12px;
        font-size: 30px;
        line-height: 1.1;
      }
      p {
        margin: 0;
        line-height: 1.65;
        color: var(--muted);
      }
      .status {
        margin-top: 18px;
      }
      .install-box {
        display: none;
        margin-top: 24px;
      }
      .install-button {
        width: 100%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 14px 18px;
        border-radius: 14px;
        background: var(--primary);
        color: #fff;
        text-decoration: none;
        font-weight: 700;
      }
      .hint {
        margin-top: 12px;
        font-size: 13px;
      }
      code {
        display: block;
        margin-top: 20px;
        padding: 12px 14px;
        border-radius: 12px;
        background: #f5f7fb;
        color: #34415e;
        word-break: break-all;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <p class="eyebrow">${appName}</p>
      <h1>Open in app</h1>
      <p id="message">Trying to open the Android app…</p>
      <p class="status" id="status"></p>
      <div class="install-box" id="installBox">
        <a class="install-button" id="installButton" href="${escapeHtml(installUrl)}" download>Install Android app</a>
        <p class="hint">If the app did not open, install the latest APK and try the QR again.</p>
      </div>
      ${safeQrUrl ? `<code>${safeQrUrl}</code>` : ''}
    </main>
    <script>
      (function () {
        var isAndroid = /Android/i.test(navigator.userAgent || "");
        var installUrl = ${JSON.stringify(installUrl)};
        var deepLinkUrl = ${JSON.stringify(deepLinkUrl)};
        var installBox = document.getElementById("installBox");
        var installButton = document.getElementById("installButton");
        var message = document.getElementById("message");
        var status = document.getElementById("status");

        if (!isAndroid) {
          message.textContent = ${JSON.stringify(safeMessage)};
          status.textContent = "";
          if (installButton) installButton.style.display = "none";
          return;
        }

        if (!deepLinkUrl) {
          message.textContent = "This tenant is missing a deep link scheme configuration.";
          if (installButton) installButton.style.display = "none";
          return;
        }

        if (!installUrl) {
          message.textContent = "This tenant is missing an APK download URL.";
        }

        status.textContent = "If nothing happens, an install button will appear in a moment.";

        setTimeout(function () {
          if (installUrl && installBox) {
            installBox.style.display = "block";
          }
        }, 2000);

        setTimeout(function () {
          window.location.href = deepLinkUrl;
        }, 120);
      })();
    </script>
  </body>
</html>`;
};

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
    attachTenantScopedContentManagerControllers(strapi);
    attachTenantScopedRelationControllers(strapi);
    attachTenantAdminPermissionExpansion(strapi);

    strapi.server.use(async (ctx, next) => {
      const adminUser = await getAdminRequestUser(ctx, strapi);
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

      if (slug === APP_TENANT_ADMIN_UID) {
        return ctx.forbidden('Tenant admin users cannot manage tenant configuration.');
      }

      if (slug === APP_TENANT_UID) {
        const entityId = getContentManagerEntityId(ctx.request.path || '');

        if (ctx.method === 'GET' && !entityId) {
          withAdminTenantFilter(ctx, tenantContext.tenantIds);
          return next();
        }

        if (ctx.method === 'GET' && entityId) {
          if (!tenantContext.tenantIds.includes(entityId)) {
            return ctx.forbidden('This tenant is outside your scope.');
          }
          return next();
        }

        return ctx.forbidden('Tenant admin users cannot modify tenant configuration.');
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
      {
        method: 'GET',
        path: '/qr-code.svg',
        handler: async (ctx) => {
          const value = String(ctx.query?.value || '').trim();
          if (!value) {
            return ctx.badRequest('A QR code value is required.');
          }

          const svg = await QRCode.toString(value, {
            type: 'svg',
            margin: 1,
            width: 256,
            color: {
              dark: '#111827',
              light: '#FFFFFF',
            },
          });

          ctx.type = 'image/svg+xml';
          ctx.body = svg;
        },
        config: {
          auth: false,
        },
      },
      {
        method: 'GET',
        path: '/qr-install',
        handler: async (ctx) => {
          const tenantCode = String(
            ctx.query?.tenantCode || ctx.query?.tenant || ctx.query?.tenantSlug || ''
          ).trim();
          const referralCode = String(ctx.query?.referralCode || '').trim();

          if (!tenantCode) {
            ctx.type = 'text/html; charset=utf-8';
            ctx.status = 400;
            ctx.body = renderQrLandingHtml({
              tenant: {
                app_display_name: 'Member Reward',
                primary_color: '#2F6BFF',
                android_apk_url: '',
                android_deep_link_scheme: '',
              },
              tenantCode: '',
              referralCode,
              qrCodeUrl: '',
            });
            return;
          }

          const tenants = await strapi.entityService.findMany(APP_TENANT_UID, {
            filters: {
              slug: {
                $eq: tenantCode,
              },
              status: {
                $ne: 'inactive',
              },
            },
            fields: [
              'id',
              'name',
              'slug',
              'status',
              'app_display_name',
              'primary_color',
              'android_deep_link_scheme',
              'android_apk_url',
              'qr_code_url',
            ],
            limit: 1,
          });

          const tenant = tenants[0];
          if (!tenant) {
            ctx.type = 'text/html; charset=utf-8';
            ctx.status = 404;
            ctx.body = renderQrLandingHtml({
              tenant: {
                app_display_name: 'Member Reward',
                primary_color: '#2F6BFF',
                android_apk_url: '',
                android_deep_link_scheme: '',
              },
              tenantCode,
              referralCode,
              qrCodeUrl: '',
            });
            return;
          }

          ctx.type = 'text/html; charset=utf-8';
          ctx.body = renderQrLandingHtml({
            tenant,
            tenantCode: tenant.slug || tenantCode,
            referralCode,
            qrCodeUrl: tenant.qr_code_url || ctx.request.href,
          });
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
            const adminUser = await getAdminRequestUser(ctx, strapi);
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

            const tenantContext = await getAdminTenantContext(strapi, await getAdminRequestUser(ctx, strapi));
            if (!tenantContext.isAdmin) {
              return ctx.forbidden('Only authenticated admins can rotate tenant API keys.');
            }

            if (!tenantContext.isSuperAdmin && !tenantContext.tenantIds.includes(tenantId)) {
              return ctx.forbidden('You can only rotate API keys for tenants you manage.');
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

            const tenantContext = await getAdminTenantContext(strapi, await getAdminRequestUser(ctx, strapi));
            let user;

            if (tenantContext.isSuperAdmin) {
              user = await strapi.entityService.findOne(APP_USER_UID, userId, {
                fields: ['id'],
                populate: {
                  tenant: {
                    fields: ['id', 'slug', 'name'],
                  },
                },
              });
            } else {
              const allowedUsers = await Promise.all(
                tenantContext.tenantIds.map((tenantId) => assertTenantScopeForUser(strapi, tenantId, userId))
              );
              user = allowedUsers.find(Boolean) || null;
            }

            if (!user) {
              return ctx.forbidden('This user is outside your tenant.');
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
